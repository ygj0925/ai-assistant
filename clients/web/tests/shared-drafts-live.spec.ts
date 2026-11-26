import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AssistantClient } from "@ai-assistant/contracts";

const password = "Qa.SharedDraft-fixture!";
const title = "共享编辑样例";
const original = "# 共享文稿\n第一版 🦀\n";

async function login(page: Page, username: string) {
  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("button", { name: `账号与数据 · ${username}` })).toBeVisible();
}

test("retains a losing editor draft, restores Markdown and clears revoked access", async ({ page, browser }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  const fixture = process.env.ASSISTANT_WEB_TEST_COLLABORATION_FIXTURE;
  test.skip(!origin || !fixture || process.env.ASSISTANT_WEB_TEST_SHARED_DRAFTS !== "true", "Requires the isolated shared draft API and synthetic workspace membership.");
  test.setTimeout(65_000);
  const suffix = randomUUID().slice(0, 8);
  const ownerName = `qa-draft-owner-${suffix}`;
  const editorName = `qa-draft-editor-${suffix}`;
  const ownerApi = new AssistantClient({ origin: origin! });
  const editorApi = new AssistantClient({ origin: origin! });
  const owner = await ownerApi.register({ username: ownerName, password });
  const editor = await editorApi.register({ username: editorName, password });
  await ownerApi.replaceSession(owner);
  await editorApi.replaceSession(editor);
  const workspaceId = owner.user.workspaceId;
  const project = await ownerApi.createProject({ name: "共编验证项目" });
  const marker = join(fixture!, "add.json");
  await writeFile(marker + ".tmp", JSON.stringify({ workspaceId, ownerId: owner.user.id, readerId: editor.user.id }), { flag: "wx" });
  await rename(marker + ".tmp", marker);
  await expect.poll(() => access(join(fixture!, "added.json")).then(() => true, () => false), { timeout: 20_000 }).toBe(true);
  await editorApi.switchWorkspace(workspaceId);
  const invitation = await ownerApi.inviteProjectMember(project.id, { recipientUsername: editorName, role: "editor" });

  await login(page, ownerName);
  await page.getByRole("button", { name: "项目协作", exact: true }).click();
  const ownerProject = page.getByRole("dialog", { name: "项目协作" });
  await ownerProject.getByRole("button", { name: "共编验证项目 · 所有者" }).click();
  const owned = ownerProject.getByRole("region", { name: "共享文稿", exact: true });
  await owned.getByRole("button", { name: "新建共享文稿" }).click();
  await owned.getByLabel("共享文稿标题").fill(title);
  await owned.getByLabel("共享文稿正文").fill(original);
  const create = owned.getByRole("button", { name: "创建共享文稿" });
  await expect(create).toBeDisabled();
  await owned.getByRole("checkbox", { name: "确认对此项目的协作成员共享" }).check();
  await create.click();
  await expect(owned.getByText("共享文稿已创建。")).toBeVisible();
  const [artifact] = (await ownerApi.listProjectSharedDrafts(project.id)).items;

  const context = await browser.newContext();
  try {
    const other = await context.newPage();
    await login(other, editorName);
    await other.getByRole("button", { name: `账号与数据 · ${editorName}` }).click();
    await other.getByRole("button", { name: "切换工作空间" }).click();
    await other.getByRole("dialog", { name: "切换工作空间" })
      .getByRole("button", { name: `工作空间 ${workspaceId.slice(0, 8)}` }).click();
    await other.getByRole("button", { name: "项目协作", exact: true }).click();
    const editorProject = other.getByRole("dialog", { name: "项目协作" });
    await editorProject.getByRole("button", { name: "接受邀请" }).click();
    const shared = editorProject.getByRole("region", { name: "共享文稿", exact: true });
    await shared.getByRole("button", { name: `${title} · 版本 1`, exact: true }).click();
    await owned.getByRole("button", { name: "编辑当前版本" }).click();
    await shared.getByRole("button", { name: "编辑当前版本" }).click();
    await owned.getByLabel("共享文稿正文").fill("作者已确认的第二版");
    await shared.getByLabel("共享文稿正文").fill("编辑者未保存的内容");
    await owned.getByRole("button", { name: "保存共享版本" }).click();
    await expect(owned.getByText("新版本已保存。")).toBeVisible();
    await shared.getByRole("button", { name: "保存共享版本" }).click();
    await expect(shared.getByRole("alert")).toContainText("文稿版本已变化");
    await expect(shared.getByLabel("共享文稿正文")).toHaveValue("编辑者未保存的内容");
    await expect(shared.getByRole("button", { name: "保存共享版本" })).toBeDisabled();
    await shared.getByRole("button", { name: "刷新共享文稿" }).click();
    await expect(shared.getByLabel("当前版本内容")).toContainText("作者已确认的第二版");
    await shared.getByLabel("共享文稿正文").fill("合并：作者已确认的第二版，加上编辑者内容");
    await shared.getByRole("button", { name: "已核对，以最新版本为基线" }).click();
    await shared.getByRole("button", { name: "保存共享版本" }).click();
    await expect(shared.getByRole("heading", { name: `${title} · 版本 3` })).toBeVisible();

    await shared.getByRole("list", { name: "共享文稿版本" }).getByRole("button", { name: "版本 1", exact: true }).click();
    const history = shared.getByRole("region", { name: "历史版本内容" });
    const pending = other.waitForEvent("download");
    await history.getByRole("button", { name: "下载版本 1" }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe("shared-draft.md");
    expect(await readFile(await download.path())).toEqual(Buffer.from(original, "utf8"));
    await download.delete();
    await history.getByRole("button", { name: "恢复此版本" }).click();
    await shared.getByRole("button", { name: "确认恢复版本" }).click();
    await expect(shared.getByRole("heading", { name: `${title} · 版本 4` })).toBeVisible();
    await expect(shared.getByLabel("当前版本内容")).toContainText("第一版 🦀");

    await ownerApi.revokeProjectInvitation(project.id, invitation.id);
    await shared.getByRole("button", { name: "刷新共享文稿" }).click();
    await expect(shared.getByLabel("当前版本内容")).toHaveCount(0);
    await expect(shared.getByRole("button", { name: "编辑当前版本" })).toHaveCount(0);
    await expect(editorApi.downloadProjectSharedDraftRevision(project.id, artifact.id, artifact.revisionId))
      .rejects.toMatchObject({ status: 404 });
  } finally {
    await context.close();
  }
});
