"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AssistantApiError, type AssistantClient } from "@ai-assistant/contracts";
import { applyRunEvent, idempotencyKey, isActive, type RunRequest, type RunSnapshot } from "./assistant";

type TrackedRun = {
  snapshot: RunSnapshot;
  input: RunRequest;
};

function waitForRetry(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delay);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function useRun(client: AssistantClient, onSessionExpired: () => void) {
  const [run, setRun] = useState<TrackedRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [streamError, setStreamError] = useState(false);
  const current = useRef<TrackedRun | null>(null);
  const follower = useRef<AbortController | null>(null);
  const attempt = useRef<{ conversationId: string; description: string; key: string } | null>(null);
  const pendingStart = useRef<{ conversationId: string; discarded: boolean } | null>(null);
  const mutation = useRef(false);
  const alive = useRef(true);

  const publish = useCallback((snapshot: RunSnapshot) => {
    const tracked = current.current;
    if (!tracked || tracked.snapshot.runId !== snapshot.runId ||
        tracked.snapshot.lastSequence > snapshot.lastSequence ||
        (!isActive(tracked.snapshot) && isActive(snapshot))) return;
    current.current = { ...tracked, snapshot };
    if (alive.current) setRun(current.current);
  }, []);

  const follow = useCallback((runId: string, resync = false) => {
    follower.current?.abort();
    const connection = new AbortController();
    follower.current = connection;
    const { signal } = connection;
    setStreamError(false);
    setReconnecting(resync);

    async function listen() {
      let retryDelay = 250;
      let needSnapshot = resync;
      while (!signal.aborted && current.current?.snapshot.runId === runId &&
          isActive(current.current.snapshot)) {
        try {
          if (needSnapshot) {
            const snapshot = await client.getRunSnapshot(runId);
            if (signal.aborted) return;
            publish(snapshot);
            if (!isActive(current.current.snapshot)) break;
          }
          const afterSequence = current.current.snapshot.lastSequence;
          for await (const event of client.openRunEvents(runId, { afterSequence, signal })) {
            if (signal.aborted) return;
            const latest = current.current?.snapshot;
            if (!latest || latest.runId !== runId) return;
            if (event.sequence > latest.lastSequence + 1) break;
            setStreamError(false);
            setReconnecting(false);
            retryDelay = 250;
            const next = applyRunEvent(latest, event);
            publish(next);
            if (!isActive(next)) break;
          }
        } catch (error) {
          if (signal.aborted) return;
          if (error instanceof AssistantApiError) {
            if (error.status === 401) { onSessionExpired(); return; }
            if (error.status === 403 || error.status === 404 || error.status === 423) {
              const snapshot = current.current?.snapshot;
              if (snapshot?.runId === runId && isActive(snapshot)) {
                publish({ ...snapshot, state: "failed", content: "", error: {
                  code: error.status === 423 ? "CONVERSATION_LOCKED" : error.status === 403 ? "FORBIDDEN" : "NOT_FOUND",
                  message: "无法访问本次生成。",
                } });
              }
              break;
            }
          }
        }
        if (signal.aborted || !isActive(current.current?.snapshot ?? null)) break;
        needSnapshot = true;
        setReconnecting(true);
        if (retryDelay >= 2_000) setStreamError(true);
        await waitForRetry(retryDelay, signal);
        retryDelay = Math.min(retryDelay * 2, 5_000);
      }
      if (!signal.aborted) {
        setReconnecting(false);
        setStreamError(false);
      }
    }

    void listen();
  }, [client, onSessionExpired, publish]);

  useEffect(() => {
    alive.current = true;
    function resume() {
      const active = current.current?.snapshot;
      if (active && isActive(active) && document.visibilityState === "visible") {
        follow(active.runId, true);
      }
    }
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      alive.current = false;
      follower.current?.abort();
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [follow]);

  async function start(conversationId: string, input: RunRequest) {
    if (mutation.current || isActive(current.current?.snapshot ?? null)) return false;
    mutation.current = true;
    const pending = { conversationId, discarded: false };
    pendingStart.current = pending;
    setStarting(true);
    const description = JSON.stringify([conversationId, input]);
    try {
      if (attempt.current?.description !== description) {
        attempt.current = { conversationId, description, key: idempotencyKey() };
      }
      const snapshot = await client.startRun(conversationId, input, attempt.current.key);
      if (!alive.current || pending.discarded) return false;
      attempt.current = null;
      current.current = { snapshot, input };
      setRun(current.current);
      setStreamError(false);
      if (isActive(snapshot)) follow(snapshot.runId);
      return true;
    } catch (error) {
      if (error instanceof AssistantApiError && error.status < 500) attempt.current = null;
      throw error;
    } finally {
      if (pendingStart.current === pending) pendingStart.current = null;
      mutation.current = false;
      if (alive.current) setStarting(false);
    }
  }

  async function stop() {
    const snapshot = current.current?.snapshot;
    if (mutation.current || !snapshot || !isActive(snapshot)) return;
    mutation.current = true;
    setStopping(true);
    try {
      const settled = await client.cancelRun(snapshot.runId);
      if (!alive.current) return;
      publish(settled);
      if (!isActive(current.current?.snapshot ?? null)) {
        follower.current?.abort();
        setStreamError(false);
        setReconnecting(false);
      }
    } finally {
      mutation.current = false;
      if (alive.current) setStopping(false);
    }
  }

  function resume() {
    const snapshot = current.current?.snapshot;
    if (snapshot && isActive(snapshot)) follow(snapshot.runId, true);
  }

  const discardConversation = useCallback((conversationId: string) => {
    if (attempt.current?.conversationId === conversationId) attempt.current = null;
    if (pendingStart.current?.conversationId === conversationId) pendingStart.current.discarded = true;
    if (current.current?.snapshot.conversationId !== conversationId) return;
    follower.current?.abort();
    current.current = null;
    setRun(null);
    setStreamError(false);
    setReconnecting(false);
  }, []);

  return { run, starting, stopping, reconnecting, streamError, start, stop, resume, discardConversation };
}
