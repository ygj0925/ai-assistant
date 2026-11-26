import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const configuredBackend = Boolean(process.env.ASSISTANT_WEB_TEST_API_ORIGIN);
const password = "local-smoke-test!";

function uniqueAccount(prefix = "web") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

async function register(page: Page, username: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await expect(page.getByRole("heading", { name: "对话工作区" })).toBeVisible();
}

async function action(page: Page, name: string) {
  await page.getByText("对话操作", { exact: true }).click();
  await page.getByRole("button", { name, exact: true }).click();
}

async function rename(page: Page, title: string) {
  await action(page, "重命名");
  await page.getByLabel("对话名称").fill(title);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
}

test("files a conversation in a private project and downloads its background export", async ({ page }) => {
  test.skip(!configuredBackend || process.env.ASSISTANT_WEB_TEST_JOB_FEATURES !== "true",
    "Requires a loopback API with assistant.jobs.enabled=true.");
  await register(page, uniqueAccount("project"));
  const projects = page.getByRole("button", { name: "项目", exact: true });
  await projects.click();
  const panel = page.getByRole("dialog", { name: "项目", exact: true });
  await panel.getByRole("button", { name: "新建项目", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "新建项目", exact: true });
  await editor.getByRole("textbox", { name: "项目名称" }).fill("研究笔记");
  await editor.getByRole("textbox", { name: "项目说明" }).fill("合成项目说明");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(panel.getByText("合成项目说明")).toBeVisible();
  await panel.getByRole("button", { name: "编辑项目 研究笔记" }).click();
  const edit = page.getByRole("dialog", { name: "编辑项目", exact: true });
  await expect(edit.getByLabel("项目说明")).toHaveValue("合成项目说明");
  await edit.getByLabel("项目说明").fill("更新后的说明");
  await edit.getByRole("button", { name: "保存", exact: true }).click();
  await expect(panel.getByText("更新后的说明")).toBeVisible();
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(projects).toBeFocused();

  const composer = page.getByRole("textbox", { name: "消息", exact: true });
  await composer.fill("导出分支验证 🦀");
  await composer.press("Enter");
  await expect(page.getByText("版本 synthetic-v1", { exact: false })).toBeVisible({ timeout: 15_000 });
  await rename(page, "合成对话甲");
  await action(page, "移动到项目");
  const mover = page.getByRole("dialog", { name: "移动对话到项目" });
  const put = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith("/project"));
  await mover.getByRole("button", { name: "将对话移入 研究笔记" }).click();
  expect((await put).status()).toBe(200);
  await expect(mover.getByRole("status")).toHaveText("已将对话移入「研究笔记」。");
  await mover.getByRole("button", { name: "关闭", exact: true }).click();
  await projects.click();
  await panel.getByRole("button", { name: "研究笔记", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "对话列表" }).getByRole("button", { name: /^合成对话甲/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "研究笔记", exact: true })).toBeFocused();

  await action(page, "后台导出");
  const jobs = page.getByRole("dialog", { name: "后台任务" });
  await jobs.getByRole("button", { name: "开始导出" }).click();
  await expect(jobs.getByRole("button", { name: "已提交" })).toBeDisabled();
  await jobs.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "后台任务", exact: true }).click();
  await expect(jobs.getByText("已完成", { exact: true })).toBeVisible({ timeout: 25_000 });
  const downloaded = page.waitForEvent("download");
  await jobs.getByRole("button", { name: "下载 Markdown" }).click();
  const result = await downloaded;
  expect(result.suggestedFilename()).toMatch(/^对话导出-[a-f0-9]{8}\.md$/);
  expect(await readFile(await result.path(), "utf8")).toContain("本地模拟回复：导出分支验证 🦀");
  await result.delete();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "后台任务", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
});

test("registers and signs in while managing conversation history", async ({ page }) => {
  const username = uniqueAccount();
  await register(page, username);
  await page.getByRole("button", { name: "新建对话" }).click();
  await expect(page.getByRole("heading", { name: "新对话" })).toBeVisible();
  await rename(page, "研发计划");
  await action(page, "置顶");
  await expect(page.getByRole("button", { name: /^研发计划/ })).toBeVisible();
  const search = page.getByRole("searchbox", { name: "搜索对话" });
  await search.fill("不会命中");
  await expect(page.getByText("没有匹配的对话。")).toBeVisible();
  await search.fill("研发");
  await expect(page.getByRole("button", { name: /^研发计划/ })).toBeVisible();
  await search.clear();
  await action(page, "归档");
  await expect(page.getByRole("button", { name: "已归档", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveCount(0);
  await action(page, "恢复对话");
  await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "退出登录" }).click();
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: /^研发计划/ }).click();
  await action(page, "删除对话");
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByRole("heading", { name: "对话工作区" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^研发计划/ })).toHaveCount(0);
});

