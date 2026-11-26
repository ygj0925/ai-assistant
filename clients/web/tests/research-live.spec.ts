import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("requires new approval after changing sources and reconnects to the revised report", async ({ page, browser }) => {
  test.skip(!process.env.ASSISTANT_WEB_TEST_API_ORIGIN || process.env.ASSISTANT_WEB_TEST_RESEARCH !== "true",
    "Requires approved synthetic sources in the isolated research API.");
  const username = `qa-research-web-${Date.now().toString(36)}`;
  const password = "Qa.Research-synthetic-fixture!";
  await page.goto("/");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.getByRole("button", { name: "研究任务", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "研究任务" });
  const question = panel.getByLabel("研究问题");
  const reuse = process.env.ASSISTANT_WEB_TEST_RESEARCH_REUSE === "true";
  await question.fill("先核对甲的样本");
  await panel.getByRole("checkbox", { name: /合成手册甲/ }).check();
  if (reuse) {
    await panel.getByRole("checkbox", { name: /合成检索浏览器手册/ }).check();
    await expect(panel.getByRole("link", { name: "打开来源 合成手册甲" })).toHaveAttribute("href", "https://example.com/qa/retrieval/a");
  }
  await panel.getByRole("button", { name: "保存计划", exact: true }).click();
  await expect(panel.getByText("版本 1 · 待确认", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "确认此版本" }).click();
  await expect(panel.getByRole("region", { name: "当前任务状态" })).toContainText(/已排队|正在整理/);
  if (reuse) {
    await expect.poll(async () => {
      await panel.getByRole("button", { name: "刷新状态与来源" }).click();
      return (await panel.getByRole("region", { name: "当前任务状态" }).textContent()) ?? "";
    }, { timeout: 8_000 }).toContain("正在整理");
  }
  await question.fill("改为核对乙的校验号");
  await panel.getByRole("checkbox", { name: /合成手册甲/ }).uncheck();
  await panel.getByRole("checkbox", { name: /合成手册乙/ }).check();
  await panel.getByRole("button", { name: "保存新版本" }).click();
  await expect(panel.getByText("版本 2 · 待确认", { exact: true })).toBeVisible();
  if (reuse) await expect(panel.getByText("已保留 1 项来源核验结果。")).toBeVisible();
  await expect(panel.getByRole("button", { name: "下载本版本报告" })).toHaveCount(0);
  await panel.getByRole("button", { name: "关闭", exact: true }).click();

  const otherClient = await browser.newContext();
  try {
    const other = await otherClient.newPage();
    await other.goto("/");
    await other.getByLabel("用户名").fill(username);
    await other.getByLabel("密码", { exact: true }).fill(password);
    await other.getByRole("button", { name: "登录", exact: true }).click();
    await other.getByRole("button", { name: "研究任务", exact: true }).click();
    const resumed = other.getByRole("dialog", { name: "研究任务" });
    await resumed.getByRole("button", { name: /改为核对乙的校验号/ }).click();
    await expect(resumed.getByText("版本 2 · 待确认", { exact: true })).toBeVisible();
    await resumed.getByRole("button", { name: "确认此版本" }).click();
    const download = resumed.getByRole("button", { name: "下载本版本报告" });
    await expect.poll(async () => {
      await resumed.getByRole("button", { name: "刷新状态与来源" }).click();
      return download.count();
    }, { timeout: 20_000 }).toBe(1);
    const reportRequest = other.waitForEvent("download");
    await download.click();
    const report = await reportRequest;
    expect(report.suggestedFilename()).toBe("research-report.txt");
    const text = await readFile(await report.path(), "utf8");
    expect(text).toContain("改为核对乙的校验号");
    expect(text).toContain("虚构样本乙的校验号为 721。");
    expect(text).toContain("https://example.com/qa/retrieval/b");
    if (reuse) expect(text).toContain("https://example.com/qa/retrieval/browser");
    expect(text).not.toContain("虚构样本甲");
    await report.delete();
  } finally {
    await otherClient.close();
  }
});
