import "server-only";

import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

const scope = "/organization-sso";
const apiScope = "/api/assistant/v1/organization-sso";
const browserCookie = "assistant_organization_sso_flow";
export const organizationSsoSessionCookie = "assistant_organization_sso";
const entropy = /^[A-Za-z0-9_-]{43}$/;
const sessionToken = /^osso_[A-Za-z0-9_-]{43}$/;
const callerToken = /^Bearer as_[A-Za-z0-9_-]{43}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const privateHeaders = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

function trustedUrl(value: string | undefined, originOnly = false) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) return undefined;
    if (url.username || url.password || url.search || url.hash || (originOnly && url.pathname !== "/")) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

export function organizationSsoSettings() {
  const web = trustedUrl(process.env.ASSISTANT_WEB_SSO_ORIGIN, true);
  const issuer = trustedUrl(process.env.ASSISTANT_WEB_SSO_ISSUER);
  const configuredAuthorize = trustedUrl(process.env.ASSISTANT_WEB_SSO_AUTHORIZATION_URL);
  const api = trustedUrl(process.env.ASSISTANT_API_ORIGIN, true);
  if (!web || !api) return undefined;
  const authorize = configuredAuthorize?.origin === issuer?.origin ? configuredAuthorize : undefined;
  return { web, issuer, authorize, api };
}

type Settings = NonNullable<ReturnType<typeof organizationSsoSettings>>;
type Path = "/status" | "/link" | "/link/start" | "/link/revoke" | "/start" | "/complete" | "/workspace"
  | "/logout" | "/conversations" | `/conversations/${string}`;

export async function requestOrganizationSso(settings: Settings, path: Path, options: {
  method?: "GET" | "POST";
  body?: object;
  authorization?: string;
  workspace?: string;
  query?: URLSearchParams;
} = {}) {
  const target = new URL(apiScope + path, settings.api);
  if (options.query) target.search = options.query.toString();
  const headers = new Headers({ Accept: "application/json" });
  if (options.authorization) headers.set("Authorization", options.authorization);
  if (options.workspace) headers.set("X-Workspace-Id", options.workspace);
  if (options.body) headers.set("Content-Type", "application/json");
  try {
    const response = await fetch(target, { method: options.method ?? "GET", headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000) });
    return response;
  } catch {
    return undefined;
  }
}

export function scopedSsoBearer(value: string | undefined) {
  return value && sessionToken.test(value) ? `Bearer ${value}` : undefined;
}

function sameOrigin(request: NextRequest, settings: Settings) {
  const origin = request.headers.get("Origin");
  return isOrganizationSsoHost(request, settings) && (origin === settings.web.origin
    || (origin === "null" && request.headers.get("Sec-Fetch-Site") === "same-origin"));
}

export function isOrganizationSsoHost(request: NextRequest, settings: Settings) {
  return request.headers.get("Host") === settings.web.host && request.nextUrl.protocol === settings.web.protocol;
}

function cookieOptions(settings: Settings, maxAge: number) {
  return { path: scope, maxAge, sameSite: "lax" as const, httpOnly: true, secure: settings.web.protocol === "https:" };
}

function error(status: number, code: string) {
  return NextResponse.json({ code, message: "暂时无法完成组织登录操作。" }, { status, headers: privateHeaders });
}

function redirect(settings: Settings, destination: string | URL) {
  return NextResponse.redirect(new URL(destination, settings.web), { status: 303, headers: privateHeaders });
}

