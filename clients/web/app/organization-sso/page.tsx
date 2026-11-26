import type { components } from "@ai-assistant/contracts";
import { cookies, headers } from "next/headers";
import { ScopedSsoContent } from "@/components/scoped-sso-content";
import { organizationSsoSessionCookie, organizationSsoSettings, requestOrganizationSso, scopedSsoBearer } from "@/lib/organization-sso-server";

export const dynamic = "force-dynamic";

type Schemas = components["schemas"];
type Query = { status?: string | string[]; cursor?: string | string[]; conversation?: string | string[] };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const cursorPattern = /^[A-Za-z0-9_-]{1,512}$/;
const roleNames: Record<Schemas["OrganizationRole"], string> = { owner: "所有者", admin: "管理员", member: "成员" };

export default async function OrganizationSsoPage({ searchParams }: { searchParams: Promise<Query> }) {
  const settings = organizationSsoSettings();
  const [cookieStore, requestHeaders, query] = await Promise.all([cookies(), headers(), searchParams]);
  const sameHost = settings && requestHeaders.get("Host") === settings.web.host;
  const authorization = sameHost && scopedSsoBearer(cookieStore.get(organizationSsoSessionCookie)?.value);
  let workspace: Schemas["Organization"] | undefined;
  let page: Schemas["ConversationPage"] | undefined;
  let selected: Schemas["Conversation"] | undefined;
  let available = false;

  if (settings && sameHost) {
    const option = await requestOrganizationSso(settings, "/status");
    available = !!settings.authorize && option?.ok === true
      && (await option.json().catch(() => undefined))?.available === true;
    if (available && authorization) {
      const params = new URLSearchParams({ limit: "24" });
      if (typeof query.cursor === "string" && cursorPattern.test(query.cursor)) params.set("cursor", query.cursor);
      const detail = typeof query.conversation === "string" && uuid.test(query.conversation) ? query.conversation : undefined;
      const response = await requestOrganizationSso(settings, "/workspace", { authorization });
      if (response?.ok) {
        const [list, one] = await Promise.all([
          requestOrganizationSso(settings, "/conversations", { authorization, query: params }),
          detail ? requestOrganizationSso(settings, `/conversations/${detail}`, { authorization }) : undefined,
        ]);
        page = list?.ok ? await list.json().catch(() => undefined) : undefined;
        selected = one?.ok ? await one.json().catch(() => undefined) : undefined;
        if (page) workspace = await response.json().catch(() => undefined);
      }
    }
  }

  return <main className="sign-in">
    <div className="sign-in-brand"><a className="wordmark" href="/">青屿助手</a></div>
    <div className="sign-in-main">
      <section className="sign-in-panel" aria-labelledby="organization-sso-title">
        <h1 id="organization-sso-title">组织 SSO</h1>
        {query.status === "linked" && <p role="status">身份核对已完成。可以使用组织 SSO 登录。</p>}
        {query.status === "signed-out" && <p role="status">已退出组织会话。</p>}
        {query.status === "failed" && <p role="alert">无法完成组织登录。请核对账号与组织授权后再试。</p>}
        {query.status === "logout-failed" && <p role="alert">组织会话暂未退出。请重新提交退出。</p>}
        {workspace && page ? <>
          <ScopedSsoContent>
            <h2>{workspace.name}</h2>
            <p>{roleNames[workspace.role]} · 座席 {workspace.seatsUsed}/{workspace.seatLimit}</p>
            <h3>你的组织对话记录</h3>
            {selected && <section className="account-data-section" aria-label="对话摘要">
              <h4>{selected.title}</h4>
              <p>最近更新 <time dateTime={selected.updatedAt}>
                {new Date(selected.updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</time></p>
            </section>}
            {!selected && query.conversation && <p role="status">无法读取这条对话的摘要。</p>}
            {page.items.length === 0 ? <p>暂无对话。</p> : <ul className="private-record-list">
              {page.items.map(({ id, title }) => <li key={id}><a href={`/organization-sso?conversation=${encodeURIComponent(id)}`}>
                {title}</a></li>)}
            </ul>}
            {page.nextCursor && <a className="button secondary"
              href={`/organization-sso?cursor=${encodeURIComponent(page.nextCursor)}`}>下一页</a>}
          </ScopedSsoContent>
          <form action="/organization-sso/logout" method="post"><button className="button secondary" type="submit">退出组织会话</button></form>
        </> : <>
          <p className="auth-subtitle">{available ? "使用已绑定的组织身份查看你的对话摘要。" : "当前未开放组织单点登录。"}</p>
          {available && <form action="/organization-sso/start" method="post">
            <button className="button primary" type="submit">使用组织账号登录</button>
          </form>}
          {authorization && <form action="/organization-sso/logout" method="post">
            <button className="button secondary" type="submit">退出组织会话</button>
          </form>}
          <a className="button secondary" href="/">返回普通账号登录</a>
        </>}
      </section>
    </div>
  </main>;
}
