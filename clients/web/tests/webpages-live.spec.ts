import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AssistantClient } from "@ai-assistant/contracts";

test("previews a versioned private webpage in isolation and copies it into a new draft", async ({ page }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  test.skip(!origin || process.env.ASSISTANT_WEB_TEST_WEBPAGES !== "true", "Requires the private webpage preview API.");
  const username = `qa-webpage-web-${randomUUID().slice(0, 8)}`;
  const password = "Qa.WebDraft-fixture!";
  const client = new AssistantClient({ origin: origin! });
  await client.replaceSession(await client.register({ username, password }));
  const project = await client.createProject({ name: "合成网页项目" });
  const fixtureUrl = "http://127.0.0.1:39997/website-preview-asset";
  const source = `合成示例 <img src="${fixtureUrl}"> 🦀`;
  let resourceRequests = 0;
  await page.route(fixtureUrl, (route) => { resourceRequests++; return route.abort(); });

  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "文稿", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "文稿" });
  await dialog.getByLabel("文件格式").selectOption("webpage");
  await dialog.getByLabel("所属项目").selectOption(project.id);
  await dialog.getByLabel("文稿标题").fill("私有版式");
  await dialog.getByLabel("网页标题").fill("合作报告");
  await dialog.getByLabel("网页简介").fill("用于设备检查的合成内容");
  await dialog.getByLabel("小节标题").fill("第一节");
  await dialog.getByLabel("第 1 段").fill(source);
  await dialog.getByRole("button", { name: "创建网页草案" }).click();
  await expect(dialog.getByText("已保存版本 1。")).toBeVisible();

  const previewEndpoint = page.waitForResponse((reply) => reply.url().endsWith("/preview"));
  await dialog.getByRole("button", { name: "预览已保存网页" }).click();
  const response = await previewEndpoint;
  expect(response.status()).toBe(200);
  expect(response.headers()["content-security-policy"]).toContain("default-src 'none'");
  expect(response.headers()["cache-control"]).toBe("no-store");
  const frame = dialog.locator('iframe[title="已保存网页"]');
  await expect(frame).toHaveAttribute("sandbox", "");
  await expect(frame.contentFrame().getByRole("heading", { name: "合作报告" })).toBeVisible();
  await expect(frame.contentFrame().getByText(source, { exact: true })).toBeVisible();
  await expect(frame.contentFrame().locator("img, script, a, form")).toHaveCount(0);
  expect(await frame.evaluate((element: HTMLIFrameElement) => element.contentDocument)).toBeNull();
  expect(resourceRequests).toBe(0);
  await dialog.getByRole("button", { name: "关闭网页预览" }).click();

  const pending = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载当前版本" }).click();
  const file = await pending;
  expect(file.suggestedFilename()).toBe("artifact-1.html");
  const html = await readFile(await file.path(), "utf8");
  expect(html).toContain("&lt;img src=");
  expect(html).not.toContain("<img src=");
  await file.delete();

  await dialog.getByLabel("网页标题").fill("原版的修订标题");
  await dialog.getByRole("button", { name: "保存新版本" }).click();
  await expect(dialog.getByText("已保存版本 2。")).toBeVisible();
  await dialog.getByRole("button", { name: "版本 1", exact: true }).click();
  await dialog.getByRole("button", { name: "复制为独立网页草案" }).click();
  await expect(dialog.getByLabel("网页标题")).toHaveValue("合作报告");
  await dialog.getByLabel("文稿标题").fill("独立改写版式");
  await dialog.getByRole("button", { name: "创建网页草案" }).click();
  await expect(dialog.getByText("已保存版本 1。")).toBeVisible();
  expect((await client.listArtifacts({ projectId: project.id })).items).toEqual(expect.arrayContaining([
    expect.objectContaining({ title: "私有版式", headVersionNumber: 2 }),
    expect.objectContaining({ title: "独立改写版式", headVersionNumber: 1 }),
  ]));
});

