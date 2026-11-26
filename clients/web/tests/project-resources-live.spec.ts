import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("imports, searches, downloads and revokes a private UTF-8 project text", async ({ page }) => {
  test.skip(!process.env.ASSISTANT_WEB_TEST_API_ORIGIN || process.env.ASSISTANT_WEB_TEST_PROJECT_RESOURCES !== "true",
    "Requires a loopback backend with private project material and an independent deletion journal.");
  await page.goto("/");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.getByLabel("用户名").fill(`qa-text-web-${Date.now().toString(36)}`);
  await page.getByLabel("密码", { exact: true }).fill("Qa.Resource-fixture-2026!");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.getByRole("button", { name: "项目", exact: true }).click();
  const projects = page.getByRole("dialog", { name: "项目", exact: true });
  await projects.getByRole("button", { name: "新建项目", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "新建项目", exact: true });
  await editor.getByLabel("项目名称").fill("合成资料项目");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await projects.getByRole("button", { name: "查看项目资料 合成资料项目" }).click();
  const resources = page.getByRole("dialog", { name: "项目资料", exact: true });
  await resources.getByRole("button", { name: "添加资料" }).click();
  const fixture = "合成资料第一行\n查验标记 THYME-720 🦀\n";
  await resources.getByLabel("选择 UTF-8 文本文件").setInputFiles({
    name: "合成资料.txt", mimeType: "text/plain", buffer: Buffer.from(fixture),
  });
  await expect(resources.getByLabel("资料文本")).toHaveValue(fixture);
  await resources.getByRole("button", { name: "保存资料" }).click();
  await expect(resources.getByText("资料已保存。", { exact: true })).toBeVisible();
  const search = resources.getByLabel("检索资料");
  await search.fill("ｔｈｙｍｅ-７２０");
  await resources.getByRole("button", { name: "检索", exact: true }).click();
  await resources.getByRole("button", { name: "合成资料.txt", exact: true }).click();
  const content = resources.getByRole("region", { name: "资料内容" });
  await expect(content.getByText("查验标记 THYME-720", { exact: false })).toBeVisible();
  const download = page.waitForEvent("download");
  await content.getByRole("button", { name: "下载文本" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("合成资料.txt");
  expect(await readFile(await file.path(), "utf8")).toBe(fixture);
  await file.delete();
  await content.getByRole("button", { name: "删除资料", exact: true }).click();
  await content.getByRole("button", { name: "确认删除" }).click();
  await expect(resources.getByText("资料已删除。", { exact: true })).toBeVisible();
  await expect(resources.getByRole("button", { name: "合成资料.txt", exact: true })).toHaveCount(0);
  await resources.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(projects.getByRole("button", { name: "查看项目资料 合成资料项目" })).toBeFocused();
  await projects.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "退出登录" }).click();
});