test("streams replies, preserves IME input and downloads the visible branch", async ({ page, context }) => {
  await register(page, uniqueAccount());
  const composer = page.getByRole("textbox", { name: "消息", exact: true });
  await composer.fill("中文输入 🌱");
  await composer.evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
  });
  await expect(composer).toHaveValue("中文输入 🌱");
  await expect(page.getByRole("heading", { name: "对话工作区" })).toBeVisible();
  await composer.press("Shift+Enter");
  await expect(composer).toHaveValue("中文输入 🌱\n");
  await composer.press("Enter");

  const answer = page.getByRole("article", { name: "助手回复" });
  if (configuredBackend) {
    await expect(answer).toContainText("中文输入 🌱", { timeout: 15_000 });
    await expect(page.getByText("版本 synthetic-v1", { exact: false })).toBeVisible();
  } else {
    await expect(answer).toContainText("首段回答。");
    await context.setOffline(true);
    await expect(page.getByText("网络已断开。恢复连接后可以继续对话。")).toBeVisible();
    await context.setOffline(false);
    await expect(answer).toContainText("流式接续成功。", { timeout: 15_000 });
    await expect(answer.getByRole("table")).toBeVisible();
    await expect(answer.getByRole("link", { name: "可访问链接" })).toHaveAttribute("rel", "noopener noreferrer");
    await expect(answer.getByRole("link", { name: "无效链接" })).toHaveCount(0);
    await expect(answer.getByText("const value = 1;", { exact: true })).toBeVisible();
  }
  await expect(page.getByRole("article", { name: "你的消息" })).toHaveCount(1);
  await expect(answer).toHaveCount(1);
  const downloaded = page.waitForEvent("download");
  await action(page, "下载对话");
  expect((await downloaded).suggestedFilename()).toBe("新对话.md");

  await composer.fill("保留我的草稿");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByRole("button", { name: "取消编辑" }).click();
  await expect(composer).toHaveValue("保留我的草稿");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await composer.fill("调整后的分支");
  await composer.press("Enter");
  await expect(page.getByRole("combobox", { name: "对话分支" })).toBeVisible({ timeout: 15_000 });
  await expect(composer).toHaveValue("保留我的草稿");
  await expect(page.getByRole("article", { name: "你的消息" })).toContainText("调整后的分支");
  await page.getByRole("combobox", { name: "对话分支" }).selectOption({ index: 0 });
  await expect(page.getByRole("article", { name: "你的消息" })).toContainText("中文输入 🌱");
  await action(page, "删除对话");
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByRole("heading", { name: "对话工作区" })).toBeVisible();
});