function authorizationUrl(value: unknown, settings: Settings) {
  if (!settings.authorize || typeof value !== "string" || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    if (url.origin !== settings.authorize.origin || url.pathname !== settings.authorize.pathname
      || url.username || url.password || url.hash || url.searchParams.get("response_type") !== "code"
      || url.searchParams.get("code_challenge_method") !== "S256"
      || url.searchParams.get("redirect_uri") !== new URL(scope + "/callback", settings.web).href
      || !entropy.test(url.searchParams.get("state") ?? "")) return undefined;
    if (new Set(url.searchParams.keys()).size !== url.searchParams.size) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

async function reviewedPassword(request: NextRequest) {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" || !request.body) {
    return undefined;
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    let source = "";
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 512) {
        await reader.cancel();
        return undefined;
      }
      source += decoder.decode(next.value, { stream: true });
    }
    const input: unknown = JSON.parse(source + decoder.decode());
    if (!input || typeof input !== "object" || !("currentPassword" in input) || !("confirm" in input)
      || Object.keys(input).length !== 2 || typeof input.currentPassword !== "string"
      || input.currentPassword.length === 0 || Buffer.byteLength(input.currentPassword) > 72
      || input.confirm !== true) return undefined;
    return { currentPassword: input.currentPassword, confirm: true };
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

export async function organizationSsoWebApi(request: NextRequest, route: string) {
  const settings = organizationSsoSettings();
  const configuredOrigin = settings && isOrganizationSsoHost(request, settings);
  if (route === "status" && request.method === "GET") {
    const upstream = configuredOrigin && settings.authorize
      ? await requestOrganizationSso(settings, "/status") : undefined;
    const result = upstream?.ok && await upstream.json().catch(() => undefined);
    return NextResponse.json({ available: result?.available === true }, { headers: privateHeaders });
  }
  if (!["link", "link/start", "link/revoke"].includes(route)) return error(404, "NOT_FOUND");
  if (!configuredOrigin) return error(403, "CAPABILITY_UNAVAILABLE");
  const authorization = request.headers.get("Authorization") ?? "";
  const workspace = request.headers.get("X-Workspace-Id") ?? "";
  if (!callerToken.test(authorization) || !uuid.test(workspace)) return error(401, "UNAUTHENTICATED");
  if (route === "link" && request.method === "GET") {
    const upstream = await requestOrganizationSso(settings, "/link", { authorization, workspace });
    if (!upstream?.ok) return error(upstream?.status ?? 502, "FORBIDDEN");
    const state = await upstream.json().catch(() => undefined);
    if (typeof state?.eligible !== "boolean" || typeof state?.linked !== "boolean") return error(502, "INTERNAL_ERROR");
    return NextResponse.json({ eligible: state.eligible, linked: state.linked }, { headers: privateHeaders });
  }
  if (route === "link" || request.method !== "POST" || !sameOrigin(request, settings)) return error(403, "FORBIDDEN");
  const body = await reviewedPassword(request);
  if (!body) return error(400, "VALIDATION_ERROR");
  const method = "POST";
  if (route === "link/revoke") {
    const upstream = await requestOrganizationSso(settings, "/link/revoke", { authorization, workspace, method, body });
    if (upstream?.status !== 204) return error(upstream?.status ?? 502, "FORBIDDEN");
    return new NextResponse(null, { status: 204, headers: privateHeaders });
  }
  if (!settings.authorize) return error(403, "CAPABILITY_UNAVAILABLE");
  const browserBinding = randomBytes(32).toString("base64url");
  const upstream = await requestOrganizationSso(settings, "/link/start",
    { authorization, workspace, method, body: { ...body, browserBinding } });
  if (!upstream?.ok) return error(upstream?.status ?? 502, "FORBIDDEN");
  const challenge = await upstream.json().catch(() => undefined);
  const url = authorizationUrl(challenge?.authorizationUrl, settings);
  if (!url) return error(502, "INTERNAL_ERROR");
  const response = NextResponse.json({ authorizationUrl: url.href }, { headers: privateHeaders });
  response.cookies.set(browserCookie, browserBinding, cookieOptions(settings, 300));
  return response;
}

export async function beginOrganizationSso(request: NextRequest) {
  const settings = organizationSsoSettings();
  if (!settings?.authorize || !sameOrigin(request, settings)) return error(403, "FORBIDDEN");
  const browserBinding = randomBytes(32).toString("base64url");
  const upstream = await requestOrganizationSso(settings, "/start", { method: "POST", body: { browserBinding } });
  const challenge = upstream?.ok && await upstream.json().catch(() => undefined);
  const url = authorizationUrl(challenge?.authorizationUrl, settings);
  if (!url) return redirect(settings, scope + "?status=failed");
  const response = redirect(settings, url);
  response.cookies.set(browserCookie, browserBinding, cookieOptions(settings, 300));
  return response;
}

export async function completeOrganizationSso(request: NextRequest) {
  const settings = organizationSsoSettings();
  if (!settings?.issuer || !settings.authorize || !isOrganizationSsoHost(request, settings)) return error(403, "FORBIDDEN");
  const failed = () => redirect(settings, scope + "?status=failed");
  const query = request.nextUrl.searchParams;
  const state = query.get("state") ?? "";
  const code = query.get("code") ?? "";
  const issuer = query.get("iss") ?? "";
  const browserBinding = request.cookies.get(browserCookie)?.value ?? "";
  if (query.has("error") || new Set(query.keys()).size !== query.size || !entropy.test(state)
    || !/^[A-Za-z0-9._~-]{1,2048}$/.test(code) || issuer !== settings.issuer.href || !entropy.test(browserBinding)) {
    return failed();
  }
  const upstream = await requestOrganizationSso(settings, "/complete",
    { method: "POST", body: { state, code, issuer, browserBinding } });
  const result = upstream?.ok && await upstream.json().catch(() => undefined);
  if (result?.mode === "link" && result.linked === true) {
    const response = redirect(settings, scope + "?status=linked");
    response.cookies.set(browserCookie, "", cookieOptions(settings, 0));
    return response;
  }
  if (result?.mode !== "login" || typeof result.sessionToken !== "string" || !sessionToken.test(result.sessionToken)
    || typeof result.workspaceId !== "string" || !uuid.test(result.workspaceId)
    || typeof result.expiresAt !== "string") return failed();
  const seconds = Math.floor((Date.parse(result.expiresAt) - Date.now()) / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 600) return failed();
  const response = redirect(settings, scope);
  response.cookies.set(browserCookie, "", cookieOptions(settings, 0));
  response.cookies.set(organizationSsoSessionCookie, result.sessionToken, cookieOptions(settings, seconds));
  return response;
}

export async function endOrganizationSso(request: NextRequest) {
  const settings = organizationSsoSettings();
  if (!settings || !sameOrigin(request, settings)) return error(403, "FORBIDDEN");
  const authorization = scopedSsoBearer(request.cookies.get(organizationSsoSessionCookie)?.value);
  if (authorization) {
    const upstream = await requestOrganizationSso(settings, "/logout", { method: "POST", authorization });
    if (!upstream || ![204, 401].includes(upstream.status)) return redirect(settings, scope + "?status=logout-failed");
  }
  const response = redirect(settings, scope + "?status=signed-out");
  response.cookies.set(organizationSsoSessionCookie, "", cookieOptions(settings, 0));
  response.cookies.set(browserCookie, "", cookieOptions(settings, 0));
  return response;
}
