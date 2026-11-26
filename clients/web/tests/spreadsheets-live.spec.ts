import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { AssistantClient } from "@ai-assistant/contracts";

test("edits typed cells, restores a spreadsheet version and downloads XLSX", async ({ page }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  test.skip(!origin || process.env.ASSISTANT_WEB_TEST_SPREADSHEETS !== "true",
    "Requires the live private spreadsheet feature.");
  const username = `qa-sheet-web-${Date.now().toString(36)}`;
  const password = "Qa.Sheet-synthetic-fixture!";
  const api = new AssistantClient({ origin: origin! });
  await api.replaceSession(await api.register({ username, password }));
  const project = await api.createProject({ name: "合成表格项目" });
  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "文稿", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "文稿" });
  await editor.getByLabel("所属项目").selectOption(project.id);
  await editor.getByLabel("文稿标题").fill("合成数值登记");
  await editor.getByLabel("文件格式").selectOption("sheet");
  await editor.getByLabel("工作表名称").fill("记录");
  await editor.getByLabel("单元格 A1").fill("=1+2");
  await editor.getByLabel("单元格 B1").focus();
  await editor.getByLabel("所选单元格类型").selectOption("number");
  await editor.getByLabel("单元格 B1").fill("0.10000000000000001");
  await expect(editor.getByText(/单元格 B1 的数字无效/)).toBeVisible();
  await editor.getByLabel("单元格 B1").fill("12.5");
  await editor.getByLabel("单元格 C1").focus();
  await editor.getByLabel("所选单元格类型").selectOption("boolean");
  await editor.getByLabel("单元格 C1").selectOption("false");
  await editor.getByRole("button", { name: "创建表格" }).click();
  await expect(editor.getByText("已保存版本 1。")).toBeVisible();

  const [summary] = (await api.listArtifacts({ projectId: project.id })).items;
  expect((await api.getArtifact(summary.id)).head).toMatchObject({
    sheet: { name: "记录", rows: [["=1+2", 12.5, false], [null, null, null], [null, null, null]] },
  });
  await expect(editor.getByRole("region", { name: "发布文稿版本" })).toHaveCount(0);
  await editor.getByRole("button", { name: "新增一行" }).click();
  await editor.getByLabel("单元格 B1").fill("30");
  await editor.getByRole("button", { name: "保存新版本" }).click();
  await expect(editor.getByText("已保存版本 2。")).toBeVisible();
  await editor.getByRole("button", { name: "版本 1", exact: true }).click();
  await expect(editor.getByRole("region", { name: "工作表 记录" })).toContainText("=1+2");
  await editor.getByRole("button", { name: "还原为新版本" }).click();
  await editor.getByRole("button", { name: "确认还原" }).click();
  await expect(editor.getByText("已从版本 1 创建版本 3。")).toBeVisible();
  await expect(editor.getByLabel("单元格 B1")).toHaveValue("12.5");
  const requested = page.waitForEvent("download");
  await editor.getByRole("button", { name: "下载当前版本" }).click();
  const download = await requested;
  expect(download.suggestedFilename()).toBe("artifact-3.xlsx");
  const data = await readFile(await download.path());
  expect(data.subarray(0, 4)).toEqual(Buffer.from([80, 75, 3, 4]));
  await download.delete();
});