test.describe("small mobile browser", () => {
  test.use({
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    viewport: { width: 375, height: 667 },
    colorScheme: "dark",
    reducedMotion: "reduce",
  });

  test("stops generation and clears web drafts when switching accounts", async ({ page }) => {
    test.skip(configuredBackend, "This cancellation window is provided by the browser fixture.");
    await page.addInitScript(() => {
      Object.defineProperty(window.crypto, "randomUUID", { configurable: true, value: undefined });
    });
    const username = uniqueAccount("mobile");
    await register(page, username);
    await page.evaluate(() => { document.documentElement.style.fontSize = "125%"; });
    await expect(page.getByRole("button", { name: "打开对话列表" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await composer.fill("请停止");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByRole("article", { name: "助手回复" })).toContainText("首段回答。");
    await page.getByRole("button", { name: "停止", exact: true }).click();
    await expect(page.getByText("已停止生成。", { exact: true })).toBeVisible();
    await composer.fill("仅当前账号可见的草稿");
    await page.getByRole("button", { name: "打开对话列表" }).click();
    await expect(page.getByRole("dialog", { name: "对话列表" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "对话列表" })).toHaveCount(0);
    await page.getByRole("button", { name: "打开对话列表" }).click();
    await page.getByRole("button", { name: "退出登录" }).click();
    await expect(page.getByRole("heading", { name: "登录青屿" })).toBeVisible();
    await register(page, uniqueAccount("other"));
    await expect(composer).toHaveValue("");
    await page.getByRole("button", { name: "打开对话列表" }).click();
    await expect(page.getByRole("button", { name: /^新对话/ })).toHaveCount(0);
    await page.getByRole("button", { name: "关闭对话列表" }).click();
    await page.setViewportSize({ width: 667, height: 375 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(667);
    await expect(composer).toBeInViewport();
  });
});

test("bounds the same-origin relay to assistant requests", async ({ request }) => {
  const outside = await request.get("/api/health");
  expect(outside.status()).toBe(404);
  const invalid = await request.post("/api/assistant/v1/auth/login", { data: { padding: "x".repeat(65_536) } });
  expect(invalid.status()).toBe(413);
  expect(await invalid.json()).toMatchObject({ code: "VALIDATION_ERROR" });
});

test("checks account allowance and downloads personal export one page at a time", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const username = uniqueAccount();
  await register(page, username);
  await page.getByRole("button", { name: "打开对话列表" }).click();
  const trigger = page.getByRole("button", { name: `账号与数据 · ${username}` });
  const usageResponse = page.waitForResponse((response) => response.url().endsWith("/api/assistant/v1/usage"));
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "账号与数据" });
  await expect(dialog).toBeInViewport({ ratio: 1 });
  const usage = await (await usageResponse).json();
  const held = dialog.getByText("已预留", { exact: true }).locator("..").locator("dd");
  await expect(held).toHaveText(new Intl.NumberFormat("zh-CN").format(usage.reserved));

  const cursors: Array<string | null> = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/assistant/v1/privacy/export") cursors.push(url.searchParams.get("cursor"));
  });
  async function download(label: string, number: number) {
    const file = page.waitForEvent("download");
    await dialog.getByRole("button", { name: label }).click();
    const result = await file;
    expect(result.suggestedFilename()).toBe(`assistant-data-${number}.json`);
    const content = JSON.parse(await readFile(await result.path(), "utf8"));
    expect(content.account.username).toBe(username);
    expect(content.schemaVersion).toBe(1);
    await result.delete();
    return content;
  }

  const first = await download("下载个人数据", 1);
  expect(cursors).toEqual([null]);
  const status = dialog.getByRole("status");
  if (configuredBackend) {
    expect(first.nextCursor).toBeNull();
    await expect(status).toHaveText("已下载第 1 份。导出已完成。");
  } else {
    await expect(status).toHaveText("已下载第 1 份。还有数据可继续下载。");
    const last = await download("下载下一份", 2);
    expect(cursors).toEqual([null, first.nextCursor]);
    expect(last.nextCursor).toBeNull();
    await expect(status).toHaveText("已下载第 2 份。导出已完成。");
  }
  await expect(dialog.getByRole("button", { name: "重新导出" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "登录青屿" })).toBeVisible();

  if (!configuredBackend) {
    const nextUser = uniqueAccount();
    await page.getByRole("button", { name: "创建账号", exact: true }).click();
    await page.getByLabel("用户名").fill(nextUser);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "创建账号", exact: true }).click();
    await page.getByRole("button", { name: "打开对话列表" }).click();
    await page.getByRole("button", { name: `账号与数据 · ${nextUser}` }).click();
    await expect(dialog.getByRole("button", { name: "下载个人数据" })).toBeVisible();
    expect(cursors).toEqual([null, first.nextCursor]);
  }
});

