import { AssistantApiError, type AssistantClient, type components } from "@ai-assistant/contracts";

type Schemas = components["schemas"];
export type User = Schemas["User"];
export type AccountErasureRequest = Schemas["AccountErasureRequest"];
export type Conversation = Schemas["Conversation"];
export type ConversationPatch = Schemas["ConversationPatch"];
export type Message = Schemas["Message"];
export type RunSnapshot = Schemas["RunSnapshot"];
export type RunEvent = Schemas["RunEvent"];
export type RunRequest = Schemas["RunRequest"];
export type TextModel = Schemas["TextModel"];

export function idempotencyKey() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Keep a valid UUID when testing from a phone over local HTTP.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

export function safeSourceUrl(value: string) {
  try {
    const address = new URL(value);
    return address.protocol === "https:" && !address.username && !address.password ? address.href : undefined;
  } catch {
    return undefined;
  }
}

export function isActive(run: RunSnapshot | null) {
  return run?.state === "queued" || run?.state === "running";
}

export function applyRunEvent(run: RunSnapshot, event: RunEvent): RunSnapshot {
  if (run.runId !== event.runId || event.sequence <= run.lastSequence || !isActive(run)) return run;
  const next = { ...run, lastSequence: event.sequence };
  switch (event.type) {
    case "run.started": return { ...next, state: "running" };
    case "message.delta": return { ...next, state: "running", content: next.content + event.delta };
    case "run.completed": return { ...next, state: "completed", messageId: event.messageId };
    case "run.cancelled": return { ...next, state: "cancelled" };
    case "run.failed": return { ...next, state: "failed", error: event.error };
  }
}

export function errorText(error: unknown, fallback: string) {
  if (!(error instanceof AssistantApiError)) return fallback;
  switch (error.code) {
    case "UNAUTHENTICATED": return "用户名或密码错误，或登录已过期。";
    case "FORBIDDEN": return "当前账号没有执行此操作的权限。";
    case "SHARE_RESTRICTED": return "此对话的分享已受限。请从对话操作检查当前权限。";
    case "NOT_FOUND": return "此内容不存在或已被移除。";
    case "RATE_LIMITED": return "操作过于频繁，请稍后重试。";
    case "ORGANIZATION_BUDGET_CHANGED": return "组织用量上限已变更，请重新读取后再确认。";
    case "ORGANIZATION_BUDGET_EXHAUSTED": return "组织剩余的月度额度不足以开始此运行。";
    case "ORGANIZATION_BUDGET_RECOVERY_REQUIRED": return "用量账本需要恢复校验。请联系组织管理员。";
    case "CAPABILITY_UNAVAILABLE":
    case "PROVIDER_UNAVAILABLE": return "当前服务暂不可用，请稍后重试。";
    default: return fallback;
  }
}

export async function readHistory(client: AssistantClient, id: string, signal: AbortSignal) {
  const messages: Message[] = [];
  let cursor: string | undefined;
  do {
    signal.throwIfAborted();
    const page = await client.listMessages(id, { cursor, limit: 100 });
    messages.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  signal.throwIfAborted();
  return messages;
}

export function messagePath(messages: Message[], leafId?: string) {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const branch: Message[] = [];
  let current = byId.get(leafId ?? "") ?? messages.at(-1);
  while (current) {
    branch.push(current);
    byId.delete(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return branch.reverse();
}

export function downloadConversation(title: string, messages: Message[]) {
  const lines = messages.map(({ role, content }) => `## ${role === "user" ? "你" : "青屿助手"}\n\n${content}`);
  const blob = new Blob([`# ${title}\n\n${lines.join("\n\n")}\n`], { type: "text/markdown;charset=utf-8" });
  const filename = `${title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 80).trim() || "对话"}.md`;
  downloadBlob(filename, blob);
}

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
