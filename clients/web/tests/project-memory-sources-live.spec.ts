import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { AssistantClient } from "@ai-assistant/contracts";

test("shows only the exact authorized project memories and removes a deleted excerpt", async ({ page }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  test.skip(!origin || process.env.ASSISTANT_WEB_TEST_PROJECT_MEMORY_SOURCES !== "true",
    "Requires the isolated synthetic model and project memory source receipts.");
  const username = `qa-proj-memory-${randomUUID().slice(0, 8)}`;
  const password = "Qa.Project-memory-fixture!";
  const client = new AssistantClient({ origin: origin! });
  await client.replaceSession(await client.register({ username, password }));
  const first = await client.createProject({ name: "记忆来源合成项目" });
  const second = await client.createProject({ name: "单独的合成项目" });
  const chat = await client.createConversation({ title: "记忆来源演示对话", projectId: first.id });
  await Promise.all([first.id, second.id].map((id) => client.updateMemorySettings({ enabled: true }, id)));
  const revisedText = "排版使用淡蓝色标题 🦀";
  const remainingText = "例子优先使用月份 🌿";
  const withdrawn = await client.createMemory(revisedText, first.id);
  const retained = await client.createMemory(remainingText, first.id);
  await client.createMemory("独立项目内部合成内容", second.id);
  const request = { action: "send", modelId: "local-echo", content: "核对项目来源标记，不填入原文" } as const;
  const { runId } = await client.startRun(chat.id, request, randomUUID());
  await expect.poll(async () => (await client.getRunSnapshot(runId)).state, { timeout: 20_000 }).toBe("completed");
  const [reply] = (await client.listMessages(chat.id)).items.filter(({ role }) => role === "assistant");
  expect(reply.generation?.projectMemorySourcesUsed).toBe(true);
  expect((await client.getMessageProjectMemorySources(chat.id, reply.id)).items).toEqual(expect.arrayContaining([
    { status: "available", entryId: withdrawn.id, excerpt: revisedText },
    { status: "available", entryId: retained.id, excerpt: remainingText },
  ]));
  expect(reply.content).not.toContain(revisedText);
  const other = new AssistantClient({ origin: origin! });
  await other.replaceSession(await other.register({ username: `${username}-outside`, password }));
  await expect(other.getMessageProjectMemorySources(chat.id, reply.id)).rejects.toMatchObject({ status: 404 });

  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: /^记忆来源演示对话/ }).click();
  await page.getByRole("button", { name: "查看项目记忆来源" }).click();
  const dialog = page.getByRole("dialog", { name: "项目记忆来源" });
  await expect(dialog.getByText(revisedText, { exact: true })).toBeVisible();
  await expect(dialog.getByText(remainingText, { exact: true })).toBeVisible();
  await expect(dialog.getByText("独立项目内部合成内容")).toHaveCount(0);
  await client.deleteMemory(withdrawn.id, first.id);
  await dialog.getByRole("button", { name: "重新核对" }).click();
  await expect(dialog.getByText("此记忆当前不可用。")).toBeVisible();
  await expect(dialog.getByText(revisedText, { exact: true })).toHaveCount(0);
  await expect(dialog.getByText(remainingText, { exact: true })).toBeVisible();
  const redacted = await client.getMessageProjectMemorySources(chat.id, reply.id);
  expect(redacted.items).toContainEqual({ status: "unavailable" });
  expect(JSON.stringify(redacted)).not.toContain(withdrawn.id);
});