test("gates and confirms destructive account erasure before clearing the workspace", async ({ page }) => {
  test.skip(configuredBackend, "Erasure uses a synthetic policy and credentials in this browser fixture.");
  await page.setViewportSize({ width: 375, height: 667 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });

  async function openAccount(username: string) {
    await page.getByRole("button", { name: "打开对话列表" }).click();
    const capability = page.waitForResponse((result) => result.url().endsWith("/api/assistant/v1/capabilities"));
    await page.getByRole("button", { name: `账号与数据 · ${username}` }).click();
    expect((await capability).status()).toBe(200);
    return page.getByRole("dialog", { name: "账号与数据" });
  }

  const noErasure = uniqueAccount("disabled");
  await register(page, noErasure);
  const disabledAccount = await openAccount(noErasure);
  await expect(disabledAccount.getByRole("button", { name: "注销账号", exact: true })).toHaveCount(0);
  await disabledAccount.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "登录青屿" })).toBeVisible();

  const username = uniqueAccount();
  await register(page, username);
  const composer = page.getByRole("textbox", { name: "消息", exact: true });
  await composer.fill("合成账号的待清理草稿");
  const account = await openAccount(username);
  const trigger = account.getByRole("button", { name: "注销账号", exact: true });
  const confirmation = page.getByRole("dialog", { name: "确认注销账号" });
  const passwordField = confirmation.getByLabel("当前密码");
  const typed = confirmation.getByLabel("输入 DELETE 确认");
  const submit = confirmation.getByRole("button", { name: "永久注销账号" });
  let submissions = 0;
  const isErasure = (url: string) => url.endsWith("/api/assistant/v1/privacy/account-erasure");
  page.on("request", (request) => { if (isErasure(request.url())) submissions += 1; });
  await trigger.click();
  await expect(passwordField).toBeFocused();
  await passwordField.fill("synthetic-wrong-password");
  await typed.fill("delete");
  await expect(submit).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(submissions).toBe(0);

  await trigger.click();
  await expect(typed).toHaveValue("");
  await expect(passwordField).toHaveValue("");
  await passwordField.fill("synthetic-wrong-password");
  await typed.fill("DELETE");
  await submit.click();
  await expect(confirmation.getByRole("alert")).toHaveText("当前密码不正确，请重新输入。");
  await expect(passwordField).toBeFocused();
  await expect(passwordField).toHaveValue("");
  await expect(typed).toHaveValue("DELETE");
  expect(submissions).toBe(1);

  await passwordField.fill(password);
  let releaseRequest = () => {};
  const canSend = new Promise<void>((resolve) => { releaseRequest = resolve; });
  await page.route("**/api/assistant/v1/privacy/account-erasure", async (route) => {
    await canSend;
    await route.continue();
  }, { times: 1 });
  const erased = page.waitForResponse((response) => isErasure(response.url()));
  try {
    await submit.click();
    await expect(confirmation.getByRole("button", { name: "正在注销…" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByRole("button", { name: "返回账号与数据" })).toBeDisabled();
  } finally {
    releaseRequest();
  }
  expect((await erased).status()).toBe(204);
  await expect(confirmation).toHaveCount(0);
  await expect(composer).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "登录青屿" })).toBeVisible();
  const success = page.getByRole("status");
  await expect(success).toHaveText("账号已注销，所有设备会话已退出。");
  await expect(success).toBeFocused();
  expect(submissions).toBe(2);
});

test("reports a stored assistant reply and keeps the reason on failure", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await register(page, uniqueAccount());
  await page.evaluate(() => { document.documentElement.style.fontSize = "125%"; });
  const composer = page.getByRole("textbox", { name: "消息", exact: true });
  await composer.fill("测试举报流程");
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
  await composer.press("Enter");

  const reply = page.getByRole("article", { name: "助手回复" });
  const reportButton = reply.getByRole("button", { name: "举报", exact: true });
  await expect(reportButton).toBeVisible({ timeout: 15_000 });
  const userMessage = page.getByRole("article", { name: "你的消息" });
  await expect(userMessage.getByRole("button", { name: "举报", exact: true })).toHaveCount(0);
  const dialog = page.getByRole("dialog", { name: "举报回复" });
  const reason = dialog.getByRole("combobox", { name: "举报原因" });
  await reportButton.click();
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await expect(reason).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(reportButton).toBeFocused();

  await reportButton.click();
  await page.setViewportSize({ width: 667, height: 375 });
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await reason.selectOption("privacy");
  const endpoint = "**/api/assistant/v1/reports";
  await page.route(endpoint, (route) => route.fulfill({
    status: 404, json: { code: "NOT_FOUND", message: "Report target not found" },
  }), { times: 1 });
  const submit = dialog.getByRole("button", { name: "提交举报" });
  await submit.click();
  await expect(dialog.getByRole("alert")).toHaveText("此内容不存在或已被移除。");
  await expect(reason).toHaveValue("privacy");

  const submitted = page.waitForResponse((response) => response.url().endsWith("/api/assistant/v1/reports"));
  await submit.click();
  const result = await submitted;
  expect(result.status()).toBe(201);
  const receipt = await result.json();
  expect(result.request().postDataJSON()).toEqual({ targetType: "assistant_reply", targetId: receipt.targetId, reason: "privacy" });
  expect(receipt).toEqual({
    id: expect.any(String), targetType: "assistant_reply", targetId: expect.any(String),
    reason: "privacy", status: "open", createdAt: expect.any(String),
  });
  await expect(dialog).toHaveCount(0);
  await expect(reply.getByRole("status").filter({ hasText: "举报已提交。" })).toBeVisible();
  await expect(reportButton).toBeFocused();
  await expect(reportButton).toBeDisabled();
});
