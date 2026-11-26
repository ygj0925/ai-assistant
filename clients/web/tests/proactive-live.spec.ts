import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { AssistantClient } from "@ai-assistant/contracts";

test("opts into private calendar suggestions and respects dismissal and silence", async ({ page }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  test.skip(!origin || process.env.ASSISTANT_WEB_TEST_PROACTIVE !== "true",
    "Requires the isolated real proactive assistant and calendar service.");

  const client = new AssistantClient({ origin: origin! });
  const username = `qa-proactive-${randomUUID().slice(0, 8)}`;
  const password = "Qa.Proactive-fixture!";
  await client.replaceSession(await client.register({ username, password }));
  const title = "只在定时提醒中出现的合成标题";
  const source = await client.createReminder({
    title, startsAtLocal: new Date(Date.now() + 3_600_000).toISOString().slice(0, 16),
    cadence: "once", timeZone: "UTC",
  }, randomUUID());
  await expect(client.getProactivePreferences()).resolves.toMatchObject({ enabled: false });
  await expect(client.listProactiveSuggestions()).resolves.toEqual({ items: [] });

  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "主动建议", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "主动建议" });
  const enabled = panel.getByRole("checkbox", { name: "启用主动建议" });
  const save = panel.getByRole("button", { name: "保存设置" });
  const refresh = panel.getByRole("button", { name: "刷新建议" });
  await expect(enabled).not.toBeChecked();
  await enabled.check();
  await panel.getByRole("combobox", { name: "建议类型" }).selectOption("schedule_planner");
  await panel.getByRole("combobox", { name: "通知方式" }).selectOption("in_app");
  await expect(client.getProactivePreferences()).resolves.toMatchObject({ enabled: false });
  await save.click();
  await expect(panel.getByText("已保存主动建议设置。", { exact: true })).toBeVisible();

  await expect.poll(async () => (await client.listProactiveSuggestions()).items.length, { timeout: 12_000 }).toBe(1);
  const { items: [suggestion] } = await client.listProactiveSuggestions();
  expect(suggestion).toMatchObject({ kind: "review_upcoming", source: "owned_calendar", state: "available" });
  expect(JSON.stringify(suggestion)).not.toContain(source.id);
  expect(JSON.stringify(suggestion)).not.toContain(title);
  await refresh.click();
  await expect(panel.getByText("核对未来一天内的定时提醒")).toBeVisible();
  await expect(panel.getByText(title)).toHaveCount(0);
  await panel.getByRole("button", { name: "查看定时提醒" }).click();
  const calendar = page.getByRole("dialog", { name: "定时提醒" });
  await expect(calendar.getByText(title)).toBeVisible();
  await calendar.getByRole("button", { name: "关闭", exact: true }).click();

  await page.getByRole("button", { name: "主动建议", exact: true }).click();
  await panel.getByRole("button", { name: "关闭这条建议" }).click();
  await expect(panel.getByText("核对未来一天内的定时提醒")).toHaveCount(0);
  await refresh.click();
  await expect(client.listProactiveSuggestions()).resolves.toEqual({ items: [] });

  await panel.getByRole("combobox", { name: "通知方式" }).selectOption("silent");
  await save.click();
  await expect(panel.getByText("已保存主动建议设置。", { exact: true })).toBeVisible();
  await expect(client.getProactivePreferences()).resolves.toMatchObject({ enabled: true, notification: "silent" });
  await enabled.uncheck();
  await save.click();
  await expect(panel.getByText("已关闭主动建议。", { exact: true })).toBeVisible();
  await expect(client.listProactiveSuggestions()).resolves.toEqual({ items: [] });
  expect((await client.listReminders()).items.map((item) => item.id)).toContain(source.id);
});
