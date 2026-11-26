import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

const password = "fixture-share-test!";

async function register(page: Page, prefix: string) {
  const username = `${prefix}-${randomUUID().slice(0, 12)}`;
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  return username;
}

async function conversationAction(page: Page, name: string) {
  await page.getByText("对话操作", { exact: true }).click();
  await page.getByRole("button", { name, exact: true }).click();
}

test("previews share scope, publishes a fragment link, copies it and revokes the original", async ({ page, browser }) => {
  test.skip(!!process.env.ASSISTANT_WEB_TEST_API_ORIGIN, "Fixture-only sharing regression.");
  const privatePrompt = "此提问只包含在当前分支";
  // Compile the share shell in development before logging into the memory-only owner session.
  await page.goto("/share");
  await expect(page.getByRole("status")).toHaveText("分享链接无效。");
  await page.goto("/");
  const owner = await register(page, "owner");
  await expect(page.getByRole("heading", { name: "对话工作区" })).toBeVisible();
  const composer = page.getByRole("textbox", { name: "消息", exact: true });
  await composer.fill(privatePrompt);
  await composer.press("Enter");

  const replyButton = page.getByRole("button", { name: "分享回复", exact: true });
  await expect(replyButton).toBeVisible({ timeout: 15_000 });
  await conversationAction(page, "重命名");
  await page.getByLabel("对话名称").fill("分享测试笔记");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("heading", { name: "分享测试笔记" })).toBeVisible();

  await conversationAction(page, "分享当前分支");
  const branch = page.getByRole("dialog", { name: "分享当前分支" });
  await expect(branch.getByLabel("分享对象")).toHaveValue("workspace");
  await branch.getByRole("button", { name: "预览分享" }).click();
  await expect(branch.getByRole("heading", { name: "分享预览" })).toBeFocused();
  await expect(branch.getByText(privatePrompt, { exact: true })).toBeVisible();
  await branch.getByRole("button", { name: "取消", exact: true }).click();

  let publishes = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/shares")) publishes += 1;
  });
  await replyButton.click();
  const publish = page.getByRole("dialog", { name: "分享回复" });
  await publish.getByLabel("分享对象").selectOption("link");
  await publish.getByRole("button", { name: "预览分享" }).click();
  await expect(publish.getByText(/流式接续成功/)).toBeVisible();
  await expect(publish.getByText(privatePrompt, { exact: true })).toHaveCount(0);
  expect(publishes).toBe(0);
  await publish.getByRole("button", { name: "确认发布" }).click();
  const link = publish.getByRole("textbox", { name: "分享链接" });
  await expect(link).toBeFocused();
  const destination = new URL(await link.inputValue());
  expect(destination.pathname).toBe("/share");
  expect(destination.search).toBe("");
  expect(destination.hash).toMatch(/^#sh_[A-Za-z0-9_-]{43}$/);
  expect(publishes).toBe(1);
  await publish.getByRole("button", { name: "完成", exact: true }).click();
  await expect(replyButton).toBeFocused();

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const recipient = await context.newPage();
    const readRequest = recipient.waitForRequest((request) => request.url().endsWith("/api/assistant/v1/shares/read"));
    const result = await recipient.goto(destination.href);
    expect(result?.headers()["referrer-policy"]).toBe("no-referrer");
    expect(result?.headers()["x-robots-tag"]).toContain("noindex");
    const read = await readRequest;
    expect(read.method()).toBe("POST");
    expect(read.postDataJSON()).toEqual({ token: destination.hash.slice(1) });
    expect((await read.allHeaders()).referer ?? "").toBe("");
    await expect(recipient.getByRole("heading", { name: "分享测试笔记" })).toBeVisible();
    await expect(recipient.getByText(privatePrompt, { exact: true })).toHaveCount(0);
    await expect(recipient.getByRole("link", { name: "可访问链接" })).toHaveCount(0);

    await recipient.getByRole("button", { name: "登录后继续对话" }).click();
    await register(recipient, "reader");
    await recipient.getByRole("button", { name: "创建独立副本" }).click();
    await expect(recipient).toHaveURL(`${destination.origin}/`);
    await expect(recipient.getByRole("heading", { name: "分享测试笔记" })).toBeVisible();
    await expect(recipient.getByText(/流式接续成功/)).toBeVisible();
    await expect(recipient.getByRole("button", { name: "重新生成", exact: true })).toHaveCount(0);

    const observer = await context.newPage();
    await observer.goto(destination.href);
    await expect(observer.getByText(/流式接续成功/)).toBeVisible();
    await observer.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    await expect(observer.getByText(/流式接续成功/)).toHaveCount(0);

    await page.goto("/");
    await page.getByLabel("用户名").fill(owner);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("button", { name: /^分享测试笔记/ }).click();
    await conversationAction(page, "管理分享");
    const management = page.getByRole("dialog", { name: "管理分享" });
    await expect(management.getByText("单条回复 · 知道链接的人")).toBeVisible();
    await expect(management.getByRole("textbox", { name: "分享链接" })).toHaveCount(0);
    await management.getByRole("button", { name: "撤销分享", exact: true }).click();
    await expect(management.getByRole("heading", { name: "确认撤销分享" })).toBeFocused();
    await management.getByRole("button", { name: "确认撤销", exact: true }).click();
    await expect(management.getByText("已撤销", { exact: true })).toBeVisible();

    await observer.bringToFront();
    await observer.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await expect(observer.getByRole("status")).toHaveText("此分享已撤销、过期或当前无权访问。");
    await expect(observer.getByText(/流式接续成功/)).toHaveCount(0);
    await expect(recipient.getByText(/流式接续成功/)).toBeVisible();
  } finally {
    await context.close();
  }
});
