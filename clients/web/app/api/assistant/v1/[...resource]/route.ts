import type { NextRequest } from "next/server";
import { organizationSsoWebApi } from "@/lib/organization-sso-server";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ resource: string[] }> };

const forwardedRequestHeaders = [
  "accept",
  "authorization",
  "content-type",
  "idempotency-key",
  "last-event-id",
  "x-assistant-ocr-reviewed",
  "x-attachment-grant",
  "x-workspace-id",
];
const forwardedResponseHeaders = ["content-type", "content-disposition", "content-security-policy", "retry-after", "x-request-id",
  "x-accel-buffering", "x-content-type-options"];
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_ATTACHMENT_BYTES = 1024 * 1024;

function apiError(status: number, code: string, message: string) {
  return Response.json({ code, message }, { status, headers: { "Cache-Control": "no-store" } });
}

async function proxy(request: NextRequest, context: Context) {
  const { resource } = await context.params;
  if (resource.some((part) => !part || part === "." || part === ".." || /[\\/\u0000-\u001f]/.test(part))) {
    return apiError(400, "VALIDATION_ERROR", "无效的 API 路径。");
  }
  if (resource[0] === "organization-sso") return organizationSsoWebApi(request, resource.slice(1).join("/"));
  const attachmentUpload = request.method === "POST" && resource.length === 3 &&
    resource[0] === "projects" && ["attachments", "audio-attachments"].includes(resource[2]);
  const requestLimit = attachmentUpload ? MAX_ATTACHMENT_BYTES : MAX_REQUEST_BYTES;

  let origin: URL;
  try {
    origin = new URL(process.env.ASSISTANT_API_ORIGIN || "http://127.0.0.1:18090");
  } catch {
    return apiError(500, "INTERNAL_ERROR", "助手服务地址配置无效。");
  }
  if (!["http:", "https:"].includes(origin.protocol) || origin.pathname !== "/" ||
      origin.username || origin.password || origin.search || origin.hash) {
    return apiError(500, "INTERNAL_ERROR", "助手服务地址配置无效。");
  }
  const target = new URL(`/api/assistant/v1/${resource.map(encodeURIComponent).join("/")}`, origin);
  target.search = request.nextUrl.search;

  const headers = new Headers();
  for (const name of forwardedRequestHeaders) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  try {
    let body: Uint8Array<ArrayBuffer> | undefined;
    if (request.body) {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > requestLimit) {
            void reader.cancel().catch(() => undefined);
            return apiError(413, "VALIDATION_ERROR", "请求内容过大。");
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      body = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }

    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      signal: request.signal,
      cache: "no-store",
      redirect: "manual",
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      return apiError(502, "INTERNAL_ERROR", "助手服务返回了无效的重定向。");
    }
    const responseHeaders = new Headers({ "Cache-Control": "no-store" });
    for (const name of forwardedResponseHeaders) {
      const value = upstream.headers.get(name);
      if (value !== null) responseHeaders.set(name, value);
    }
    if (responseHeaders.get("content-type")?.startsWith("text/event-stream")) {
      responseHeaders.set("X-Accel-Buffering", "no");
      responseHeaders.set("Cache-Control", "no-store, no-transform");
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return apiError(502, "PROVIDER_UNAVAILABLE", "暂时无法连接助手服务，请稍后重试。");
  }
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
