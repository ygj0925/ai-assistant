import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { AssistantClient } from "@ai-assistant/contracts";

const password = "Qa.ReminderShare-fixture!";

async function login(page: Page, username: string) {
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
}

test("previews a reminder share, copies it explicitly and revokes subsequent access", async ({ page, browser }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  test.skip(!origin || process.env.ASSISTANT_WEB_TEST_REMINDER_SHARES !== "true",
    "Requires the isolated real reminder share service.");

  const sender = new AssistantClient({ origin: origin! });
  const receiver = new AssistantClient({ origin: origin! });
  const suffix = Date.now().toString(36);
  const senderName = `qa-reminder-from-${suffix}`;
  const receiverName = `qa-reminder-to-${suffix}`;
  await sender.replaceSession(await sender.register({ username: senderName, password }));
  await receiver.replaceSession(await receiver.register({ username: receiverName, password }));
  const title = "合成分享日程";
  const source = await sender.createReminder({
    title, startsAtLocal: new Date(Date.now() + 86_400_000).toISOString().slice(0, 11) + "12:00",
    cadence: "weekly", timeZone: "UTC", quietHours: { start: "22:00", end: "07:00" },
  }, randomUUID());
  await page.goto("/");
  await login(page, senderName);
  await page.getByRole("button", { name: "定时提醒", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "定时提醒" });
  const rule = panel.getByRole("listitem").filter({ hasText: title });
  await rule.getByRole("button", { name: "分享设置" }).click();
  const publication = panel.getByRole("region", { name: "提醒分享" });
  await publication.getByRole("button", { name: "预览将公开的日程" }).click();
  await expect(publication.getByRole("region", { name: "将复制的提醒设置" })).toContainText("每周 · UTC");
  await expect(publication.getByText("静默时段 22:00 至 07:00")).toBeVisible();
  await publication.getByRole("button", { name: "确认生成链接" }).click();
  const link = publication.getByLabel("提醒分享链接");
  await expect(link).toHaveValue(/\/reminder-share#r=/);
  const url = new URL(await link.inputValue());
  const token = new URLSearchParams(url.hash.slice(1)).get("r")!;

  const context = await browser.newContext();
  try {
    const recipient = await context.newPage();
    await recipient.goto(url.href);
    await expect(recipient).toHaveURL(/\/reminder-share$/);
    await expect(recipient.getByRole("heading", { name: title })).toHaveCount(0);
    await login(recipient, receiverName);
    await expect(recipient.getByRole("heading", { name: title })).toBeVisible();
    await expect(recipient.getByText(senderName)).toHaveCount(0);
    expect((await receiver.listReminders()).items).toEqual([]);
    if (process.env.ASSISTANT_WEB_TEST_PUBLIC_TARGET_REPORTS === "true") {
      const reviewed = await receiver.readReminderShare(token);
      await recipient.getByRole("button", { name: "举报", exact: true }).click();
      const report = recipient.getByRole("dialog", { name: "举报分享的提醒" });
      await report.getByLabel("举报原因").selectOption("spam");
      const response = recipient.waitForResponse((current) => current.url().endsWith("/api/assistant/v1/reports")
        && current.request().method() === "POST");
      await report.getByRole("button", { name: "提交举报" }).click();
      const receipt = await response;
      expect(receipt.status()).toBe(201);
      expect(receipt.request().postDataJSON()).toEqual({ targetType: "reminder_share", shareToken: token,
        revision: reviewed.revision, reason: "spam" });
      await expect(recipient.getByText("举报已提交。", { exact: true })).toBeVisible();
      expect((await receiver.listReminders()).items).toEqual([]);
    }
    await recipient.getByRole("button", { name: "在当前工作空间启用" }).click();
    await expect(recipient.getByText(`已在当前工作空间启用「${title}」。`)).toBeVisible();
    const copied = (await receiver.listReminders()).items;
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({ title, cadence: "weekly", timeZone: "UTC",
      quietHours: { start: "22:00", end: "07:00" } });
    expect(copied[0].id).not.toBe(source.id);

    await publication.getByRole("button", { name: "撤销链接", exact: true }).click();
    await publication.getByRole("button", { name: "确认撤销链接" }).click();
    await expect(publication.getByText("已撤销此链接。")).toBeVisible();
    await expect(receiver.readReminderShare(token)).rejects.toMatchObject({ status: 404 });
    expect((await receiver.listReminders()).items).toHaveLength(1);
  } finally {
    await context.close();
  }
});
