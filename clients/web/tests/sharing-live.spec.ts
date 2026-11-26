import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { AssistantClient } from "@ai-assistant/contracts";

const configured = Boolean(process.env.ASSISTANT_WEB_TEST_API_ORIGIN) && process.env.ASSISTANT_WEB_TEST_SHARE_FEATURES === "true";
const password = "Synthetic.share-2026!";

async function register(page: Page, role: string) {
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.getByLabel("用户名").fill(`qa-share-${role}-${Math.random().toString(36).slice(2, 10)}`);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
}

test("publishes a reply snapshot and opens an independent copy before revoking the link", async ({ page, browser }) => {
  test.skip(!configured, "Requires a loopback API with conversation sharing and its independent deletion journal enabled.");
  const recipientContext = await browser.newContext({ viewport: { width: 390, height: 740 }, isMobile: true, hasTouch: true });
  try {
    await page.goto("/");
    await register(page, "author");
    await expect(page.getByRole("heading", { name: "对话工作区" })).toBeVisible();
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await composer.fill("分享验收中文 🦀");
    await composer.press("Enter");
    await expect(page.getByText("版本 synthetic-v1", { exact: false })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "分享回复", exact: true }).click();
    const publish = page.getByRole("dialog", { name: "分享回复", exact: true });
    await publish.getByLabel("分享对象").selectOption("link");
    await publish.getByRole("button", { name: "预览分享" }).click();
    const preview = publish.getByRole("region", { name: "分享预览" });
    await expect(preview).toContainText("本地模拟回复：分享验收中文 🦀");
    await expect(publish.getByLabel("分享链接")).toHaveCount(0);
    await publish.getByRole("button", { name: "确认发布" }).click();
    const field = publish.getByLabel("分享链接");
    await expect(field).toBeVisible();
    const link = new URL(await field.inputValue());
    expect(link.origin).toBe(new URL(page.url()).origin);
    expect(link.pathname).toBe("/share");
    expect(link.search).toBe("");
    expect(link.hash).toMatch(/^#sh_[A-Za-z0-9_-]{43}$/);
    await publish.getByRole("button", { name: "完成", exact: true }).click();

    const recipient = await recipientContext.newPage();
    const guestRead = recipient.waitForRequest((request) => request.url().endsWith("/api/assistant/v1/shares/read"));
    await recipient.goto(link.href);
    const read = await guestRead;
    expect(read.method()).toBe("POST");
    expect(read.headers().authorization).toBeUndefined();
    expect(read.postDataJSON()).toEqual({ token: link.hash.slice(1) });
    await expect(recipient.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
    await expect(recipient.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(recipient.getByText("本地模拟回复：分享验收中文 🦀", { exact: true })).toBeVisible();
    expect(await recipient.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await recipient.getByRole("button", { name: "登录后继续对话" }).click();
    await register(recipient, "reader");
    await recipient.getByRole("button", { name: "创建独立副本" }).click();
    const copyComposer = recipient.getByRole("textbox", { name: "消息", exact: true });
    await expect(copyComposer).toBeVisible();
    expect(new URL(recipient.url()).hash).toBe("");
    await expect(recipient.getByRole("article", { name: "助手回复" })).toContainText("分享验收中文 🦀");
    await expect(recipient.getByRole("article", { name: "你的消息" })).toHaveCount(0);

    await page.getByText("对话操作", { exact: true }).click();
    await page.getByRole("button", { name: "管理分享", exact: true }).click();
    const manage = page.getByRole("dialog", { name: "管理分享" });
    await manage.getByRole("button", { name: "撤销分享", exact: true }).click();
    await manage.getByRole("button", { name: "确认撤销", exact: true }).click();
    await expect(manage.getByText("已撤销", { exact: true })).toBeVisible();
    await manage.getByRole("button", { name: "关闭", exact: true }).click();

    const reopened = await recipientContext.newPage();
    await reopened.goto(link.href);
    await expect(reopened.getByRole("status")).toContainText("此分享已撤销、过期或当前无权访问");
    await expect(reopened.getByText("本地模拟回复：分享验收中文 🦀", { exact: true })).toHaveCount(0);
    await copyComposer.fill("撤销后继续自己的副本");
    await recipient.getByRole("button", { name: "发送", exact: true }).click();
    await expect(recipient.getByRole("article", { name: "助手回复" }).last()).toContainText("撤销后继续自己的副本", { timeout: 15_000 });
    await page.getByRole("button", { name: "退出登录" }).click();
    await recipient.getByRole("button", { name: "打开对话列表" }).click();
    await recipient.getByRole("button", { name: "退出登录" }).click();
  } finally {
    await recipientContext.close();
  }
});

test("reports only the selected visible reply and keeps the link readable before operator action", async ({ page }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  test.skip(!origin || process.env.ASSISTANT_WEB_TEST_SHARED_REPORTS !== "true", "Requires the isolated shared-reply moderation fixture.");
  const author = new AssistantClient({ origin: origin! });
  await author.replaceSession(await author.register({ username: `qa-share-reported-${randomUUID().slice(0, 8)}`, password }));
  const conversation = await author.createConversation({ title: "共享举报验收" });
  const prompt = "生成用于共享举报的合成回复";
  const run = await author.startRun(conversation.id, { action: "send", modelId: "local-echo", content: prompt }, randomUUID());
  await expect.poll(async () => (await author.getRunSnapshot(run.runId)).state, { timeout: 15_000 }).toBe("completed");
  const reply = (await author.listMessages(conversation.id)).items.find((message) => message.role === "assistant");
  if (!reply) throw new Error("Expected a generated fixture reply");
  const selection = { scope: "branch", audience: "link", sourceMessageId: reply.id } as const;
  const preview = await author.previewShare(conversation.id, selection);
  const share = await author.createShare(conversation.id, { ...selection, revision: preview.revision });
  await page.goto(`/share#${share.token}`);
  await page.getByRole("button", { name: "登录后举报", exact: true }).click();
  await register(page, "reporter");
  await expect(page.getByRole("button", { name: "举报共享回复 1", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "举报共享回复 2", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "举报共享回复" });
  await dialog.getByLabel("举报原因").selectOption("privacy");
  const received = page.waitForResponse((response) => response.url().endsWith("/api/assistant/v1/reports")
    && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "提交举报", exact: true }).click();
  const receipt = await received;
  expect(receipt.status()).toBe(201);
  expect(receipt.request().postDataJSON()).toEqual({ targetType: "shared_reply", shareToken: share.token, replyIndex: 1, reason: "privacy" });
  expect(await receipt.json()).toEqual({ id: expect.any(String), targetId: share.id,
    targetType: "shared_reply", reason: "privacy", status: "open", createdAt: expect.any(String) });
  await expect(page.getByText("举报已提交。", { exact: true })).toBeVisible();
  await expect(page.getByText(`本地模拟回复：${prompt}`, { exact: true })).toBeVisible();
});
