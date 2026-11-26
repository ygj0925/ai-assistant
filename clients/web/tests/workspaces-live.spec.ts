import { expect, test, type Page } from "@playwright/test";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const evidence = process.env.ASSISTANT_WEB_TEST_MEMBERSHIP_FIXTURE;

async function register(page: Page, role: string) {
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  const name = `qa-share-${role}-${Math.random().toString(36).slice(2, 9)}`;
  await page.getByLabel("用户名").fill(name);
  await page.getByLabel("密码", { exact: true }).fill("Qa.Share-workspace-switch!");
  const response = page.waitForResponse((reply) => reply.url().endsWith("/auth/register"));
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  const registered = await response;
  expect(registered.status()).toBe(201);
  return (await registered.json()).user as { id: string; username: string; workspaceId: string };
}

async function writeMarker(root: string, name: string, body: Record<string, string>) {
  await mkdir(root, { recursive: true });
  const path = join(root, name);
  await writeFile(`${path}.tmp`, JSON.stringify(body));
  await rename(`${path}.tmp`, path);
}

test("switches an authenticated share recipient into an authorized workspace and clears old scoped UI", async ({ page, browser }) => {
  test.skip(!evidence || !process.env.ASSISTANT_WEB_TEST_API_ORIGIN, "Requires an isolated workspace membership fixture driver.");
  const directory = evidence as string;
  const leave = process.env.ASSISTANT_WEB_TEST_WORKSPACE_DEPARTURE === "true";
  const recipients = await browser.newContext();
  try {
    await page.goto("/");
    const owner = await register(page, "owner");
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("来源工作空间切换自测");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByText("版本 synthetic-v1", { exact: false })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "分享回复", exact: true }).click();
    const publish = page.getByRole("dialog", { name: "分享回复", exact: true });
    await publish.getByLabel("分享对象").selectOption("workspace");
    await publish.getByRole("button", { name: "预览分享" }).click();
    await publish.getByRole("button", { name: "确认发布" }).click();
    const share = await publish.getByLabel("分享链接").inputValue();
    await publish.getByRole("button", { name: "完成", exact: true }).click();

    const readerPage = await recipients.newPage();
    await readerPage.goto(share);
    await readerPage.getByRole("button", { name: "登录后尝试访问" }).click();
    const reader = await register(readerPage, "reader");
    await expect(readerPage.getByText("此分享已撤销、过期或当前无权访问。", { exact: true })).toBeVisible();
    await writeMarker(directory, "add.json", { workspaceId: owner.workspaceId, readerId: reader.id, ownerId: owner.id });
    await expect.poll(() => access(join(directory, "added.json")).then(() => true, () => false), { timeout: 15_000 }).toBe(true);
    await readerPage.getByRole("button", { name: "切换工作空间" }).click();
    const switcher = readerPage.getByRole("dialog", { name: "切换工作空间" });
    await switcher.getByRole("button", { name: `工作空间 ${owner.workspaceId.slice(0, 8)}` }).click();
    await expect(readerPage.getByText("本地模拟回复：来源工作空间切换自测", { exact: true })).toBeVisible();
    await readerPage.getByRole("button", { name: "创建独立副本" }).click();
    await expect(readerPage.getByRole("article", { name: "助手回复" })).toContainText("来源工作空间切换自测");
    const composer = readerPage.getByRole("textbox", { name: "消息", exact: true });
    await composer.fill("此草稿仅限来源工作空间");
    await readerPage.getByRole("button", { name: `账号与数据 · ${reader.username}` }).click();
    await readerPage.getByRole("button", { name: "切换工作空间" }).click();
    if (leave) {
      const leaveButton = switcher.getByRole("button", { name: `退出 工作空间 ${owner.workspaceId.slice(0, 8)}` });
      const confirmation = switcher.getByRole("region", { name: "确认退出工作空间" });
      await expect(switcher.getByRole("button", { name: "退出 个人空间" })).toHaveCount(0);
      await leaveButton.click();
      await expect(confirmation).toBeVisible();
      await confirmation.getByRole("button", { name: "取消退出" }).click();
      await expect(confirmation).toHaveCount(0);
      await leaveButton.click();
      const receipt = readerPage.waitForResponse((response) => response.url().endsWith(`/auth/workspaces/${owner.workspaceId}/leave`));
      await confirmation.getByRole("button", { name: "确认退出工作空间" }).click();
      expect((await receipt).status()).toBe(204);
    } else {
      await switcher.getByRole("button", { name: "个人空间", exact: true }).click();
    }
    await expect(readerPage.getByRole("heading", { name: "对话工作区" })).toBeVisible();
    await expect(readerPage.getByRole("article", { name: "助手回复" })).toHaveCount(0);
    await expect(composer).toHaveValue("");
    if (leave) {
      await readerPage.getByRole("button", { name: `账号与数据 · ${reader.username}` }).click();
      await readerPage.getByRole("button", { name: "切换工作空间" }).click();
      await expect(switcher.getByRole("button", { name: /^个人空间/ })).toHaveAttribute("aria-current", "true");
      await expect(switcher.getByRole("button", { name: `工作空间 ${owner.workspaceId.slice(0, 8)}` })).toHaveCount(0);
      await switcher.getByRole("button", { name: "关闭", exact: true }).click();
      await readerPage.getByRole("dialog", { name: "账号与数据" }).getByRole("button", { name: "关闭", exact: true }).click();
    }
    await writeMarker(directory, "finished.json", {});
    await readerPage.getByRole("button", { name: "退出登录" }).click();
    await page.getByRole("button", { name: "退出登录" }).click();
  } finally {
    await recipients.close();
  }
});