test("generates a static webpage from a completed reply and retires it with the source", async ({ page }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  test.skip(!origin || process.env.ASSISTANT_WEB_TEST_WEBPAGE_REPLY !== "true", "Requires webpage generation and the isolated conversation model.");
  const username = `qa-webpage-reply-${randomUUID().slice(0, 8)}`;
  const password = "Qa.WebDraft-reply-fixture!";
  const api = new AssistantClient({ origin: origin! });
  await api.replaceSession(await api.register({ username, password }));
  const conversation = await api.createConversation({ title: "合成站点来源" });
  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: /^合成站点来源/ }).click();
  await page.getByLabel("消息", { exact: true }).fill("将这一条已完成的合成回复生成网页 🦀");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByRole("button", { name: "保存为文稿", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "文稿" });
  await dialog.getByLabel("文件格式").selectOption("webpage");
  await dialog.getByLabel("文稿标题").fill("已完成的合成回复网页");
  await dialog.getByRole("button", { name: "从回复生成网页" }).click();
  await expect(dialog.getByText("已保存版本 1。")).toBeVisible();
  await expect(dialog.getByLabel("第 1 段")).toHaveValue("本地模拟回复：将这一条已完成的合成回复生成网页 🦀");
  await dialog.getByRole("button", { name: "预览已保存网页" }).click();
  await expect(dialog.locator('iframe[title="已保存网页"]').contentFrame()
    .getByRole("heading", { name: "已完成的合成回复网页" })).toBeVisible();
  const [stored] = (await api.listArtifacts()).items;
  expect(stored).toMatchObject({ format: "webpage", sourceMessageId: expect.any(String) });
  const key = randomUUID();
  const sameSource = { format: "webpage" as const, title: "合成重试", sourceMessageId: stored.sourceMessageId! };
  const duplicate = await api.createArtifact(sameSource, key);
  expect((await api.createArtifact(sameSource, key)).id).toBe(duplicate.id);
  await expect(api.createArtifact({ ...sameSource, title: "不一致的请求" }, key)).rejects.toMatchObject({ status: 409 });
  await api.deleteConversation(conversation.id);
  await expect(api.getArtifact(stored.id)).rejects.toMatchObject({ status: 404 });
  await expect(api.previewWebpageArtifact(stored.id, stored.headVersionId)).rejects.toMatchObject({ status: 404 });
  await expect(api.downloadArtifactVersion(stored.id, stored.headVersionId, "webpage")).rejects.toMatchObject({ status: 404 });
  await expect(api.createArtifact(sameSource, key)).rejects.toMatchObject({ status: 404 });
});

