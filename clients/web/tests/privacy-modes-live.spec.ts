import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function register(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.getByLabel("用户名").fill(`qa-privacy-${Math.random().toString(36).slice(2, 10)}`);
  await page.getByLabel("密码", { exact: true }).fill("Qa.Privacy-mode-fixture!");
  const registered = page.waitForResponse((response) => response.url().endsWith("/auth/register"));
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  expect((await registered).status(), "isolated fixture registration").toBe(201);
}

test("temporary messages disappear on close and page reload while ordinary history stays separate", async ({ page }) => {
  test.skip(!process.env.ASSISTANT_WEB_TEST_API_ORIGIN || process.env.ASSISTANT_WEB_TEST_TEMPORARY !== "true",
    "Requires the local synthetic temporary chat feature.");
  await register(page);
  const opener = page.getByRole("button", { name: "临时对话", exact: true });
  await opener.click();
  const modal = page.getByRole("dialog", { name: "临时对话" });
  const input = modal.getByRole("textbox", { name: "临时消息" });
  const send = modal.getByRole("button", { name: "发送临时消息" });
  await expect(modal.getByText("内容不会写入历史或记忆", { exact: false })).toBeVisible();
  await input.fill("注".repeat(513));
  await expect(send).toBeDisabled();
  const content = "临时消息𠮷验证";
  await input.fill(content);
  const completed = page.waitForResponse((reply) => reply.url().endsWith("/temporary-chat"));
  await send.click();
  const response = await completed;
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toMatch(/no-store/);
  await expect(modal.getByText(`本地模拟回复：${content}`, { exact: true })).toBeVisible();
  await modal.getByRole("button", { name: "关闭" }).click();
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(input).toHaveValue("");
  await expect(modal.getByText(content, { exact: true })).toHaveCount(0);
  await input.fill("刷新时清空的草稿");
  await page.reload();
  await expect(page.getByRole("dialog", { name: "临时对话" })).toHaveCount(0);
  expect(await page.evaluate((needle) => [localStorage, sessionStorage].some((store) =>
    Object.values(store).some((value) => value.includes(needle))), content)).toBe(false);
  // The Web token is deliberately in memory and no temporary message is recreated on login.
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
});

test("the owner can revoke old sharing links and explicitly allow fresh sharing", async ({ page, browser }) => {
  test.skip(!process.env.ASSISTANT_WEB_TEST_API_ORIGIN || process.env.ASSISTANT_WEB_TEST_SHARE_RESTRICTION !== "true",
    "Requires private share-restriction endpoints.");
  await register(page);
  const prompt = "验证此分支的链接权限";
  await page.getByRole("textbox", { name: "消息", exact: true }).fill(prompt);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByRole("button", { name: "分享回复", exact: true }).click();
  const publish = page.getByRole("dialog", { name: "分享回复", exact: true });
  await publish.getByLabel("分享对象").selectOption("link");
  await publish.getByRole("button", { name: "预览分享" }).click();
  await publish.getByRole("button", { name: "确认发布" }).click();
  const oldLink = await publish.getByLabel("分享链接").inputValue();
  await publish.getByRole("button", { name: "完成", exact: true }).click();

  const guestContext = await browser.newContext();
  try {
    const guest = await guestContext.newPage();
    await guest.goto(oldLink);
    await expect(guest.getByText(`本地模拟回复：${prompt}`, { exact: true })).toBeVisible();
    await page.getByText("对话操作", { exact: true }).click();
    await page.getByRole("button", { name: "限制分享", exact: true }).click();
    await page.getByRole("dialog", { name: "限制分享" }).getByRole("button", { name: "确认" }).click();
    await expect(page.getByText("分享受限", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "分享回复", exact: true })).toHaveCount(0);
    await expect(page.getByRole("article", { name: "助手回复" })).toContainText(prompt);
    await guest.reload();
    const revoked = guest.getByText("此分享已撤销、过期或当前无权访问。", { exact: true });
    await expect(revoked).toBeVisible();
    await page.getByText("对话操作", { exact: true }).click();
    await page.getByRole("button", { name: "允许新分享", exact: true }).click();
    await page.getByRole("dialog", { name: "允许新分享" }).getByRole("button", { name: "确认" }).click();
    await expect(page.getByRole("button", { name: "分享回复", exact: true })).toBeVisible();
    await guest.reload();
    await expect(revoked).toBeVisible();
    await page.getByRole("button", { name: "退出登录" }).click();
  } finally {
    await guestContext.close();
  }
});

