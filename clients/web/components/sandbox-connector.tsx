"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { AssistantApiError, type AssistantClient, type components } from "@ai-assistant/contracts";
import { idempotencyKey } from "@/lib/assistant";
import { Modal } from "./modal";

type Schemas = components["schemas"];
type Authorization = Schemas["SandboxConnectorAuthorization"];
type Action = Schemas["SandboxConnectorAction"];
type Review = { kind: "connect" } | { kind: "revoke"; authorizationId: string } | { kind: "approve"; action: Action };

const states = {
  awaiting_approval: "等待审批",
  approved: "已批准，等待执行",
  pending_result: "待核实",
  completed: "已核实",
  blocked: "授权已失效",
  cancelled: "已取消",
} satisfies Record<Action["state"], string>;
const time = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });

export function SandboxConnector({ client, offline, opener, close, describeError }: {
  client: AssistantClient;
  offline: boolean;
  opener: RefObject<HTMLElement | null>;
  close: () => void;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [authorization, setAuthorization] = useState<Authorization>();
  const [actions, setActions] = useState<Action[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [review, setReview] = useState<Review>();
  const [missingAck, setMissingAck] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const request = useRef<AbortController>(null);
  const createAttempt = useRef<{ key: string; scope: string; simulation: Action["simulation"] }>(null);
  const dispatching = actions.some(({ state }) => state === "approved");

  const load = useCallback(async (signal: AbortSignal) => {
    const [grant, page] = await Promise.all([
      client.getSandboxConnectorAuthorization(signal), client.listSandboxConnectorActions({ limit: 25 }, signal),
    ]);
    if (!signal.aborted) {
      setAuthorization(grant);
      setActions(page.items);
      setNextCursor(page.nextCursor);
    }
  }, [client]);

  const run = useCallback(async (operation: (signal: AbortSignal) => Promise<void>, fallback: string) => {
    if (offline || request.current) return;
    const current = new AbortController();
    request.current = current;
    setBusy(true);
    setError("");
    try { await operation(current.signal); }
    catch (failure) {
      if (!current.signal.aborted) {
        if (failure instanceof AssistantApiError && [401, 403, 404].includes(failure.status)) {
          setAuthorization(undefined);
          setActions([]);
          setReview(undefined);
        }
        setError(describeError(failure, fallback));
      }
    } finally {
      if (request.current === current) {
        request.current = null;
        setBusy(false);
      }
    }
  }, [describeError, offline]);

  useEffect(() => {
    if (offline) {
      setAuthorization(undefined);
      setActions([]);
      setReview(undefined);
      setBusy(false);
      return;
    }
    void run(load, "暂时无法读取连接器状态。");
    return () => {
      const current = request.current;
      request.current = null;
      current?.abort();
    };
  }, [load, offline, run]);

  useEffect(() => {
    if (!dispatching || offline) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void run(load, "暂时无法核对执行状态。");
    }, 1500);
    return () => window.clearInterval(timer);
  }, [dispatching, load, offline, run]);

  function confirm() {
    if (!review) return;
    void run(async (signal) => {
      if (review.kind === "connect") await client.authorizeSandboxConnector(signal);
      else if (review.kind === "revoke") {
        await client.revokeSandboxConnectorAuthorization(review.authorizationId, signal);
      } else if (review.kind === "approve") {
        await client.approveSandboxConnectorAction(review.action.id, review.action.approvalRevision, signal);
      }
      if (!signal.aborted) setReview(undefined);
      await load(signal);
    }, "暂时无法更新连接器，请刷新并核对当前授权。");
  }

  function prepare() {
    if (authorization?.state !== "authorized") return;
    const scope = authorization.authorizationId;
    const simulation = missingAck ? "ack_lost" : "acknowledged";
    const saved = createAttempt.current;
    const key = saved?.scope === scope && saved.simulation === simulation ? saved.key : idempotencyKey();
    createAttempt.current = { key, scope, simulation };
    void run(async (signal) => {
      await client.createSandboxConnectorAction({ authorizationId: scope, simulation, kind: "fixture_notice" }, key, signal);
      createAttempt.current = null;
      await load(signal);
    }, "暂时无法创建审批请求。");
  }

  const locked = offline || busy;
  return <Modal label="连接器沙箱" returnFocus={opener} close={close} className="action-dialog resource-dialog">
    <h2>连接器沙箱</h2>
    <p>在当前工作空间测试审批、撤销和回执核实。每次执行只向本机合成账本写入一条通知记录。</p>
    {offline && <p role="status">联网后可核对当前授权。</p>}
    {error && <p className="error-box" role="alert">{error}</p>}
    {authorization && <section className="account-data-section" aria-label="连接授权">
      <h3>连接授权</h3>
      {authorization.state === "authorized" ? <>
        <p>当前连接已授权。</p>
        <button type="button" className="button secondary" disabled={locked || !!review}
          onClick={() => setReview({ kind: "revoke", authorizationId: authorization.authorizationId })}>撤销连接授权</button>
      </> : <button type="button" className="button secondary" disabled={locked || !!review}
        onClick={() => setReview({ kind: "connect" })}>连接本机沙箱</button>}
    </section>}
    {authorization?.state === "authorized" && <section className="account-data-section" aria-label="新增操作">
      <h3>记录一条合成通知</h3>
      <label className="dialog-field"><input type="checkbox" checked={missingAck} disabled={locked || !!review}
        onChange={(event) => setMissingAck(event.target.checked)} /> 模拟首次执行回执丢失</label>
      <button type="button" className="button primary" disabled={locked || !!review} onClick={prepare}>创建审批请求</button>
    </section>}
    {review && <section className="account-data-section" aria-label="确认操作">
      <h3>{review.kind === "connect" ? "授予本机沙箱权限" : review.kind === "revoke"
        ? "撤销连接授权" : "确认记录这一条合成通知"}</h3>
      <p>{review.kind === "connect" ? "此工作空间可以创建需单独确认的通知请求。"
        : review.kind === "revoke" ? "等待发送的旧审批会失效，已发出的记录仍可核实。"
          : review.action.simulation === "ack_lost" ? "此次测试将模拟首次回执丢失。" : "此次测试将等待首次执行回执。"}</p>
      <div className="dialog-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={() => setReview(undefined)}>返回</button>
        <button type="button" className="button primary" disabled={locked} onClick={confirm}>
          {review.kind === "connect" ? "确认连接" : review.kind === "revoke" ? "确认撤销授权" : "批准并执行"}
        </button>
      </div>
    </section>}
    {!!actions.length && <section className="account-data-section" aria-label="操作记录">
      <h3>操作记录</h3>
      <ul className="private-record-list">{actions.map((action) => <li key={action.id} aria-label={`通知操作 ${action.id.slice(0, 8)}`}>
        <p>合成通知 · {time.format(new Date(action.createdAt))}</p>
        <p>{states[action.state]}</p>
        {action.result && <p>账本记录时间 {time.format(new Date(action.result.recordedAt))}</p>}
        {action.state === "pending_result" && <p>可查询账本确认结果。</p>}
        <div className="dialog-actions">
          {action.state === "awaiting_approval" && <button type="button" className="button secondary"
            disabled={locked || !!review} onClick={() => setReview({ kind: "approve", action })}>审核这项请求</button>}
          {(action.state === "awaiting_approval" || action.state === "approved") && <button type="button"
            className="button secondary" disabled={locked || !!review} onClick={() => void run(async (signal) => {
              await client.cancelSandboxConnectorAction(action.id, signal);
              await load(signal);
            }, "操作状态可能已变化。请刷新后核对。")}>取消请求</button>}
          {action.state === "pending_result" && <button type="button" className="button secondary"
            disabled={locked || !!review} onClick={() => void run(async (signal) => {
              await client.reconcileSandboxConnectorAction(action.id, signal);
              await load(signal);
            }, "暂时无法核实，请稍后查询。")}>核实账本结果</button>}
        </div>
      </li>)}</ul>
      {nextCursor && <button type="button" className="button secondary" disabled={locked || !!review}
        onClick={() => void run(async (signal) => {
          const page = await client.listSandboxConnectorActions({ limit: 25, cursor: nextCursor }, signal);
          if (!signal.aborted) {
            setActions((prior) => [...prior, ...page.items.filter(({ id }) => !prior.some((item) => item.id === id))]);
            setNextCursor(page.nextCursor);
          }
        }, "暂时无法读取更多操作。")}>查看更多操作</button>}
    </section>}
    <div className="dialog-actions">
      <button type="button" className="button secondary" disabled={locked} onClick={() => void run(load, "暂时无法刷新。")}>刷新记录</button>
      <button type="button" className="button secondary" onClick={close}>关闭</button>
    </div>
  </Modal>;
}
