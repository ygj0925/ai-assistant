import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { AssistantClient } from "@ai-assistant/contracts";

test("uses an explicitly chosen history reply and withholds its receipt when that source is locked", async ({ page }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  test.skip(!origin || process.env.ASSISTANT_WEB_TEST_HISTORY_REFERENCES !== "true",
    "Requires isolated local model history references and the durable read lock.");
  const username = `qa-history-source-${randomUUID().slice(0, 8)}`;
  const password = "Qa.History-ref-fixture!";
  const api = new AssistantClient({ origin: origin! });
  await api.replaceSession(await api.register({ username, password }));
  const source = await api.createConversation({ title: "合成历史来源" });
  const destination = await api.createConversation({ title: "合成引用目的" });
  const originRun = await api.startRun(source.id, { action: "send", modelId: "local-echo", content: "旧回复正文 🌱" }, randomUUID());
  await expect.poll(async () => (await api.getRunSnapshot(originRun.runId)).state, { timeout: 20_000 }).toBe("completed");
  const originHistory = await api.listMessages(source.id);
  const chosen = originHistory.items.find(({ role }) => role === "assistant");
  expect(chosen).toBeDefined();

  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: /^合成引用目的/ }).click();
  const opener = page.getByRole("button", { name: "引用历史回复" });
  await opener.click();
  const chooser = page.getByRole("dialog", { name: "引用历史回复" });
  await expect(chooser.getByText("在「个人记忆」中启用聊天历史引用后", { exact: false })).toBeVisible();
  await expect(chooser.getByRole("button", { name: "合成历史来源" })).toHaveCount(0);
  await chooser.getByRole("button", { name: "关闭", exact: true }).click();
  await api.updateMemorySettings({ referenceHistory: true });
  await opener.click();
  await chooser.getByRole("button", { name: "合成历史来源", exact: true }).click();
  await expect(chooser.getByText("旧回复正文 🌱", { exact: false })).toBeVisible();
  await chooser.getByRole("button", { name: "引用这条回复" }).click();
  await expect(page.getByText("已选择一条历史回复", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("合成发送请求：只核对本地使用标记");
  await page.getByRole("button", { name: "发送", exact: true }).click();

  const answer = page.getByRole("article", { name: "助手回复" });
  const review = answer.getByRole("button", { name: "查看历史来源" });
  await review.click();
  await expect(answer.getByText(`来源回复 ${chosen!.id.slice(0, 8)}`)).toBeVisible();
  expect(await answer.innerText()).not.toContain("旧回复正文");
  const [completed] = (await api.listMessages(destination.id)).items.filter(({ role }) => role === "assistant");
  expect(await api.getMessageHistoryReference(destination.id, completed.id)).toEqual({ kind: "history_reply", status: "available",
    sourceConversationId: source.id, sourceMessageId: chosen!.id });

  await api.lockConversationReading(source.id);
  await review.click();
  await expect(answer.getByText("此回复曾使用历史来源。当前无法再次访问。")).toBeVisible();
  await expect(answer.getByRole("button", { name: "打开来源对话" })).toHaveCount(0);
  expect(await api.getMessageHistoryReference(destination.id, completed.id)).toEqual({ kind: "history_reply", status: "unavailable" });
});