test("keeps personal and project memory independent on a narrow screen", async ({ page }) => {
  test.skip(!process.env.ASSISTANT_WEB_TEST_API_ORIGIN || process.env.ASSISTANT_WEB_TEST_MEMORY !== "true",
    "Requires the gated manual memory endpoints.");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await register(page);
  const drawer = page.getByRole("button", { name: "打开对话列表", exact: true });
  async function openTool(name: string) {
    await drawer.click();
    await page.getByRole("dialog", { name: "对话列表" }).getByRole("button", { name, exact: true }).click();
  }
  await openTool("个人记忆");
  const personal = page.getByRole("dialog", { name: "个人记忆与指令" });
  const personalToggle = personal.getByRole("checkbox", { name: "启用个人记忆" });
  await expect(personalToggle).not.toBeChecked();
  await expect(personal.getByRole("textbox", { name: "新记忆" })).toHaveCount(0);
  await personalToggle.check();
  await personal.getByRole("checkbox", { name: "允许引用聊天历史" }).check();
  await personal.getByRole("textbox", { name: "自定义指令" }).fill("保留一段合成个人指令");
  await personal.getByRole("button", { name: "保存设置" }).click();
  await expect(personal.getByText("设置已保存。", { exact: true })).toBeVisible();
  await personal.getByRole("textbox", { name: "新记忆" }).fill("个人记忆专用内容");
  await personal.getByRole("button", { name: "添加记忆" }).click();
  await expect(personal.getByText("个人记忆专用内容", { exact: true })).toBeVisible();
  await personal.getByRole("button", { name: "编辑记忆" }).click();
  await personal.getByRole("textbox", { name: "修改记忆" }).fill("编辑后的个人记忆");
  await personal.getByRole("button", { name: "保存记忆" }).click();
  await expect(personal.getByText("编辑后的个人记忆", { exact: true })).toBeVisible();
  await expect(personal.getByText("个人记忆专用内容", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(drawer).toBeFocused();

  await openTool("项目");
  const projects = page.getByRole("dialog", { name: "项目", exact: true });
  await projects.getByRole("button", { name: "新建项目" }).click();
  const editor = page.getByRole("dialog", { name: "新建项目" });
  await editor.getByLabel("项目名称").fill("记忆测试项目");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await projects.getByRole("button", { name: "查看项目记忆 记忆测试项目" }).click();
  const project = page.getByRole("dialog", { name: "项目记忆", exact: true });
  const projectToggle = project.getByRole("checkbox", { name: "启用项目记忆" });
  await expect(projectToggle).not.toBeChecked();
  await projectToggle.check();
  await project.getByRole("button", { name: "保存设置" }).click();
  await expect(project.getByText("暂无记忆条目。")).toBeVisible();
  await expect(project.getByLabel("自定义指令")).toHaveCount(0);
  await expect(project.getByText("编辑后的个人记忆")).toHaveCount(0);
  await page.setViewportSize({ width: 667, height: 375 });
  await expect(project.getByRole("button", { name: "关闭", exact: true })).toBeVisible();
  await project.getByRole("textbox", { name: "新记忆" }).fill("项目独立条目");
  await project.getByRole("button", { name: "添加记忆" }).click();
  await expect(project.getByText("项目独立条目", { exact: true })).toBeVisible();
  await project.getByRole("button", { name: "删除记忆" }).click();
  await project.getByRole("button", { name: "确认删除" }).click();
  await expect(project.getByText("项目独立条目", { exact: true })).toHaveCount(0);
  await project.getByRole("button", { name: "关闭", exact: true }).click();
  await projects.getByRole("button", { name: "关闭", exact: true }).click();
  await openTool("个人记忆");
  await expect(personal.getByLabel("自定义指令")).toHaveValue("保留一段合成个人指令");
  await expect(personal.getByText("编辑后的个人记忆", { exact: true })).toBeVisible();
  await personalToggle.uncheck();
  await personal.getByRole("button", { name: "保存设置" }).click();
  await expect(personal.getByText("编辑后的个人记忆", { exact: true })).toHaveCount(0);
});

test("the eligible local model uses consented context and reports its actual budget", async ({ page }) => {
  test.skip(!process.env.ASSISTANT_WEB_TEST_API_ORIGIN || process.env.ASSISTANT_WEB_TEST_MEMORY_CONTEXT !== "true",
    "Requires the opt-in local synthetic memory context route.");
  await register(page);
  await page.getByRole("button", { name: "个人记忆", exact: true }).click();
  const memory = page.getByRole("dialog", { name: "个人记忆与指令" });
  const instruction = "格式：项目符号";
  const privateMarker = "应仅由模型上下文接收的合成记忆";
  const prompt = "本地上下文浏览器验证";
  await memory.getByRole("checkbox", { name: "启用个人记忆" }).check();
  await memory.getByRole("textbox", { name: "自定义指令" }).fill(instruction);
  await memory.getByRole("button", { name: "保存设置" }).click();
  await memory.getByRole("textbox", { name: "新记忆" }).fill(privateMarker);
  await memory.getByRole("button", { name: "添加记忆" }).click();
  await expect(memory.getByText(privateMarker, { exact: true })).toBeVisible();
  await memory.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("textbox", { name: "消息", exact: true }).fill(prompt);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const reply = page.getByRole("article", { name: "助手回复" });
  await expect(reply).toContainText("自定义指令 1，个人记忆 1，项目记忆 0");
  await expect(reply.getByRole("listitem")).toHaveText(prompt);
  await expect(reply.getByText(privateMarker, { exact: true })).toHaveCount(0);
  await expect(reply.getByText(`上下文 ${[...prompt, ...instruction, ...privateMarker].length} / 32,768 字符`, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "退出登录" }).click();
});

test("explicit data export retains the owned saved entry after memory is switched off", async ({ page }) => {
  test.skip(!process.env.ASSISTANT_WEB_TEST_API_ORIGIN || process.env.ASSISTANT_WEB_TEST_PRIVATE_EXPORT !== "true",
    "Requires the private-data export backend.");
  await register(page);
  await page.getByRole("button", { name: "个人记忆", exact: true }).click();
  const memory = page.getByRole("dialog", { name: "个人记忆与指令" });
  const toggle = memory.getByRole("checkbox", { name: "启用个人记忆" });
  await toggle.check();
  await memory.getByRole("button", { name: "保存设置" }).click();
  const content = "可导出的已保存合成记忆";
  await memory.getByRole("textbox", { name: "新记忆" }).fill(content);
  await memory.getByRole("button", { name: "添加记忆" }).click();
  await expect(memory.getByText(content, { exact: true })).toBeVisible();
  await toggle.uncheck();
  await memory.getByRole("button", { name: "保存设置" }).click();
  await expect(memory.getByText(content, { exact: true })).toHaveCount(0);
  await expect(memory.getByText("设置已保存。", { exact: true })).toBeVisible();
  await memory.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "账号与数据", exact: false }).click();
  const account = page.getByRole("dialog", { name: "账号与数据" });
  const saved = page.waitForEvent("download");
  await account.getByRole("button", { name: "下载个人数据", exact: true }).click();
  const download = await saved;
  const data = JSON.parse(await readFile(await download.path(), "utf8"));
  expect(data.schemaVersion).toBe(1);
  expect(data.memorySettings).toEqual([{ scope: "personal", enabled: false, referenceHistory: false, instructions: "" }]);
  expect(data.memoryEntries).toEqual([expect.objectContaining({ scope: "personal", content })]);
  await download.delete();
  await account.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "退出登录" }).click();
});
