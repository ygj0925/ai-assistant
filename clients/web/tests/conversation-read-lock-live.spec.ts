import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { AssistantClient } from "@ai-assistant/contracts";

test("drops a previously open conversation after locking and requires the current password to reopen", async ({ page, browser }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  test.skip(!origin || process.env.ASSISTANT_WEB_TEST_READ_LOCK !== "true", "Requires the isolated durable conversation read-lock backend.");
  test.setTimeout(65_000);
  const username = `qa-read-lock-web-${randomUUID().slice(0, 8)}`;
  const password = "Qa.Conv-readlock-fixture!";
  const title = "仅本人阅读的合成对话";
  const text = "需要加锁的合成正文";
  const api = new AssistantClient({ origin: origin! });
  await api.replaceSession(await api.register({ username, password }));
  const conversation = await api.createConversation({ title });

  async function open(tab: Page) {
    await tab.goto("/");
    await tab.getByLabel("用户名").fill(username);
    await tab.getByLabel("密码", { exact: true }).fill(password);
    await tab.getByRole("button", { name: "登录", exact: true }).click();
    await tab.getByRole("button", { name: new RegExp(`^${title}`) }).click();
  }

  await open(page);
  await page.getByRole("textbox", { name: "消息", exact: true }).fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("article", { name: "助手回复" })).toContainText(text);
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);

  const secondContext = await browser.newContext();
  try {
    const previous = await secondContext.newPage();
    await open(previous);
    await expect(previous.getByRole("article", { name: "助手回复" })).toContainText(text);
    await page.bringToFront();
    await page.getByText("对话操作", { exact: false }).click();
    await page.getByRole("button", { name: "加锁对话", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "加锁对话" });
    await confirmation.getByRole("button", { name: "确认加锁" }).click();
    await expect(page.getByRole("heading", { name: "对话工作区" })).toBeVisible();
    await expect(page.getByRole("article", { name: "助手回复" })).toHaveCount(0);
    expect((await api.listLockedConversations()).items).toEqual([{ id: conversation.id }]);
    expect((await api.listConversations({ q: text })).items).toEqual([]);
    await expect(api.listMessages(conversation.id)).rejects.toMatchObject({ status: 423, code: "CONVERSATION_LOCKED" });

    await previous.bringToFront();
    await expect(previous.getByRole("heading", { name: "对话工作区" })).toBeVisible({ timeout: 20_000 });
    await expect(previous.getByRole("article", { name: "助手回复" })).toHaveCount(0);
    await expect(previous.getByRole("button", { name: /下载对话/ })).toHaveCount(0);
    await page.bringToFront();
    await page.getByRole("button", { name: "加锁的对话" }).click();
    const locked = page.getByRole("dialog", { name: "加锁的对话" });
    await expect(locked.getByText(title)).toHaveCount(0);
    await locked.getByRole("button", { name: `解锁对话 ${conversation.id.slice(0, 8)}` }).click();
    await locked.getByLabel("当前账号密码").fill("Qa.Wrong-password!");
    await locked.getByRole("button", { name: "确认解锁" }).click();
    await expect(locked.getByRole("alert")).toContainText("密码不正确");
    await expect(locked.getByLabel("当前账号密码")).toHaveValue("");
    await locked.getByLabel("当前账号密码").fill(password);
    await locked.getByRole("button", { name: "确认解锁" }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.getByRole("article", { name: "助手回复" })).toContainText(text);
    expect((await api.listLockedConversations()).items).toEqual([]);
  } finally {
    await secondContext.close();
  }
});
