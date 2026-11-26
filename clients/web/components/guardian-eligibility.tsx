"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { AssistantApiError, type AssistantClient, type components } from "@ai-assistant/contracts";
import { Modal } from "./modal";

type Eligibility = components["schemas"]["PilotEligibility"];
type Consent = components["schemas"]["GuardianConsent"];
const statusText: Record<Eligibility["connectorStatus"], string> = {
  allowed: "已满足试点连接器资格",
  guardian_required: "需要当前监护授权",
  consent_expired: "监护授权已过期",
  outside_fixture_region: "当前账号不在试点范围内",
  not_enrolled: "当前账号尚未登记试点资格",
};
const formatTime = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });

export function GuardianEligibility({ client, offline, opener, close, describeError, onRefresh }: {
  client: AssistantClient;
  offline: boolean;
  opener: RefObject<HTMLElement | null>;
  close: () => void;
  describeError: (error: unknown, fallback: string) => string;
  onRefresh: () => void;
}) {
  const [eligibility, setEligibility] = useState<Eligibility>();
  const [consents, setConsents] = useState<Consent[]>([]);
  const [review, setReview] = useState<{ consent: Consent; authorize: boolean }>();
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const pending = useRef<AbortController>(null);

  const load = useCallback(async (signal: AbortSignal) => {
    const [current, bindings] = await Promise.all([client.getEligibility(signal), client.listGuardianConsents(signal)]);
    if (!signal.aborted) {
      setEligibility(current);
      setConsents(bindings.items);
    }
  }, [client]);

  const run = useCallback(async (action: (signal: AbortSignal) => Promise<void>) => {
    if (offline || pending.current || document.hidden) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError("");
    setNotice("");
    try { await action(request.signal); }
    catch (failure) {
      if (!request.signal.aborted) {
        setEligibility(undefined);
        setConsents([]);
        setReview(undefined);
        setError(failure instanceof AssistantApiError && failure.status === 409
          ? "授权状态已变化，请刷新后重新确认。" : describeError(failure, "暂时无法核对资格和授权。"));
      }
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
      }
    }
  }, [describeError, offline]);

  useEffect(() => {
    function clear() {
      pending.current?.abort();
      pending.current = null;
      setEligibility(undefined);
      setConsents([]);
      setReview(undefined);
      setBusy(false);
    }
    if (offline) { clear(); return; }
    function visibilityChanged() {
      if (document.hidden) clear();
      else void run(load);
    }
    void run(load);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      pending.current?.abort();
      pending.current = null;
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [load, offline, run]);

  const locked = offline || busy;
  return <Modal label="使用资格与监护" returnFocus={opener} close={close} className="action-dialog resource-dialog">
    <h2>使用资格与监护</h2>
    {offline && <p role="status">联网后可查阅当前连接器资格。</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p className="error-box" role="alert">{error}</p>}
    {eligibility?.applicable && <section className="account-data-section" aria-label="连接器使用资格">
      <h3>连接器使用资格</h3>
      <p>{statusText[eligibility.connectorStatus]}</p>
    </section>}
    {!!consents.length && <section className="account-data-section" aria-label="监护授权记录">
      <h3>监护授权记录</h3>
      <ul className="private-record-list">{consents.map((consent) => <li key={consent.id}>
        <p>绑定 {consent.id.slice(0, 8)} · {statusText[consent.status]}</p>
        {consent.expiresAt && <p>有效期至 {formatTime.format(new Date(consent.expiresAt))}</p>}
        {consent.status !== "outside_fixture_region" && <button className="button secondary" type="button"
          disabled={locked || !!review} onClick={() => setReview({ consent, authorize: consent.status !== "allowed" })}>
          {consent.status === "allowed" ? "撤回连接器授权" : "审核连接器授权"}
        </button>}
      </li>)}</ul>
    </section>}
    {review && <section className="account-data-section" aria-label="核对监护授权">
      <p>{review.authorize ? "此绑定将获得有期限的本地连接器资格。每项操作仍需单独审批。"
        : "撤回后，此绑定需要重新获得资格，旧连接器审批将失效。"}</p>
      <div className="dialog-actions">
        <button className="button secondary" type="button" disabled={locked} onClick={() => setReview(undefined)}>取消</button>
        <button className="button primary" type="button" disabled={locked} onClick={() => void run(async (signal) => {
          await client.updateGuardianConsent(review.consent.id, { revision: review.consent.revision,
            authorize: review.authorize, confirm: true }, signal);
          if (signal.aborted) return;
          setReview(undefined);
          await load(signal);
          if (!signal.aborted) {
            setNotice(review.authorize ? "已授权此绑定。" : "已撤回授权。");
            onRefresh();
          }
        })}>{review.authorize ? "确认监护授权" : "确认撤回授权"}</button>
      </div>
    </section>}
    <div className="dialog-actions">
      <button className="button secondary" type="button" disabled={locked || !!review}
        onClick={() => void run(async (signal) => { await load(signal); if (!signal.aborted) onRefresh(); })}>刷新资格和授权</button>
      <button className="button secondary" type="button" onClick={close}>关闭</button>
    </div>
  </Modal>;
}
