import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { AssistantClient } from "@ai-assistant/contracts";

test("requires explicit approval and reconciles an unknown sandbox result once", async ({ page }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  test.skip(!origin || process.env.ASSISTANT_WEB_TEST_SANDBOX_CONNECTOR !== "true",
    "Requires an isolated local connector and a dedicated simulator ledger.");
  const username = `qa-connector-web-${randomUUID().slice(0, 8)}`;
  const password = "Qa.Synthetic-connector-fixture!";
  const api = new AssistantClient({ origin: origin! });
  await api.replaceSession(await api.register({ username, password }));
  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const opener = page.getByRole("button", { name: "连接器沙箱" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "连接器沙箱" });
  await dialog.getByRole("button", { name: "连接本机沙箱" }).click();
  expect(await api.getSandboxConnectorAuthorization()).toEqual({ state: "disconnected" });
  await dialog.getByRole("button", { name: "确认连接" }).click();
  await expect(dialog.getByText("当前连接已授权。")).toBeVisible();
  await dialog.getByRole("checkbox", { name: "模拟首次执行回执丢失" }).check();
  await dialog.getByRole("button", { name: "创建审批请求" }).click();
  await expect(dialog.getByText("等待审批", { exact: true })).toBeVisible();
  const [created] = (await api.listSandboxConnectorActions()).items;
  const action = dialog.getByRole("listitem", { name: `通知操作 ${created.id.slice(0, 8)}` });
  await action.getByRole("button", { name: "审核这项请求" }).click();
  await expect(dialog.getByText("此次测试将模拟首次回执丢失。")).toBeVisible();
  expect(await api.getSandboxConnectorAction(created.id)).toMatchObject({ state: "awaiting_approval" });
  await dialog.getByRole("button", { name: "批准并执行" }).click();
  await expect(action.getByText("待核实", { exact: true })).toBeVisible({ timeout: 20_000 });
  const pending = await api.getSandboxConnectorAction(created.id);
  expect(pending.state).toBe("pending_result");
  expect(pending.result).toBeUndefined();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await opener.click();
  await expect(action.getByText("待核实", { exact: true })).toBeVisible();
  await action.getByRole("button", { name: "核实账本结果" }).click();
  await expect(action.getByText("已核实", { exact: true })).toBeVisible();
  const completed = await api.getSandboxConnectorAction(created.id);
  expect(completed.result).toMatchObject({ kind: "fixture_receipt" });
  expect(await api.reconcileSandboxConnectorAction(created.id)).toEqual(completed);

  await dialog.getByRole("button", { name: "创建审批请求" }).click();
  await expect(dialog.getByText("等待审批", { exact: true })).toBeVisible();
  const awaiting = (await api.listSandboxConnectorActions()).items.find(({ state }) => state === "awaiting_approval");
  expect(awaiting).toBeDefined();
  await dialog.getByRole("button", { name: "撤销连接授权" }).click();
  await dialog.getByRole("button", { name: "确认撤销授权" }).click();
  await expect(dialog.getByText("授权已失效", { exact: true })).toBeVisible();
  await expect(api.approveSandboxConnectorAction(awaiting!.id, awaiting!.approvalRevision))
    .rejects.toMatchObject({ status: 409, code: "CONNECTOR_AUTHORIZATION_CHANGED" });
  expect(await api.getSandboxConnectorAction(created.id)).toEqual(completed);
});