test("shares only the reviewed webpage version and clears it on access withdrawal", async ({ page, browser }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  const directory = process.env.ASSISTANT_WEB_TEST_COLLABORATION_FIXTURE;
  test.skip(!origin || !directory || process.env.ASSISTANT_WEB_TEST_WEBPAGE_PUBLICATIONS !== "true",
    "Requires the isolated team webpage API and a synthetic membership fixture.");
  test.setTimeout(65_000);
  const name = randomUUID().slice(0, 8);
  const creator = `qa-site-owner-${name}`;
  const member = `qa-site-viewer-${name}`;
  const password = "Qa.Site-publication-fixture!";
  const ownerApi = new AssistantClient({ origin: origin! });
  const viewerApi = new AssistantClient({ origin: origin! });
  const owner = await ownerApi.register({ username: creator, password });
  const viewer = await viewerApi.register({ username: member, password });
  await ownerApi.replaceSession(owner);
  await viewerApi.replaceSession(viewer);
  const project = await ownerApi.createProject({ name: "受限网页共享项目" });
  const marker = join(directory!, "add.json");
  await writeFile(marker + ".tmp", JSON.stringify({ workspaceId: owner.user.workspaceId, ownerId: owner.user.id, readerId: viewer.user.id }), { flag: "wx" });
  await rename(marker + ".tmp", marker);
  await expect.poll(() => access(join(directory!, "added.json")).then(() => true, () => false), { timeout: 20_000 }).toBe(true);
  await viewerApi.switchWorkspace(owner.user.workspaceId);
  const invitation = await ownerApi.inviteProjectMember(project.id, { recipientUsername: member, role: "viewer" });
  const oldTitle = "第一版可分享标题";
  const original = { heading: oldTitle, introduction: "合成说明", sections: [{ title: "公开给协作成员", paragraphs: ["只读正文"] }] };
  const draft = await ownerApi.createArtifact({ projectId: project.id, title: "明确选版的网页", format: "webpage",
    website: original }, randomUUID());
  await ownerApi.createArtifactVersion(draft.id, { baseVersionId: draft.head.id, title: draft.title,
    website: { ...original, heading: "所有者私下继续编辑的新版" } });

  await page.goto("/");
  await page.getByLabel("用户名").fill(creator);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "文稿", exact: true }).click();
  const artifacts = page.getByRole("dialog", { name: "文稿" });
  await artifacts.getByRole("button", { name: "明确选版的网页 · 版本 2" }).click();
  await artifacts.getByRole("button", { name: "版本 1", exact: true }).click();
  await artifacts.getByRole("button", { name: "预览发布版本 1" }).click();
  await expect(artifacts.getByRole("region", { name: "发布文稿版本" })).toContainText(oldTitle);
  await artifacts.getByRole("button", { name: "确认发布此版本" }).click();
  await expect(artifacts.getByText("版本 1 已发布到项目协作。")).toBeVisible();
  const [publication] = (await ownerApi.listProjectArtifactPublications(project.id)).items;

  const ctx = await browser.newContext();
  try {
    const other = await ctx.newPage();
    await other.goto("/");
    await other.getByLabel("用户名").fill(member);
    await other.getByLabel("密码", { exact: true }).fill(password);
    await other.getByRole("button", { name: "登录", exact: true }).click();
    await other.getByRole("button", { name: `账号与数据 · ${member}` }).click();
    await other.getByRole("button", { name: "切换工作空间" }).click();
    await other.getByRole("dialog", { name: "切换工作空间" })
      .getByRole("button", { name: `工作空间 ${owner.user.workspaceId.slice(0, 8)}` }).click();
    await other.getByRole("button", { name: "项目协作", exact: true }).click();
    const collaboration = other.getByRole("dialog", { name: "项目协作" });
    await collaboration.getByRole("button", { name: "接受邀请" }).click();
    const publications = collaboration.getByRole("region", { name: "已发布文稿", exact: true });
    await publications.getByRole("button", { name: "明确选版的网页 · 版本 1" }).click();
    const current = publications.getByRole("region", { name: "已发布文稿内容" });
    await expect(current.getByLabel("网页正文")).toContainText(oldTitle);
    await expect(current.getByText("所有者私下继续编辑的新版")).toHaveCount(0);
    await expect(viewerApi.getArtifact(draft.id)).rejects.toMatchObject({ status: 404 });
    const preview = current.getByRole("button", { name: "预览已发布网页" });
    const fixture = `**/artifact-publications/${publication.id}/preview`;
    await other.route(fixture, (route) => route.fulfill({ status: 503, json: { code: "CAPABILITY_UNAVAILABLE", message: "Fixture preview temporarily unavailable" } }));
    await preview.click();
    await expect(collaboration.getByRole("alert")).toBeVisible();
    await expect(current.getByLabel("网页正文")).toContainText(oldTitle);
    await expect(current.locator("iframe")).toHaveCount(0);
    await other.unroute(fixture);
    await preview.click();
    await expect(current.locator("iframe").contentFrame().getByRole("heading", { name: oldTitle })).toBeVisible();
    const pending = other.waitForEvent("download");
    await current.getByRole("button", { name: "下载已发布版本" }).click();
    const file = await pending;
    expect(file.suggestedFilename()).toBe("artifact.html");
    expect(await readFile(await file.path(), "utf8")).toContain(oldTitle);
    await file.delete();

    await ownerApi.revokeProjectInvitation(project.id, invitation.id);
    await preview.click();
    await expect(current).toHaveCount(0);
    await expect(viewerApi.previewProjectWebpagePublication(project.id, publication.id)).rejects.toMatchObject({ status: 404 });
    await ownerApi.revokeProjectArtifactPublication(project.id, publication.id);
    await expect(ownerApi.previewProjectWebpagePublication(project.id, publication.id)).rejects.toMatchObject({ status: 404 });
  } finally {
    await ctx.close();
  }
});
