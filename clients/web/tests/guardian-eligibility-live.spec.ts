import { expect, test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AssistantClient } from "@ai-assistant/contracts";

const run = promisify(execFile);
const password = "Qa.Guardian-synthetic-only!";

async function signInPilot(page: Page, username: string, workspace: string) {
  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: `账号与数据 · ${username}` }).click();
  await page.getByRole("button", { name: "切换工作空间", exact: true }).click();
  await page.getByRole("dialog", { name: "切换工作空间" })
    .getByRole("button", { name: `工作空间 ${workspace.slice(0, 8)}`, exact: true }).click();
  await page.getByRole("button", { name: "使用资格与监护" }).click();
  return page.getByRole("dialog", { name: "使用资格与监护" });
}

test("the current guardian's confirmed grant controls connector access and is revocable", async ({ page, browser }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  const provision = process.env.ASSISTANT_WEB_TEST_GUARDIAN_PROVISION;
  test.skip(!origin || !provision, "Requires an isolated eligibility pilot and approved synthetic enrollment fixture.");
  test.setTimeout(65_000);

  const suffix = randomUUID().slice(0, 8);
  const participantName = `qa-guardian-part-${suffix}`;
  const guardianName = `qa-guardian-owner-${suffix}`;
  const participant = new AssistantClient({ origin: origin! });
  const guardian = new AssistantClient({ origin: origin! });
  const first = await participant.register({ username: participantName, password });
  const second = await guardian.register({ username: guardianName, password });
  await participant.replaceSession(first);
  await guardian.replaceSession(second);

  const folder = await mkdtemp(join(tmpdir(), "assistant-guardian-browser-"));
  let workspace: string;
  try {
    await writeFile(join(folder, "enroll.json"), JSON.stringify({ participantAccountId: first.user.id,
      guardianAccountId: second.user.id }), { flag: "wx" });
    await run(process.execPath, [provision!, folder], { timeout: 24_000 });
    workspace = (JSON.parse(await readFile(join(folder, "enrolled.json"), "utf8")) as { workspaceId: string }).workspaceId;
    expect(workspace).toMatch(/^[0-9a-f-]{36}$/);
  } finally {
    await unlink(join(folder, "enroll.json")).catch(() => undefined);
    await unlink(join(folder, "enrolled.json")).catch(() => undefined);
    await rmdir(folder).catch(() => undefined);
  }
  await participant.switchWorkspace(workspace);
  await guardian.switchWorkspace(workspace);
  await expect(participant.getEligibility()).resolves.toEqual({ applicable: true, connectorStatus: "guardian_required" });
  await expect(participant.listGuardianConsents()).resolves.toEqual({ items: [] });
  await expect(participant.authorizeSandboxConnector()).rejects.toMatchObject({ status: 403 });

  const view = await signInPilot(page, guardianName, workspace);
  const records = view.getByRole("region", { name: "监护授权记录" });
  const [consent] = (await guardian.listGuardianConsents()).items;
  await expect(records.getByText(participantName)).toHaveCount(0);
  await records.getByRole("button", { name: "审核连接器授权" }).click();
  expect((await guardian.listGuardianConsents()).items[0].revision).toBe(consent.revision);
  await view.getByRole("button", { name: "确认监护授权" }).click();
  await expect(view.getByText("已授权此绑定。", { exact: true })).toBeVisible();

  const separate = await browser.newContext();
  try {
    const endpoint = await separate.newPage();
    const limited = await signInPilot(endpoint, participantName, workspace);
    await expect(limited.getByText("已满足试点连接器资格")).toBeVisible();
    await expect(limited.getByRole("region", { name: "监护授权记录" })).toHaveCount(0);
    const connection = await participant.authorizeSandboxConnector();
    if (connection.state !== "authorized") throw new Error("Expected active sandbox connector authorization");
    expect(connection.authorizationId).toBeTruthy();

    await page.bringToFront();
    await records.getByRole("button", { name: "撤回连接器授权" }).click();
    await view.getByRole("button", { name: "确认撤回授权" }).click();
    await expect(view.getByText("已撤回授权。", { exact: true })).toBeVisible();
    await expect(participant.createSandboxConnectorAction({ authorizationId: connection.authorizationId,
      kind: "fixture_notice", simulation: "acknowledged" }, randomUUID())).rejects.toMatchObject({ status: 403 });
    await endpoint.bringToFront();
    await limited.getByRole("button", { name: "刷新资格和授权" }).click();
    await expect(limited.getByText("需要当前监护授权")).toBeVisible();
  } finally {
    await separate.close();
  }
});
