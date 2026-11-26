import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { AssistantClient } from "@ai-assistant/contracts";

test("compares exact prices and rechecks a reviewed synthetic merchant source", async ({ page }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  test.skip(!origin || process.env.ASSISTANT_WEB_TEST_SYNTHETIC_CATALOGUE !== "true",
    "Requires an isolated synthetic merchandise catalogue.");
  const username = `qa-catalogue-web-${randomUUID().slice(0, 8)}`;
  const password = "Qa.Synthetic-catalogue!";
  const client = new AssistantClient({ origin: origin! });
  await client.register({ username, password });
  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "合成商品目录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "合成商品目录" });
  const catalogue = dialog.getByRole("region", { name: "搜索结果" });
  await expect(catalogue.getByText("129.90 CNY", { exact: false })).toBeVisible();
  await catalogue.getByRole("checkbox", { name: "对比 星河折叠键盘" }).check();
  await catalogue.getByRole("checkbox", { name: "对比 云桥桌面支架" }).check();
  await dialog.getByRole("button", { name: "对比所选商品" }).click();
  const comparison = dialog.getByRole("region", { name: "商品对比" });
  await expect(comparison.getByRole("heading", { level: 4 })).toHaveText(["星河折叠键盘", "云桥桌面支架"]);
  await expect(comparison.getByText("3900 JPY", { exact: false })).toBeVisible();
  const sourceLink = dialog.getByRole("link", { name: "打开测试商家来源" });
  await expect(sourceLink).toHaveCount(0);
  await comparison.getByRole("listitem").filter({ hasText: "星河折叠键盘" })
    .getByRole("button", { name: "核对商品来源" }).click();
  await expect(sourceLink).toHaveAttribute("href", "https://fixture-shop.example/products/river-keyboard");
  await expect(sourceLink).toHaveAttribute("rel", "noreferrer noopener");
  await dialog.getByRole("textbox", { name: "搜索商品" }).fill("ＡＩ 键盘");
  await dialog.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(catalogue.getByRole("heading", { level: 4 })).toHaveText(["星河折叠键盘"]);
  await expect(sourceLink).toHaveCount(0);
});
