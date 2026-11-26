import type { AssistantClient } from "@ai-assistant/contracts";

export type ShareSelection = Parameters<AssistantClient["previewShare"]>[1];
export type SharePreview = Awaited<ReturnType<AssistantClient["previewShare"]>>;
export type ShareView = Awaited<ReturnType<AssistantClient["readShare"]>>;
export type ShareRecord = Awaited<ReturnType<AssistantClient["listShares"]>>["items"][number];

export function tokenFromFragment(hash: string): string | null {
  const value = hash.slice(1);
  return hash.startsWith("#") && /^sh_[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export function shareScopeLabel(scope: ShareSelection["scope"]) {
  return scope === "reply" ? "单条回复" : "当前分支";
}

export function shareAudienceLabel(audience: ShareSelection["audience"]) {
  return audience === "link" ? "知道链接的人" : "工作空间成员";
}

export function shareDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}
