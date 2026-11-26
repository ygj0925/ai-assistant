import { expect, test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { AssistantClient } from "@ai-assistant/contracts";

const run = promisify(execFile);
const password = "Qa.Published-png-fixture!";
const firstPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPgCsj8DwAC7gHDSedwyAAAAABJRU5ErkJggg==", "base64");
const secondPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNYZRLzHwAFAAI65LgxvgAAAABJRU5ErkJggg==", "base64");

async function signIn(page: Page, username: string) {
  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
}

test("publishes the reviewed PNG version and clears the viewer's preview after revocation", async ({ page, browser }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  const membershipScript = process.env.ASSISTANT_WEB_TEST_IMAGE_PUBLICATION_MEMBERSHIP;
  test.skip(!origin || !membershipScript, "Requires the isolated PNG publication and synthetic membership fixture.");
  test.setTimeout(70_000);
  const suffix = randomUUID().slice(0, 8);
  const ownerName = `qa-pngpub-owner-${suffix}`;
  const viewerName = `qa-pngpub-viewer-${suffix}`;
  const ownerApi = new AssistantClient({ origin: origin! });
  const viewerApi = new AssistantClient({ origin: origin! });
  const owner = await ownerApi.register({ username: ownerName, password });
  const viewer = await viewerApi.register({ username: viewerName, password });
  await ownerApi.replaceSession(owner);
  await viewerApi.replaceSession(viewer);
  const workspaceId = owner.user.workspaceId;
  await run("pwsh", ["-NoProfile", "-File", membershipScript!, "-Action", "add", "-OwnerWorkspace", workspaceId,
    "-OwnerAccount", owner.user.id, "-MemberAccount", viewer.user.id], { timeout: 15_000 });
  await viewerApi.switchWorkspace(workspaceId);
  const project = await ownerApi.createProject({ name: "合成图片协作项目" });
  const invitation = await ownerApi.inviteProjectMember(project.id, { recipientUsername: viewerName, role: "viewer" });
  await viewerApi.acceptProjectInvitation(invitation.id);
  const [one, two] = await Promise.all([firstPng, secondPng].map((bytes) => ownerApi.uploadProjectAttachment(project.id,
    new Blob([Uint8Array.from(bytes)], { type: "image/png" }), randomUUID())));
  await expect.poll(async () => (await ownerApi.listProjectAttachments(project.id)).items.filter(({ state }) => state === "approved").length,
    { timeout: 20_000 }).toBe(2);
  const draft = await ownerApi.createArtifact({ projectId: project.id, title: "已选图像版本", format: "image",
    image: { attachmentId: one.id, altText: "第一版获准图片" } }, randomUUID());
  await ownerApi.createArtifactVersion(draft.id, { baseVersionId: draft.head.id, title: "继续编辑的图像",
    image: { attachmentId: two.id, altText: "第二版私有图片" } });

  await signIn(page, ownerName);
  await page.getByRole("button", { name: "文稿", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "文稿" });
  await editor.getByRole("button", { name: "继续编辑的图像 · 版本 2" }).click();
  await editor.getByRole("button", { name: "版本 1", exact: true }).click();
  await editor.getByRole("button", { name: "预览发布版本 1" }).click();
  const confirmation = editor.getByRole("region", { name: "发布文稿版本" });
  const ownerPreview = confirmation.getByRole("img", { name: "第一版获准图片" });
  await expect.poll(() => ownerPreview.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
  expect((await viewerApi.listProjectArtifactPublications(project.id)).items).toEqual([]);
  await confirmation.getByRole("button", { name: "确认发布此版本" }).click();
  await expect(editor.getByText("版本 1 已发布到项目协作。")).toBeVisible();

  const [published] = (await viewerApi.listProjectArtifactPublications(project.id)).items;
  expect(published).toMatchObject({ title: "已选图像版本", format: "image", sizeBytes: firstPng.length, versionNumber: 1 });
  const detail = await viewerApi.getProjectArtifactPublication(project.id, published.id);
  expect(detail).toMatchObject({ image: { altText: "第一版获准图片", size: firstPng.length, width: 1, height: 1 } });
  const json = JSON.stringify(detail);
  for (const privateValue of [one.id, two.id, draft.id, draft.head.id, "第二版私有图片"]) expect(json).not.toContain(privateValue);
  await expect(viewerApi.getArtifact(draft.id)).rejects.toMatchObject({ status: 404 });

  const viewerContext = await browser.newContext();
  try {
    const reader = await viewerContext.newPage();
    await signIn(reader, viewerName);
    await reader.getByRole("button", { name: `账号与数据 · ${viewerName}` }).click();
    await reader.getByRole("button", { name: "切换工作空间" }).click();
    await reader.getByRole("dialog", { name: "切换工作空间" }).getByRole("button", { name: `工作空间 ${workspaceId.slice(0, 8)}` }).click();
    await reader.getByRole("button", { name: "项目协作", exact: true }).click();
    const collaboration = reader.getByRole("dialog", { name: "项目协作" });
    await collaboration.getByRole("button", { name: "合成图片协作项目 · 查看者" }).click();
    await collaboration.getByRole("button", { name: "已选图像版本 · 版本 1" }).click();
    await collaboration.getByRole("button", { name: "预览已发布图片" }).click();
    const image = collaboration.getByRole("img", { name: "第一版获准图片" });
    await expect(image).toHaveAttribute("src", /^blob:/);
    const downloaded = reader.waitForEvent("download");
    await collaboration.getByRole("button", { name: "下载已发布版本" }).click();
    const file = await downloaded;
    expect(file.suggestedFilename()).toBe("image.png");
    expect(await readFile(await file.path())).toEqual(firstPng);
    await file.delete();
    await ownerApi.revokeProjectInvitation(project.id, invitation.id);
    await expect(image).toHaveCount(0, { timeout: 13_000 });
    await expect(collaboration.getByText("第一版获准图片", { exact: true })).toHaveCount(0);
    await expect(viewerApi.downloadProjectArtifactPublication(project.id, published.id, "image")).rejects.toMatchObject({ status: 404 });
  } finally {
    await viewerContext.close();
  }
});
