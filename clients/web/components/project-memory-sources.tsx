"use client";

import { useEffect, useState, type RefObject } from "react";
import type { AssistantClient, components } from "@ai-assistant/contracts";
import { Modal } from "./modal";

type Source = components["schemas"]["ProjectMemorySources"]["items"][number];

export function ProjectMemorySources({ client, conversationId, messageId, offline, opener, close, describeError }: {
  client: AssistantClient;
  conversationId: string;
  messageId: string;
  offline: boolean;
  opener: RefObject<HTMLElement | null>;
  close: () => void;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [sources, setSources] = useState<Source[]>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setSources(undefined);
    setError("");
    if (offline) return;
    let request: AbortController | undefined;
    async function refresh() {
      if (document.hidden || request) return;
      const current = new AbortController();
      request = current;
      try {
        const result = await client.getMessageProjectMemorySources(conversationId, messageId, current.signal);
        if (!current.signal.aborted) {
          setSources(result.items);
          setError("");
        }
      } catch (failure) {
        if (!current.signal.aborted) {
          setSources(undefined);
          setError(describeError(failure, "暂时无法核对项目记忆来源。"));
        }
      } finally {
        if (request === current) request = undefined;
      }
    }
    function visibilityChanged() {
      if (document.hidden) {
        request?.abort();
        request = undefined;
        setSources(undefined);
        setError("");
      } else void refresh();
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      request?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [attempt, client, conversationId, describeError, messageId, offline]);

  return <Modal label="项目记忆来源" returnFocus={opener} close={close} className="action-dialog resource-dialog">
    <h2>项目记忆来源</h2>
    {offline ? <p role="status">联网后可核对来源。</p>
      : error ? <p className="error-box" role="alert">{error}</p>
        : !sources ? <p role="status">正在核对来源…</p>
          : <ul className="private-record-list">{sources.map((source, index) => <li key={index}>
            {source.status === "available" ? <p className="resource-text">{source.excerpt}</p>
              : <p>此记忆当前不可用。</p>}
          </li>)}</ul>}
    <div className="dialog-actions">
      {!offline && <button type="button" className="button secondary" disabled={!sources && !error}
        onClick={() => setAttempt((previous) => previous + 1)}>重新核对</button>}
      <button type="button" className="button secondary" onClick={close}>关闭</button>
    </div>
  </Modal>;
}
