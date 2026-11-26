"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import type { AssistantClient, components } from "@ai-assistant/contracts";
import { Modal } from "./modal";
import { OrganizationDirectory } from "./organization-directory";
import { OrganizationModelBudget } from "./organization-model-budget";
import { OrganizationPolicy } from "./organization-policy";
import { OrganizationSsoLink } from "./organization-sso-link";
import { OrganizationUsage } from "./organization-usage";

type Schemas = components["schemas"];
type Member = Schemas["OrganizationMember"];
type AssignableRole = Schemas["OrganizationAssignableRole"];
type Review = { kind: "add"; accountId: string; role: AssignableRole }
  | { kind: "role"; member: Member; role: AssignableRole }
  | { kind: "revoke"; member: Member };

const roles: Record<Schemas["OrganizationRole"], string> = { owner: "所有者", admin: "管理员", member: "成员" };
const auditLabels: Record<string, string> = { provisioned: "创建组织", member_added: "加入成员",
  role_changed: "变更角色", member_revoked: "撤回成员权限", policy_changed: "变更组织策略",
  model_budget_changed: "变更模型用量上限", directory_deactivated: "目录停用成员" };
const date = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function OrganizationPanel({ client, offline, opener, close, describeError, policiesAvailable, usageAvailable,
  modelBudgetAvailable, directoryAvailable, onPolicySaved }: {
  client: AssistantClient;
  offline: boolean;
  opener: RefObject<HTMLElement | null>;
  close: () => void;
  describeError: (error: unknown, fallback: string) => string;
  policiesAvailable: boolean;
  usageAvailable: boolean;
  modelBudgetAvailable: boolean;
  directoryAvailable: boolean;
  onPolicySaved: () => void;
}) {
  const [organization, setOrganization] = useState<Schemas["Organization"]>();
  const [members, setMembers] = useState<Schemas["OrganizationMemberPage"]>();
  const [audit, setAudit] = useState<Schemas["OrganizationAuditPage"]>();
  const [accountId, setAccountId] = useState("");
  const [newRole, setNewRole] = useState<AssignableRole>("member");
  const [review, setReview] = useState<Review>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const pending = useRef<AbortController>(null);

  const load = useCallback(async (signal: AbortSignal) => {
    const summary = await client.getCurrentOrganization(signal);
    if (signal.aborted) return;
    setOrganization(summary);
    if (summary.role === "member") {
      setMembers(undefined);
      setAudit(undefined);
      setReview(undefined);
      return;
    }
    const [roster, changes] = await Promise.all([
      client.listOrganizationMembers({ limit: 25 }, signal), client.listOrganizationAudit({ limit: 25 }, signal),
    ]);
    if (!signal.aborted) {
      setMembers(roster);
      setAudit(changes);
    }
  }, [client]);

  const run = useCallback(async (operation: (signal: AbortSignal) => Promise<void>) => {
    if (offline || pending.current || document.hidden) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError("");
    try { await operation(request.signal); }
    catch (failure) {
      if (!request.signal.aborted) {
        setOrganization(undefined);
        setMembers(undefined);
        setAudit(undefined);
        setReview(undefined);
        setError(describeError(failure, "无法读取组织权限。请刷新后重新核对。"));
      }
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
      }
    }
  }, [describeError, offline]);

  useEffect(() => {
    if (offline) {
      setOrganization(undefined);
      setMembers(undefined);
      setAudit(undefined);
      setReview(undefined);
      setBusy(false);
      return;
    }
    function visibilityChanged() {
      if (document.hidden) {
        pending.current?.abort();
        pending.current = null;
        setMembers(undefined);
        setAudit(undefined);
        setReview(undefined);
      } else void run(load);
    }
    void run(load);
    const timer = window.setInterval(() => void run(load), 12_000);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      pending.current?.abort();
      pending.current = null;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [load, offline, run]);

  function add(event: FormEvent) {
    event.preventDefault();
    const id = accountId.trim();
    if (!uuid.test(id)) { setError("请输入完整的账号标识。"); return; }
    setReview({ kind: "add", accountId: id, role: organization?.role === "owner" ? newRole : "member" });
  }

  function confirm() {
    if (!review) return;
    void run(async (signal) => {
      if (review.kind === "add") {
        await client.addOrganizationMember({ accountId: review.accountId, role: review.role, confirm: true }, signal);
        setAccountId("");
      } else if (review.kind === "role") {
        await client.changeOrganizationMemberRole(review.member.accountId, {
          role: review.role, membershipRevision: review.member.membershipRevision,
          authorityRevision: review.member.authorityRevision, confirm: true,
        }, signal);
      } else {
        await client.revokeOrganizationMember(review.member.accountId, {
          membershipRevision: review.member.membershipRevision, confirm: true,
        }, signal);
      }
      if (!signal.aborted) setReview(undefined);
      await load(signal);
    });
  }

  const locked = busy || offline;
  const canManage = organization && organization.role !== "member";
  return <Modal label="组织与座席" returnFocus={opener} close={close} className="action-dialog resource-dialog">
    <h2>组织与座席</h2>
    {offline && <p role="status">联网后可核对组织权限。</p>}
    {error && <p role="alert" className="error-box">{error}</p>}
    {organization && <section className="account-data-section" aria-label="组织摘要">
      <h3>{organization.name}</h3>
      <p>你的角色 {roles[organization.role]} · 座席已使用 {organization.seatsUsed}/{organization.seatLimit}</p>
    </section>}
    {organization?.role === "owner" && policiesAvailable && !offline && <OrganizationPolicy client={client}
      disabled={locked} describeError={describeError} onSaved={() => { onPolicySaved(); void run(load); }} />}
    {organization?.role === "owner" && modelBudgetAvailable && !offline && <OrganizationModelBudget client={client}
      disabled={locked} describeError={describeError} onSaved={() => { onPolicySaved(); void run(load); }} />}
    {organization?.role === "owner" && directoryAvailable && members && !offline && <OrganizationDirectory client={client}
      members={members.items} disabled={locked} describeError={describeError} onSaved={() => void run(load)} />}
    {organization?.role === "member" && !offline && <OrganizationSsoLink client={client} />}
    {canManage && usageAvailable && !offline && <OrganizationUsage client={client} disabled={locked} describeError={describeError} />}
    {canManage && members && <section className="account-data-section" aria-label="组织成员">
      <h3>成员</h3>
      <ul className="private-record-list">{members.items.map((member) => <li key={member.accountId}>
        <h4>{member.username}</h4>
        <p>{roles[member.role]}</p>
        {member.role !== "owner" && (organization.role === "owner" || member.role === "member") && <div className="dialog-actions">
          {organization.role === "owner" && <button className="button secondary" type="button" disabled={locked || !!review}
            onClick={() => setReview({ kind: "role", member, role: member.role === "admin" ? "member" : "admin" })}>
            {member.role === "admin" ? "设为成员" : "设为管理员"}
          </button>}
          <button className="button secondary" type="button" disabled={locked || !!review}
            onClick={() => setReview({ kind: "revoke", member })}>撤回成员权限</button>
        </div>}
      </li>)}</ul>
      {members.nextCursor && <button className="button secondary" type="button" disabled={locked || !!review}
        onClick={() => void run(async (signal) => {
          const page = await client.listOrganizationMembers({ cursor: members.nextCursor ?? undefined, limit: 25 }, signal);
          if (!signal.aborted) setMembers({ items: [...members.items, ...page.items], nextCursor: page.nextCursor });
        })}>更多成员</button>}
      <form aria-label="新增组织成员" onSubmit={add}>
        <label className="dialog-field">成员账号标识<input value={accountId} maxLength={36} required
          readOnly={locked || !!review} onChange={(event) => setAccountId(event.target.value)} /></label>
        {organization.role === "owner" && <label className="dialog-field">加入角色
          <select value={newRole} disabled={locked || !!review} onChange={(event) => {
            setNewRole(event.target.value === "admin" ? "admin" : "member");
          }}><option value="member">成员</option><option value="admin">管理员</option></select>
        </label>}
        <button className="button primary" type="submit" disabled={locked || !!review ||
          organization.seatsUsed >= organization.seatLimit}>审核添加成员</button>
      </form>
    </section>}
    {canManage && review && <section className="account-data-section" aria-label="确认组织变更">
      <h3>{review.kind === "add" ? "添加成员" : review.kind === "role" ? "修改角色" : "撤回成员权限"}</h3>
      <p>{review.kind === "add" ? review.accountId : review.member.username}
        {review.kind !== "revoke" && ` · ${roles[review.role]}`}</p>
      <div className="dialog-actions">
        <button className="button secondary" type="button" disabled={locked} onClick={() => setReview(undefined)}>返回</button>
        <button className="button primary" type="button" disabled={locked} onClick={confirm}>确认组织变更</button>
      </div>
    </section>}
    {canManage && audit && <section className="account-data-section" aria-label="组织审计">
      <h3>操作记录</h3>
      <ul className="private-record-list">{audit.items.map((entry) => <li key={entry.id}>
        <p>{auditLabels[entry.action] ?? entry.action} · {date.format(new Date(entry.createdAt))}</p>
        {entry.targetAccountId && <p>目标账号 {entry.targetAccountId}</p>}
        {entry.actorAccountId && <p>操作账号 {entry.actorAccountId}</p>}
        {entry.role && <p>角色 {roles[entry.role]}</p>}
      </li>)}</ul>
      {audit.nextCursor && <button className="button secondary" type="button" disabled={locked || !!review}
        onClick={() => void run(async (signal) => {
          const page = await client.listOrganizationAudit({ cursor: audit.nextCursor ?? undefined, limit: 25 }, signal);
          if (!signal.aborted) setAudit({ items: [...audit.items, ...page.items], nextCursor: page.nextCursor });
        })}>更多操作记录</button>}
    </section>}
    <div className="dialog-actions">
      <button className="button secondary" type="button" disabled={locked} onClick={() => void run(load)}>刷新组织权限</button>
      <button className="button secondary" type="button" onClick={close}>关闭</button>
    </div>
  </Modal>;
}
