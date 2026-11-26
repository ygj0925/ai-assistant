import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AssistantClient } from "@ai-assistant/contracts";

const password = "Qa.Collaboration-fixture!";

async function signIn(page: Page, username: string) {
  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
}

test("grants an explicit viewer role and drops shared text after revocation", async ({ page, browser }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  const fixture = process.env.ASSISTANT_WEB_TEST_COLLABORATION_FIXTURE;
  test.skip(!origin || !fixture, "Requires an isolated database that can add a synthetic workspace member.");
  test.setTimeout(60_000);
  const suffix = Date.now().toString(36);
  const ownerName = `qa-collab-owner-${suffix}`;
  const readerName = `qa-collab-reader-${suffix}`;
  const ownerApi = new AssistantClient({ origin: origin! });
  const readerApi = new AssistantClient({ origin: origin! });
  const owner = await ownerApi.register({ username: ownerName, password });
  const reader = await readerApi.register({ username: readerName, password });
  await ownerApi.replaceSession(owner);
  await readerApi.replaceSession(reader);
  const workspaceId = owner.user.workspaceId;
  const project = await ownerApi.createProject({ name: "合成协作项目" });
  const withComments = process.env.ASSISTANT_WEB_TEST_ARTIFACT_COMMENTS === "true";
  const withPublication = withComments || process.env.ASSISTANT_WEB_TEST_ARTIFACT_PUBLICATIONS === "true";
  const publishedText = "# 可见的旧版本\n合成范围 🦀\n";
  const privateText = await ownerApi.createProjectResource(project.id,
    { name: "未公开的资料", content: "SYNTHETIC_PRIVATE_PROJECT_ONLY" });
  const marker = join(fixture!, "add.json");
  await writeFile(marker + ".tmp", JSON.stringify({ workspaceId, ownerId: owner.user.id, readerId: reader.user.id }), { flag: "wx" });
  await rename(marker + ".tmp", marker);
  await expect.poll(() => access(join(fixture!, "added.json")).then(() => true, () => false), { timeout: 20_000 }).toBe(true);
  await readerApi.switchWorkspace(workspaceId);

  await signIn(page, ownerName);
  if (withPublication) {
    const draft = await ownerApi.createArtifact({
      projectId: project.id, title: "合成共享文稿", format: "markdown", content: publishedText,
    }, randomUUID());
    await ownerApi.createArtifactVersion(draft.id,
      { baseVersionId: draft.head.id, title: draft.title, content: "作者私下继续编辑的新版本" });
    await page.getByRole("button", { name: "文稿", exact: true }).click();
    const artifact = page.getByRole("dialog", { name: "文稿" });
    await artifact.getByRole("button", { name: "合成共享文稿 · 版本 2" }).click();
    await artifact.getByRole("button", { name: "版本 1", exact: true }).click();
    await artifact.getByRole("button", { name: "预览发布版本 1" }).click();
    await expect(artifact.getByRole("region", { name: "发布文稿版本" })).toContainText("合成范围 🦀");
    await artifact.getByRole("button", { name: "确认发布此版本" }).click();
    await expect(artifact.getByText("版本 1 已发布到项目协作。")).toBeVisible();
    await artifact.getByRole("button", { name: "关闭", exact: true }).click();
  }
  await page.getByRole("button", { name: "项目协作", exact: true }).click();
  const owned = page.getByRole("dialog", { name: "项目协作" });
  await owned.getByRole("button", { name: "合成协作项目 · 所有者" }).click();
  await owned.getByLabel("共享资料名称").fill("公开给协作成员");
  await owned.getByLabel("共享资料正文").fill("仅共享此段合成文字。");
  await owned.getByRole("button", { name: "新增共享资料" }).click();
  await expect(owned.getByText("资料已加入协作区。")).toBeVisible();
  await owned.getByLabel("同工作空间用户名").fill(readerName);
  await owned.getByRole("button", { name: "发出邀请" }).click();
  await expect(owned.getByText("邀请已发出。")).toBeVisible();

  const context = await browser.newContext();
  try {
    const readerPage = await context.newPage();
    await signIn(readerPage, readerName);
    await readerPage.getByRole("button", { name: `账号与数据 · ${readerName}` }).click();
    await readerPage.getByRole("button", { name: "切换工作空间" }).click();
    await readerPage.getByRole("dialog", { name: "切换工作空间" })
      .getByRole("button", { name: `工作空间 ${workspaceId.slice(0, 8)}` }).click();
    await readerPage.getByRole("button", { name: "项目协作", exact: true }).click();
    const received = readerPage.getByRole("dialog", { name: "项目协作" });
    await received.getByRole("button", { name: "接受邀请" }).click();
    await expect(received.getByRole("heading", { name: "合成协作项目 · 查看者" })).toBeVisible();
    await expect(received.getByLabel("共享资料正文")).toHaveCount(0);
    await received.getByRole("button", { name: "公开给协作成员" }).click();
    await expect(received.getByText("仅共享此段合成文字。")).toBeVisible();
    await expect(received.getByText("未公开的资料")).toHaveCount(0);
    await expect(readerApi.getProjectResource(project.id, privateText.id)).rejects.toMatchObject({ status: 404 });

    if (withPublication) {
      const reading = received.getByRole("region", { name: "已发布文稿" });
      await reading.getByRole("button", { name: "合成共享文稿 · 版本 1" }).click();
      await expect(reading.getByRole("region", { name: "已发布文稿内容" })).toContainText("合成范围 🦀");
      await expect(reading.getByText("作者私下继续编辑的新版本")).toHaveCount(0);
      await expect(reading.getByRole("button", { name: "撤回已发布版本" })).toHaveCount(0);
      const [publication] = (await readerApi.listProjectArtifactPublications(project.id)).items;
      expect(await (await readerApi.downloadProjectArtifactPublication(project.id, publication.id, publication.format)).text())
        .toBe(publishedText);
      const requested = readerPage.waitForEvent("download");
      await reading.getByRole("button", { name: "下载已发布版本" }).click();
      const download = await requested;
      expect(download.suggestedFilename()).toBe("artifact.md");
      expect(await readFile(await download.path())).toEqual(Buffer.from(publishedText, "utf8"));
      await download.delete();

      const publishing = owned.getByRole("region", { name: "已发布文稿" });
      await publishing.getByRole("button", { name: "合成共享文稿 · 版本 1" }).click();
      if (withComments) {
        const ownerComments = publishing.getByRole("region", { name: "版本评论" });
        const viewerComments = reading.getByRole("region", { name: "版本评论" });
        const message = "这一条合成评论只关联到发布版本 1。";
        await ownerComments.getByLabel("评论正文").fill(message);
        await ownerComments.getByRole("button", { name: "提交评论" }).click();
        await expect(ownerComments.getByText(message, { exact: true })).toBeVisible();
        await viewerComments.getByRole("button", { name: "刷新评论" }).click();
        await expect(viewerComments.getByText(message, { exact: true })).toBeVisible();
        await expect(viewerComments.getByLabel("评论正文")).toHaveCount(0);
        await expect(readerApi.createArtifactPublicationComment(project.id, publication.id, "未授权", randomUUID()))
          .rejects.toMatchObject({ status: 403 });
        await ownerComments.getByRole("button", { name: "删除评论", exact: true }).click();
        await ownerComments.getByRole("button", { name: "确认删除评论" }).click();
        await expect(ownerComments.getByText(message, { exact: true })).toHaveCount(0);
        await viewerComments.getByRole("button", { name: "刷新评论" }).click();
        await expect(viewerComments.getByText("此版本暂无评论。")).toBeVisible();
      }
      await publishing.getByRole("button", { name: "撤回已发布版本" }).click();
      await publishing.getByRole("button", { name: "确认撤回版本" }).click();
      await expect(owned.getByText("已撤回文稿版本。")).toBeVisible();
      await received.getByRole("button", { name: "刷新项目协作" }).click();
      await expect(reading.getByRole("button", { name: "合成共享文稿 · 版本 1" })).toHaveCount(0);
      await expect(readerApi.downloadProjectArtifactPublication(project.id, publication.id, publication.format)).rejects
        .toMatchObject({ status: 404 });
    }

    const [record] = (await readerApi.listSharedProjectMaterials(project.id)).items;
    await owned.getByRole("button", { name: "撤销授权", exact: true }).click();
    await owned.getByRole("button", { name: "确认撤销授权" }).click();
    await expect(owned.getByRole("list", { name: "邀请和成员" })).toHaveCount(0);
    await received.getByRole("button", { name: "刷新项目协作" }).click();
    await expect(received.getByText("仅共享此段合成文字。")).toHaveCount(0);
    await expect(received.getByRole("button", { name: "合成协作项目 · 查看者" })).toHaveCount(0);
    await expect(readerApi.getSharedProjectMaterial(project.id, record.id)).rejects.toMatchObject({ status: 404 });
  } finally {
    await context.close();
    await writeFile(join(fixture!, "finished.json"), "{}");
  }
});
