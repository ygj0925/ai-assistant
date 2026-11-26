import { expect, test } from "@playwright/test";

test("schedules, pauses, delivers and removes owned in-app reminders", async ({ page }) => {
  test.skip(!process.env.ASSISTANT_WEB_TEST_API_ORIGIN || process.env.ASSISTANT_WEB_TEST_REMINDERS !== "true",
    "Requires the isolated live reminder service.");
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.getByLabel("用户名").fill(`qa-reminder-web-${Date.now().toString(36)}`);
  await page.getByLabel("密码", { exact: true }).fill("Qa.Reminder-fixture-2026!");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.getByRole("button", { name: "定时提醒", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "定时提醒" });
  const settings = panel.getByRole("region", { name: "已设置提醒" });
  const history = panel.getByRole("region", { name: "送达记录" });
  const localTime = panel.getByLabel("首次提醒时间");
  const title = panel.getByLabel("提醒内容");
  await panel.getByLabel("时区", { exact: true }).fill("UTC");
  await title.fill("合成每周回顾");
  await localTime.fill(new Date(Date.now() + 86_400_000).toISOString().slice(0, 16));
  await panel.getByLabel("重复规则").selectOption("weekly");
  await panel.getByRole("checkbox", { name: "设置静默时段" }).check();
  await panel.getByLabel("静默开始").fill("22:00");
  await panel.getByLabel("静默结束").fill("07:00");
  await panel.getByRole("button", { name: "创建提醒" }).click();
  const recurring = settings.getByRole("listitem").filter({ hasText: "合成每周回顾" });
  await expect(recurring).toContainText("每周");
  await expect(recurring).toContainText("UTC");
  await recurring.getByRole("button", { name: "暂停" }).click();
  await expect(recurring).toContainText("已暂停");
  await recurring.getByRole("button", { name: "恢复" }).click();
  await expect(recurring).toContainText("已启用");

  await title.fill("合成单次提醒");
  await panel.getByLabel("重复规则").selectOption("once");
  await panel.getByRole("checkbox", { name: "设置静默时段" }).uncheck();
  const soon = Math.ceil((Date.now() + 12_000) / 60_000) * 60_000;
  await localTime.fill(new Date(soon).toISOString().slice(0, 16));
  await panel.getByRole("button", { name: "创建提醒" }).click();
  const once = settings.getByRole("listitem").filter({ hasText: "合成单次提醒" });
  await expect(once).toContainText("已启用");
  const item = history.getByRole("listitem").filter({ hasText: "合成单次提醒" });
  await expect.poll(async () => {
    await panel.getByRole("button", { name: "刷新提醒", exact: true }).click();
    return item.count();
  }, { intervals: [500, 1_000], timeout: 85_000 }).toBe(1);
  await expect(once).toContainText("已完成");
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  const unread = page.getByRole("button", { name: /定时提醒，最近 20 条中有 1 条未读/ });
  await unread.click();
  await item.getByRole("button", { name: "标为已读" }).click();
  await expect(item).toContainText("已读");
  await once.getByRole("button", { name: "删除", exact: true }).click();
  await once.getByRole("button", { name: "确认删除" }).click();
  await expect(once).toHaveCount(0);
  await expect(item).toHaveCount(0);
});
