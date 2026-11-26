"use client";

import { Building2, Check } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { AssistantApiError, type AssistantClient, type components } from "@ai-assistant/contracts";
import { errorText } from "@/lib/assistant";
import { Modal } from "./modal";

type Membership = components["schemas"]["WorkspaceSummary"];
type Departure = components["schemas"]["WorkspaceDeparturePreview"];

export function WorkspaceSwitch({ client, selectedId, offline = false, onSwitch, onReturnPersonal, onExpire }: {
  client: AssistantClient;
  selectedId: string;
  offline?: boolean;
  onSwitch: (workspaceId: string) => Promise<void>;
  onReturnPersonal?: () => Promise<void>;
  onExpire: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={trigger} className="button" type="button" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <Building2 size={17} aria-hidden="true" /> 切换工作空间
    </button>
    {open && <WorkspaceOptions client={client} selectedId={selectedId} offline={offline}
      onSwitch={onSwitch} onReturnPersonal={onReturnPersonal} onExpire={onExpire} close={() => setOpen(false)} returnFocus={trigger} />}
  </>;
}

function WorkspaceOptions({ client, selectedId, offline, onSwitch, onReturnPersonal, onExpire, close, returnFocus }: {
  client: AssistantClient;
  selectedId: string;
  offline: boolean;
  onSwitch: (workspaceId: string) => Promise<void>;
  onReturnPersonal?: () => Promise<void>;
  onExpire: () => void;
  close: () => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  const [items, setItems] = useState<Membership[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string>();
  const [failure, setFailure] = useState("");
  const [departure, setDeparture] = useState<Departure>();
  const [leaving, setLeaving] = useState(false);
  const [notice, setNotice] = useState("");
  const lock = useRef(false);
  const active = useRef(false);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  useEffect(() => {
    if (offline) return;
    let current = true;
    setLoading(true);
    setFailure("");
    client.listWorkspaces().then((page) => {
      if (!current) return;
      setItems(page.items);
      setCursor(page.nextCursor);
    }).catch((error: unknown) => {
      if (!current) return;
      if (error instanceof AssistantApiError && error.status === 401) onExpire();
      else setFailure(errorText(error, "暂时无法读取可用的工作空间。"));
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [client, offline, onExpire, revision]);

  async function more() {
    if (!cursor || lock.current || offline) return;
    lock.current = true;
    setLoading(true);
    setFailure("");
    try {
      const page = await client.listWorkspaces({ cursor });
      if (!active.current) return;
      setItems((previous) => [...previous, ...page.items.filter((entry) => !previous.some(({ id }) => id === entry.id))]);
      setCursor(page.nextCursor);
    } catch (error) {
      if (!active.current) return;
      if (error instanceof AssistantApiError && error.status === 401) onExpire();
      else setFailure(errorText(error, "暂时无法读取更多工作空间。"));
    } finally {
      lock.current = false;
      if (active.current) setLoading(false);
    }
  }

  async function choose(membership: Membership) {
    if (lock.current || offline || membership.id === selectedId) return;
    lock.current = true;
    setPending(membership.id);
    setFailure("");
    try {
      await onSwitch(membership.id);
      if (active.current) close();
    } catch (error) {
      if (!active.current) return;
      if (error instanceof AssistantApiError && error.status === 401) onExpire();
      else setFailure(errorText(error, "切换工作空间失败，请重试。"));
    } finally {
      lock.current = false;
      if (active.current) setPending(undefined);
    }
  }

  async function prepareDeparture(membership: Membership) {
    if (lock.current || offline || membership.kind !== "workspace") return;
    lock.current = true;
    setLeaving(true);
    setFailure("");
    setNotice("");
    try {
      const review = await client.previewWorkspaceDeparture(membership.id);
      if (active.current && review.workspaceId === membership.id) setDeparture(review);
    } catch (error) {
      if (!active.current) return;
      if (error instanceof AssistantApiError && error.status === 401) onExpire();
      else setFailure(errorText(error, "暂时无法确认退出资格，请刷新列表。"));
    } finally {
      lock.current = false;
      if (active.current) setLeaving(false);
    }
  }

  async function confirmDeparture() {
    if (!departure || !onReturnPersonal || lock.current || offline) return;
    lock.current = true;
    setLeaving(true);
    setFailure("");
    try {
      await client.leaveWorkspace(departure.workspaceId, { membershipRevision: departure.membershipRevision, confirm: true });
      if (!active.current) return;
      if (departure.workspaceId === selectedId) {
        try { await onReturnPersonal(); } catch { onExpire(); }
        return;
      }
      setItems((current) => current.filter(({ id }) => id !== departure.workspaceId));
      setDeparture(undefined);
      setNotice("已退出工作空间。");
    } catch (error) {
      if (!active.current) return;
      if (error instanceof AssistantApiError && error.status === 401) onExpire();
      else if (error instanceof AssistantApiError && (error.status === 404 || error.status === 409)) {
        setDeparture(undefined);
        setFailure("成员资格已变化，请刷新并重新确认。");
      } else setFailure(errorText(error, "退出结果未确认，可以重试同一次确认。"));
    } finally {
      lock.current = false;
      if (active.current) setLeaving(false);
    }
  }

  const locked = !!pending || loading || leaving || offline;
  return <Modal label="切换工作空间" className="action-dialog" close={() => { if (!leaving) close(); }} returnFocus={returnFocus}>
    <h2>切换工作空间</h2>
    {offline && <p role="status">连接网络后可切换工作空间。</p>}
    {loading && !offline && <p role="status">正在读取工作空间…</p>}
    {failure && <p role="alert" className="error-box">{failure}</p>}
    {notice && <p role="status">{notice}</p>}
    <ul className="workspace-options">
      {items.map((membership) => {
        const selected = membership.id === selectedId;
        const label = membership.kind === "personal" ? "个人空间" : `工作空间 ${membership.id.slice(0, 8)}`;
        return <li key={membership.id}>
          <button type="button" className="button conversation" aria-current={selected ? "true" : undefined}
            disabled={selected || locked || !!departure} onClick={() => void choose(membership)}>
            {label}{selected && <><Check size={17} aria-hidden="true" /><span className="visually-hidden">，当前</span></>}
            {pending === membership.id && <span role="status">正在切换…</span>}
          </button>
          {onReturnPersonal && membership.kind === "workspace" && membership.canLeave !== false
            && <button type="button" className="button secondary"
            aria-label={`退出 ${label}`} disabled={locked || !!departure} onClick={() => void prepareDeparture(membership)}>退出</button>}
        </li>;
      })}
    </ul>
    {departure && <section className="account-data-section" aria-label="确认退出工作空间">
      <h3>退出工作空间 {departure.workspaceId.slice(0, 8)}？</h3>
      <p>退出将结束此空间的成员资格。该空间的项目角色和分享链接将失效，进行中的操作会停止。</p>
      <div className="dialog-actions">
        <button className="button secondary" type="button" disabled={leaving} onClick={() => setDeparture(undefined)}>取消退出</button>
        <button className="button danger" type="button" disabled={locked} onClick={() => void confirmDeparture()}>确认退出工作空间</button>
      </div>
    </section>}
    <div className="dialog-actions">
      {failure && <button className="button" type="button" disabled={locked || !!departure}
        onClick={() => setRevision((value) => value + 1)}>刷新列表</button>}
      {cursor && <button className="button" type="button" disabled={locked || !!departure}
        onClick={() => void more()}>加载更多</button>}
      <button className="button secondary" type="button" disabled={leaving} onClick={close}>关闭</button>
    </div>
  </Modal>;
}
