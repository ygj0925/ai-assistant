import { expect, test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AssistantClient } from "@ai-assistant/contracts";

const run = promisify(execFile);
const password = "Qa.Organization-fixture!";

async function signIn(page: Page, username: string, loginPassword = password) {
  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(loginPassword);
  await page.getByRole("button", { name: "登录", exact: true }).click();
}

test("requires the owner to confirm a directory binding for the currently reviewed ordinary member", async ({ page }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  const fixturePath = process.env.ASSISTANT_WEB_TEST_SCIM_OWNER_FIXTURE;
  test.skip(!origin || !fixturePath, "Requires a preapproved isolated directory workspace and synthetic actor fixture.");
  const fixture = JSON.parse(await readFile(fixturePath!, "utf8")) as {
    workspaceId: string;
    owner: { username: string; password: string };
    member: { accountId: string; username: string; membershipRevision: string };
  };
  const writes: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/organizations/current/directory-bindings")) {
      writes.push(request.postDataJSON());
    }
  });
  await signIn(page, fixture.owner.username, fixture.owner.password);
  await chooseWorkspace(page, fixture.owner.username, fixture.workspaceId);
  await page.getByRole("button", { name: "组织与座席" }).click();
  const view = page.getByRole("dialog", { name: "组织与座席" }).getByRole("region", { name: "组织目录绑定" });
  await view.getByLabel("普通成员").selectOption(fixture.member.accountId);
  await view.getByLabel("目录用户 UUID").fill("invalid-entry");
  await view.getByRole("button", { name: "审核目录绑定" }).click();
  await expect(view.getByRole("alert")).toContainText("完整的目录用户 UUID");
  const externalId = fixture.member.accountId;
  await view.getByLabel("目录用户 UUID").fill(externalId);
  await view.getByRole("button", { name: "审核目录绑定" }).click();
  await expect(view.getByRole("group", { name: "目录绑定预览" })).toContainText(fixture.member.username);
  expect(writes).toEqual([]);
  const response = page.waitForResponse((candidate) => candidate.request().method() === "POST"
    && candidate.url().endsWith("/organizations/current/directory-bindings"));
  await view.getByRole("button", { name: "确认目录绑定" }).click();
  const receipt = await response;
  expect(receipt.status()).toBe(201);
  expect(writes).toEqual([{ accountId: fixture.member.accountId, membershipRevision: fixture.member.membershipRevision,
    externalId, confirm: true }]);
  expect(await receipt.json()).toMatchObject({ id: expect.any(String), directoryId: expect.any(String),
    externalId, membershipRevision: fixture.member.membershipRevision });
  await expect(view.getByRole("status")).toContainText("绑定已保存");
});

async function chooseWorkspace(page: Page, username: string, id: string) {
  await page.getByRole("button", { name: `账号与数据 · ${username}` }).click();
  await page.getByRole("button", { name: "切换工作空间" }).click();
  await page.getByRole("dialog", { name: "切换工作空间" })
    .getByRole("button", { name: `工作空间 ${id.slice(0, 8)}`, exact: true }).click();
}

