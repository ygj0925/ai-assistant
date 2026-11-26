import { expect, test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { AssistantClient } from "@ai-assistant/contracts";

const run = promisify(execFile);
const password = "Qa.Typed-publication-fixture!";

async function signIn(page: Page, username: string) {
  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
}

test("links a reviewed typed draft to a reply and preserves the exact approved collaboration versions", async ({ page, browser }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  const membership = process.env.ASSISTANT_WEB_TEST_TYPED_PUBLICATION_MEMBERSHIP;
  test.skip(!origin || !membership, "Requires isolated typed publications, local generation and synthetic project membership.");
  test.setTimeout(80_000);
  const suffix = randomUUID().slice(0, 8);
  const ownerName = `qa-office-owner-${suffix}`;
  const viewerName = `qa-office-viewer-${suffix}`;
  const owner = new AssistantClient({ origin: origin! });
  const viewer = new AssistantClient({ origin: origin! });
  const ownerSession = await owner.register({ username: ownerName, password });
  const viewerSession = await viewer.register({ username: viewerName, password });
  await owner.replaceSession(ownerSession);
  await viewer.replaceSession(viewerSession);
  const { workspaceId } = ownerSession.user;
  await run("pwsh", ["-NoProfile", "-File", membership!, "-Action", "add", "-OwnerWorkspace", workspaceId,
    "-OwnerAccount", ownerSession.user.id, "-MemberAccount", viewerSession.user.id], { timeout: 15_000 });
  await viewer.switchWorkspace(workspaceId);
  const project = await owner.createProject({ name: "同范围文稿项目" });
  const other = await owner.createProject({ name: "禁止串用的项目" });
  const invitation = await owner.inviteProjectMember(project.id, { role: "viewer", recipientUsername: viewerName });
  await viewer.acceptProjectInvitation(invitation.id);
  const chat = await owner.createConversation({ title: "来源回复验收", projectId: project.id });
  const { runId } = await owner.startRun(chat.id, { action: "send", modelId: "local-echo", content: "合成回复说明" }, randomUUID());
  await expect.poll(async () => (await owner.getRunSnapshot(runId)).state, { timeout: 20_000 }).toBe("completed");
  const [reply] = (await owner.listMessages(chat.id)).items.filter(({ role }) => role === "assistant");

  await signIn(page, ownerName);
  await page.getByRole("button", { name: /^来源回复验收/ }).click();
  await page.getByRole("button", { name: "保存为文稿", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "文稿" });
  await panel.getByLabel("文件格式").selectOption("code");
  await panel.getByLabel("文稿标题").fill("选定回复的代码样例");
  await panel.getByLabel("代码语言").selectOption("javascript");
  const source = 'const title = "合成代码";\n';
  await panel.getByLabel("源码").fill(source);
  await expect(panel.getByRole("button", { name: "创建代码稿" })).toBeDisabled();
  await panel.getByText("查看来源回复", { exact: true }).click();
  await expect(panel.getByText("合成回复说明", { exact: false })).toBeVisible();
  await panel.getByRole("checkbox", { name: "确认保存以上内容并关联这条回复" }).check();
  await panel.getByRole("button", { name: "创建代码稿" }).click();
  await expect(panel.getByText("已保存版本 1。")).toBeVisible();
  const owned = (await owner.listArtifacts({ projectId: project.id })).items.find(({ format }) => format === "code")!;
  expect(owned.sourceMessageId).toBe(reply.id);
  await panel.getByRole("button", { name: "预览发布当前版本" }).click();
  await panel.getByRole("button", { name: "确认发布此版本" }).click();
  await expect(panel.getByText("版本 1 已发布到项目协作。")).toBeVisible();
  const [first] = (await viewer.listProjectArtifactPublications(project.id)).items;
  await owner.createArtifactVersion(owned.id, { baseVersionId: owned.headVersionId, title: "所有者新编辑",
    code: { language: "javascript", source: "const private = 42;\n" } });
  const sheet = await owner.createArtifact({ projectId: project.id, title: "合成工作表", format: "sheet",
    sheet: { name: "样表", rows: [["=1+2", true, 12.5]] } }, randomUUID());
  const slides = await owner.createArtifact({ projectId: project.id, title: "合成幻灯片", format: "slides",
    presentation: { slides: [{ title: "公开的幻灯片标题", bullets: ["保留原要点"] }] } }, randomUUID());
  await owner.publishProjectArtifact(project.id, { confirm: true, artifactId: sheet.id, versionId: sheet.head.id });
  await owner.publishProjectArtifact(project.id, { confirm: true, artifactId: slides.id, versionId: slides.head.id });

  const context = await browser.newContext();
  try {
    const reader = await context.newPage();
    await signIn(reader, viewerName);
    await reader.getByRole("button", { name: `账号与数据 · ${viewerName}` }).click();
    await reader.getByRole("button", { name: "切换工作空间" }).click();
    await reader.getByRole("dialog", { name: "切换工作空间" }).getByRole("button", { name: `工作空间 ${workspaceId.slice(0, 8)}` }).click();
    await reader.getByRole("button", { name: "项目协作", exact: true }).click();
    const dialog = reader.getByRole("dialog", { name: "项目协作" });
    await dialog.getByRole("button", { name: "同范围文稿项目 · 查看者" }).click();
    const detail = dialog.getByRole("region", { name: "已发布文稿内容" });
    async function bytes(expectedName: string) {
      const pending = reader.waitForEvent("download");
      await detail.getByRole("button", { name: "下载已发布版本" }).click();
      const file = await pending;
      expect(file.suggestedFilename()).toBe(expectedName);
      const contents = await readFile(await file.path());
      await file.delete();
      return contents;
    }

    await dialog.getByRole("button", { name: "合成工作表 · 版本 1" }).click();
    await expect(detail.getByText("=1+2", { exact: true })).toBeVisible();
    expect((await bytes("artifact.xlsx")).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 3, 4]));
    await dialog.getByRole("button", { name: "合成幻灯片 · 版本 1" }).click();
    await expect(detail.getByText("公开的幻灯片标题", { exact: true })).toBeVisible();
    expect((await bytes("artifact.pptx")).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 3, 4]));
    await dialog.getByRole("button", { name: "选定回复的代码样例 · 版本 1" }).click();
    await expect(detail.getByText('const title = "合成代码";', { exact: false })).toBeVisible();
    await expect(detail.getByText("所有者新编辑")).toHaveCount(0);
    expect(await bytes("artifact.js.txt")).toEqual(Buffer.from(source, "utf8"));
    const shared = await viewer.getProjectArtifactPublication(project.id, first.id);
    expect(JSON.stringify(shared)).not.toContain(reply.id);
    await owner.moveConversation(chat.id, other.id);
    await owner.moveConversation(chat.id, project.id);
    await expect(detail).toHaveCount(0, { timeout: 13_000 });
    await expect(viewer.downloadProjectArtifactPublication(project.id, first.id, "code")).rejects.toMatchObject({ status: 404 });
    expect((await owner.getArtifact(owned.id)).head.number).toBe(2);
  } finally {
    await context.close();
  }
});
