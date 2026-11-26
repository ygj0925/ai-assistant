import { expect, test } from "@playwright/test";

test("renders supported claims and checks sources without inventing an answer", async ({ page }) => {
  test.skip(!process.env.ASSISTANT_WEB_TEST_API_ORIGIN || process.env.ASSISTANT_WEB_TEST_RETRIEVAL !== "true",
    "Requires the loopback retrieval service with the synthetic source fixture.");
  await page.goto("/");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.getByLabel("用户名").fill(`qa-cites-web-${Date.now().toString(36)}`);
  await page.getByLabel("密码", { exact: true }).fill("Local.retrieval-fixture-2026!");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  const entry = page.getByRole("button", { name: "来源检索" });
  await entry.click();
  const dialog = page.getByRole("dialog", { name: "来源检索" });
  const query = dialog.getByLabel("检索内容");
  await query.fill("browsercheck722");
  await dialog.getByRole("button", { name: "检索", exact: true }).click();
  const result = dialog.getByRole("region", { name: "检索结果" });
  await expect(result.getByText("虚构浏览器样本的校验号为 722。", { exact: false })).toBeVisible();
  await expect(result.getByRole("link", { name: "来源 1", exact: true })).toBeVisible();
  await expect(result.getByRole("link", { name: "打开来源" })).toHaveAttribute("href", "https://example.com/qa/retrieval/browser");
  await expect(result.getByRole("link", { name: "打开来源" })).toHaveAttribute("rel", "noopener noreferrer");
  await result.getByRole("button", { name: "重新核对来源" }).click();
  await expect(result.getByText("合成检索浏览器手册")).toBeVisible();
  await query.fill("未收录的随机测试来源 0b06");
  await query.press("Enter");
  await expect(result.getByRole("status")).toHaveText("没有可用来源支持此次检索。");
  await expect(result.getByRole("link")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(entry).toBeFocused();
  await page.getByRole("button", { name: "退出登录" }).click();
});