test("uses the current organization role and clears a retired manager's roster", async ({ page, browser }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  const provision = process.env.ASSISTANT_WEB_TEST_ORGANIZATION_PROVISION;
  const policyEnabled = process.env.ASSISTANT_WEB_TEST_ORGANIZATION_POLICY === "true";
  const temporaryEnabled = process.env.ASSISTANT_WEB_TEST_TEMPORARY_POLICY === "true";
  const usageEnabled = process.env.ASSISTANT_WEB_TEST_ORGANIZATION_USAGE === "true";
  const budgetEnabled = process.env.ASSISTANT_WEB_TEST_ORGANIZATION_BUDGET === "true";
  test.skip(!origin || !provision, "Requires a synthetic organization and isolated operator provisioning fixture.");
  test.setTimeout(65_000);
  const suffix = randomUUID().slice(0, 8);
  const ownerName = `qa-org-owner-${suffix}`;
  const memberName = `qa-org-member-${suffix}`;
  const owner = new AssistantClient({ origin: origin! });
  const member = new AssistantClient({ origin: origin! });
  const ownerSession = await owner.register({ username: ownerName, password });
  const memberSession = await member.register({ username: memberName, password });
  await owner.replaceSession(ownerSession);
  await member.replaceSession(memberSession);

  const dir = await mkdtemp(join(tmpdir(), "assistant-organization-browser-"));
  const request = join(dir, "provision.json");
  const result = join(dir, "provisioned.json");
  let workspace: string;
  try {
    await writeFile(request, JSON.stringify({ ownerAccountId: ownerSession.user.id }), { flag: "wx" });
    await run(process.execPath, [provision!, dir], { timeout: 20_000 });
    workspace = (JSON.parse(await readFile(result, "utf8")) as { workspaceId: string }).workspaceId;
    expect(workspace).toMatch(/^[0-9a-f-]{36}$/);
  } finally {
    await unlink(request).catch(() => undefined);
    await unlink(result).catch(() => undefined);
    await rmdir(dir).catch(() => undefined);
  }
  const ownedWorkspace = (await owner.listWorkspaces()).items.find(({ id }) => id === workspace);
  expect(ownedWorkspace).toMatchObject({ canLeave: false });
  if (temporaryEnabled) {
    await expect(owner.replyToTemporaryChat("合成个人临时对话")).resolves.toMatchObject({ modelId: "local-echo" });
  }
  if (usageEnabled) {
    await expect(owner.getOrganizationUsage()).rejects.toMatchObject({ status: 404 });
    const personal = await owner.createConversation({ title: "合成个人用量对照" });
    const run = await owner.startRun(personal.id, { action: "send", modelId: "local-echo", content: "个人工作空间的合成用量" }, randomUUID());
    await expect.poll(async () => (await owner.getRunSnapshot(run.runId)).state).toBe("completed");
  }
  await owner.switchWorkspace(workspace);
  await signIn(page, ownerName);
  await expect(page.getByRole("button", { name: "组织与座席" })).toHaveCount(0);
  await page.getByRole("button", { name: `账号与数据 · ${ownerName}` }).click();
  await page.getByRole("button", { name: "切换工作空间" }).click();
  const workspaces = page.getByRole("dialog", { name: "切换工作空间" });
  await expect(workspaces.getByRole("button", { name: `工作空间 ${workspace.slice(0, 8)}`, exact: true })).toBeVisible();
  await expect(workspaces.getByRole("button", { name: `退出 工作空间 ${workspace.slice(0, 8)}`, exact: true })).toHaveCount(0);
  await workspaces.getByRole("button", { name: `工作空间 ${workspace.slice(0, 8)}`, exact: true }).click();
  await page.getByRole("button", { name: "组织与座席" }).click();
  const ownerPanel = page.getByRole("dialog", { name: "组织与座席" });
  await expect(ownerPanel.getByText(/你的角色 所有者/)).toBeVisible();
  await ownerPanel.getByLabel("成员账号标识").fill(memberSession.user.id);
  await ownerPanel.getByRole("combobox", { name: "加入角色" }).selectOption("admin");
  await ownerPanel.getByRole("button", { name: "审核添加成员" }).click();
  expect((await owner.listOrganizationMembers()).items.some(({ accountId }) => accountId === memberSession.user.id)).toBe(false);
  await ownerPanel.getByRole("button", { name: "确认组织变更" }).click();
  await expect(ownerPanel.getByText(/座席已使用 2\//)).toBeVisible();
  const row = ownerPanel.getByRole("region", { name: "组织成员" }).getByRole("listitem").filter({ hasText: memberName });

  await member.switchWorkspace(workspace);
  const project = await member.createProject({ name: "角色变动保留的私有项目" });
  if (usageEnabled) {
    const conversation = await member.createConversation({ title: "合成组织结算" });
    const input = { action: "send", modelId: "local-echo", content: "合成组织工作空间用量" } as const;
    const key = randomUUID();
    const run = await member.startRun(conversation.id, input, key);
    await expect.poll(async () => (await member.getRunSnapshot(run.runId)).state).toBe("completed");
    expect((await member.startRun(conversation.id, input, key)).runId).toBe(run.runId);
    const current = await owner.getOrganizationUsage(30);
    expect(current).toMatchObject({ timeZone: "UTC", periodDays: 30 });
    expect(current.items).toHaveLength(30);
    expect(current.items.at(-1)).toMatchObject({ submittedRuns: 1, completedRuns: 1, reservedUnits: 0 });
    expect(current.items.at(-1)?.settledUnits).toBeGreaterThan(0);
    expect(Object.keys(current.items.at(-1)!).sort()).toEqual(["completedRuns", "date", "reservedUnits", "settledUnits", "submittedRuns"]);
    expect(new Set(current.items.map(({ date }) => date)).size).toBe(30);
  }
  const peer = await browser.newContext();
  try {
    const second = await peer.newPage();
    await signIn(second, memberName);
    await chooseWorkspace(second, memberName, workspace);
    await second.getByRole("button", { name: "组织与座席" }).click();
    const view = second.getByRole("dialog", { name: "组织与座席" });
    await expect(view.getByText(/你的角色 管理员/)).toBeVisible();
    await expect(view.getByRole("region", { name: "组织审计" })).toBeVisible();
    await expect(view.getByRole("region", { name: "组织模型与连接器策略" })).toHaveCount(0);
    await expect(member.getOrganizationPolicy()).rejects.toMatchObject({ status: 403 });
    if (budgetEnabled) {
      await expect(view.getByRole("region", { name: "组织模型用量上限" })).toHaveCount(0);
      await expect(member.getOrganizationModelBudget()).rejects.toMatchObject({ status: 403 });
    }
    if (usageEnabled) {
      const usage = view.getByRole("region", { name: "组织用量" });
      await usage.getByRole("button", { name: "查看组织用量" }).click();
      await expect(usage.getByRole("table")).toBeVisible();
      await expect(usage.getByRole("row")).toHaveCount(8);
    }
    await page.bringToFront();
    await row.getByRole("button", { name: "设为成员" }).click();
    await ownerPanel.getByRole("button", { name: "确认组织变更" }).click();
    await expect(row.getByText("成员", { exact: true })).toBeVisible();
    await second.bringToFront();
    await view.getByRole("button", { name: "刷新组织权限" }).click();
    await expect(view.getByText(/你的角色 成员/)).toBeVisible();
    await expect(view.getByRole("region", { name: "组织成员" })).toHaveCount(0);
    await expect(view.getByRole("region", { name: "组织审计" })).toHaveCount(0);
    if (usageEnabled) await expect(member.getOrganizationUsage()).rejects.toMatchObject({ status: 403 });
    await expect(view.getByRole("region", { name: "组织用量" })).toHaveCount(0);
    expect((await member.getProject(project.id)).id).toBe(project.id);
    await expect(member.listOrganizationMembers()).rejects.toMatchObject({ status: 403 });
    await page.bringToFront();
    if (budgetEnabled) {
      const limits = ownerPanel.getByRole("region", { name: "组织模型用量上限" });
      const read = limits.getByRole("button", { name: "读取用量上限", exact: true });
      const editMode = limits.getByLabel("用量控制");
      const max = limits.getByLabel("每月输出上限");
      const review = limits.getByRole("button", { name: "审核用量上限变更" });
      const commit = limits.getByRole("button", { name: "确认用量上限变更" });
      await read.click();
      const initial = await owner.getOrganizationModelBudget();
      expect(initial).toMatchObject({ monthlyLimitUnits: null, availableUnits: null, timeZone: "UTC", unit: "output_code_points" });
      await editMode.selectOption("on");
      await max.fill("1.4");
      await review.click();
      await expect(limits.getByRole("alert")).toContainText("之间的整数");
      await max.fill("0");
      await review.click();
      await expect(limits.getByText("保存后将暂停此组织的新模型运行。")).toBeVisible();
      expect((await owner.getOrganizationModelBudget()).revision).toBe(initial.revision);
      await owner.updateOrganizationModelBudget({ baseRevision: initial.revision, monthlyLimitUnits: 8192, confirm: true });
      await commit.click();
      await expect(limits.getByRole("alert")).toContainText("组织用量上限已变更");
      await read.click();
      await expect(max).toHaveValue("8192");
      await max.fill("0");
      await review.click();
      await commit.click();
      await expect(limits.getByText("组织模型用量上限已更新。", { exact: true })).toBeVisible();
      const conversation = await member.createConversation({ title: "合成组织预算对照" });
      const input = { action: "send", modelId: "local-echo", content: "组织预算为零" } as const;
      await expect(member.startRun(conversation.id, input, randomUUID())).rejects.toMatchObject({
        status: 429, code: "ORGANIZATION_BUDGET_EXHAUSTED",
      });
      if (temporaryEnabled) {
        await expect(member.replyToTemporaryChat("未进入账本的合成临时对话")).rejects.toMatchObject({
          status: 403, code: "ORGANIZATION_BUDGET_TEMPORARY_UNSUPPORTED",
        });
      }
      await editMode.selectOption("off");
      await review.click();
      await expect(limits.getByText("将移除组织用量上限。")).toBeVisible();
      await commit.click();
      await expect.poll(async () => (await owner.getOrganizationModelBudget()).monthlyLimitUnits).toBeNull();
      await expect(ownerPanel.getByRole("region", { name: "组织审计" }).getByText("变更模型用量上限").first()).toBeVisible();
    }
    if (policyEnabled) {
      const policy = ownerPanel.getByRole("region", { name: "组织模型与连接器策略" });
      await policy.getByRole("button", { name: "读取组织策略", exact: true }).click();
      await expect(policy.getByText("尚未配置组织模型列表，使用部署允许的模型。")).toBeVisible();
      const initial = await owner.getOrganizationPolicy();
      const models = policy.getByLabel("允许的模型标识");
      await models.fill("invalid id");
      await policy.getByRole("button", { name: "审核策略变更" }).click();
      await expect(policy.getByRole("alert")).toBeVisible();
      await models.clear();
      await policy.getByRole("checkbox", { name: "允许沙箱连接器" }).uncheck();
      await policy.getByRole("button", { name: "审核策略变更" }).click();
      await expect(policy.getByText("所有模型调用将被拒绝。")).toBeVisible();
      expect((await owner.getOrganizationPolicy()).revision).toBe(initial.revision);
      await owner.updateOrganizationPolicy({ baseRevision: initial.revision, allowedModelIds: ["local-echo"],
        sandboxConnectorAllowed: false, confirm: true });
      await policy.getByRole("button", { name: "确认策略变更" }).click();
      await expect(policy.getByRole("alert")).toContainText("组织策略已变化");
      await policy.getByRole("button", { name: "读取组织策略", exact: true }).click();
      await expect(models).toHaveValue("local-echo");
      await models.clear();
      await policy.getByRole("button", { name: "审核策略变更" }).click();
      await policy.getByRole("button", { name: "确认策略变更" }).click();
      await expect(policy.getByText("组织策略已更新。", { exact: true })).toBeVisible();
      await expect(member.listModels()).resolves.toEqual({ models: [] });
      if (temporaryEnabled) {
        const { capabilities } = await member.getCapabilities();
        expect(capabilities).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: "text_chat", available: false, reason: "ORGANIZATION_POLICY_DENIED" }),
          expect.objectContaining({ id: "temporary_chat", available: false }),
        ]));
        await expect(member.replyToTemporaryChat("合成已拒绝临时对话")).rejects.toMatchObject({
          status: 403, code: "ORGANIZATION_POLICY_DENIED",
        });
      }
      await expect(ownerPanel.getByRole("region", { name: "组织审计" }).getByText(/变更组织策略/).first()).toBeVisible();
    }
    await row.getByRole("button", { name: "撤回成员权限" }).click();
    await ownerPanel.getByRole("button", { name: "确认组织变更" }).click();
    await expect(row).toHaveCount(0);
    await second.bringToFront();
    await view.getByRole("button", { name: "刷新组织权限" }).click();
    await expect(view.getByRole("alert")).toBeVisible();
    await expect(view.getByRole("region", { name: "组织摘要" })).toHaveCount(0);
    await expect(member.getProject(project.id)).rejects.toMatchObject({ status: 403 });
    const audit = await owner.listOrganizationAudit();
    expect(audit.items.map(({ action }) => action)).toEqual(expect.arrayContaining(["member_added", "role_changed", "member_revoked"]));
  } finally {
    await peer.close();
  }
});
