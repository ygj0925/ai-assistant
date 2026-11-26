import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { AssistantClient } from "@ai-assistant/contracts";

test("deduplicates verified connector events and respects a paused subscription", async ({ page }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  test.skip(!origin || process.env.ASSISTANT_WEB_TEST_EVENT_REMINDERS !== "true",
    "Requires a local connector and isolated event reminder worker.");
  const username = `qa-reminder-event-${randomUUID().slice(0, 8)}`;
  const password = "Qa.Event-reminder-fixture!";
  const client = new AssistantClient({ origin: origin! });
  await client.replaceSession(await client.register({ username, password }));
  const grant = await client.authorizeSandboxConnector();
  if (grant.state !== "authorized") throw new Error("Expected a separate authorization");
  const authorizationId = grant.authorizationId;
  async function verifiedAction() {
    const action = await client.createSandboxConnectorAction({
      authorizationId, kind: "fixture_notice", simulation: "acknowledged",
    }, randomUUID());
    await client.approveSandboxConnectorAction(action.id, action.approvalRevision);
    await expect.poll(async () => (await client.getSandboxConnectorAction(action.id)).state,
      { timeout: 18_000 }).toBe("completed");
    return action.id;
  }

  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "连接器事件提醒" }).click();
  const panel = page.getByRole("dialog", { name: "连接器事件提醒" });
  await panel.getByLabel("提醒名称").fill("合成事件订阅");
  await panel.getByLabel("提醒时区").fill("Asia/Shanghai");
  await panel.getByRole("button", { name: "创建事件提醒" }).click();
  const detail = panel.getByRole("region", { name: "事件提醒详情" });
  await expect(detail.getByText("暂无投递记录。")).toBeVisible();
  const [subscription] = (await client.listSandboxEventReminders()).items;
  const operationId = await verifiedAction();
  const refresh = panel.getByRole("button", { name: "刷新订阅和投递" });
  await refresh.click();
  await panel.getByRole("combobox", { name: "选择通知", exact: true }).selectOption(operationId);
  const receive = panel.getByRole("button", { name: "接收此事件" });
  await receive.click();
  await expect(panel.getByText("新建 1 条，重复 0 条，跳过 0 条。")).toBeVisible();
  await receive.click();
  await expect(panel.getByText("新建 0 条，重复 1 条，跳过 0 条。")).toBeVisible();
  await expect.poll(async () => (await client.listSandboxEventReminderOccurrences(subscription.id)).items[0]?.state,
    { timeout: 18_000 }).toBe("delivered");
  await refresh.click();
  await detail.getByRole("button", { name: "标为已读" }).click();
  await expect(detail.getByText("已读", { exact: true })).toBeVisible();
  const [delivered] = (await client.listSandboxEventReminderOccurrences(subscription.id)).items;
  expect(delivered.operationId).toBe(operationId);
  expect(delivered.readAt).toBeTruthy();

  await detail.getByRole("button", { name: "暂停事件提醒" }).click();
  await expect(panel.getByText("已暂停 · Asia/Shanghai")).toBeVisible();
  const later = await verifiedAction();
  await refresh.click();
  await panel.getByRole("combobox", { name: "选择通知", exact: true }).selectOption(later);
  await receive.click();
  await expect(panel.getByText("新建 0 条，重复 0 条，跳过 1 条。")).toBeVisible();
  await detail.getByRole("button", { name: "恢复事件提醒" }).click();
  await receive.click();
  await expect(panel.getByText("新建 0 条，重复 1 条，跳过 0 条。")).toBeVisible();
  const beforeRevoke = await client.listSandboxEventReminderOccurrences(subscription.id);
  expect(beforeRevoke.items).toHaveLength(2);
  expect(beforeRevoke.items.map(({ state }) => state).sort()).toEqual(["delivered", "skipped"]);

  await client.revokeSandboxConnectorAuthorization(authorizationId);
  await refresh.click();
  await expect(panel.getByText("连接授权已撤回 · Asia/Shanghai")).toBeVisible();
  const afterRevoke = await client.listSandboxEventReminderOccurrences(subscription.id);
  expect(afterRevoke.items.every(({ operationId: source }) => source === undefined)).toBe(true);
});
