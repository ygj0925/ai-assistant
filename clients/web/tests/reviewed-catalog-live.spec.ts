import { expect, test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AssistantClient } from "@ai-assistant/contracts";

const run = promisify(execFile);
const password = "Qa.Catalog-browser-fixture!";

async function signIn(page: Page, username: string) {
  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "已审核目录", exact: true }).click();
  return page.getByRole("dialog", { name: "已审核目录" });
}

test("requires a reviewed assistant release and permits exact reports and withdrawal", async ({ page, browser }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  const reviewFixture = process.env.ASSISTANT_WEB_TEST_REVIEW_CATALOG;
  test.skip(!origin || !reviewFixture, "Requires the isolated reviewed catalogue and operator fixture.");
  test.setTimeout(65_000);
  const suffix = randomUUID().slice(0, 8);
  const ownerName = `qa-directory-own-${suffix}`;
  const viewerName = `qa-directory-view-${suffix}`;
  const owner = new AssistantClient({ origin: origin! });
  const viewer = new AssistantClient({ origin: origin! });
  const session = await owner.register({ username: ownerName, password });
  await owner.replaceSession(session);
  await viewer.replaceSession(await viewer.register({ username: viewerName, password }));
  const title = `合成目录助手 ${suffix}`;
  const instructions = "复制字面 <em>文字</em>，无需任何项目资料。";
  const privateAssistant = await owner.createCustomAssistant({ name: title, instructions, resourceIds: [], tools: [] }, randomUUID());
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/author/releases")) writes.push(request.url());
  });

  const panel = await signIn(page, ownerName);
  await panel.getByRole("button", { name: "我的提交" }).click();
  const drafts = panel.getByRole("region", { name: "我的目录提交" });
  await drafts.getByLabel("我的定制助手").selectOption(privateAssistant.id);
  await drafts.getByLabel("提交版本").selectOption(privateAssistant.head.id);
  await drafts.getByLabel("公开说明").fill("合成说明，由测试运营审核。");
  await drafts.getByRole("button", { name: "预览提交内容" }).click();
  const review = drafts.getByRole("region", { name: "提交审核前预览" });
  await expect(review.locator("pre")).toHaveText(instructions);
  await expect(review.locator("em")).toHaveCount(0);
  expect(writes).toHaveLength(0);
  await review.getByRole("button", { name: "确认提交审核" }).click();
  await expect(drafts.getByText("待审核", { exact: true })).toBeVisible();
  expect(writes).toHaveLength(1);
  const [release] = (await owner.listCatalogAuthorReleases()).items;
  expect(release.state).toBe("pending");
  await expect(viewer.getReviewedCatalogItem(release.entryId)).rejects.toMatchObject({ status: 404 });

  const marker = await mkdtemp(join(tmpdir(), "assistant-reviewed-catalog-browser-"));
  try {
    await writeFile(join(marker, "review.json"), JSON.stringify({ workspaceId: session.user.workspaceId,
      releaseId: release.id, decision: "approve" }), { flag: "wx" });
    await run(process.execPath, [reviewFixture!, marker], { timeout: 24_000 });
    await expect(viewer.getReviewedCatalogItem(release.entryId)).resolves.toMatchObject({ releaseId: release.id, instructions });
  } finally {
    await rm(join(marker, "review.json"), { force: true });
    await rm(join(marker, "reviewed.json"), { force: true });
    await rmdir(marker).catch(() => undefined);
  }

  const visitorContext = await browser.newContext();
  try {
    const visitor = await visitorContext.newPage();
    const publicPanel = await signIn(visitor, viewerName);
    await publicPanel.getByRole("combobox", { name: "类别", exact: true }).selectOption("assistant");
    await publicPanel.getByRole("button", { name: title, exact: true }).click();
    const detail = publicPanel.getByRole("region", { name: "已审核版本详情" });
    await expect(detail.locator("pre")).toHaveText(instructions);
    await expect(detail.locator("em")).toHaveCount(0);
    await detail.getByRole("button", { name: "举报该版本" }).click();
    await detail.getByLabel("举报原因").selectOption("misleading");
    await detail.getByRole("button", { name: "确认举报" }).click();
    await expect(publicPanel.getByText("已记录此版本的举报。", { exact: true })).toBeVisible();

    await page.bringToFront();
    await drafts.getByRole("button", { name: "刷新审核状态" }).click();
    await expect(drafts.getByText("已发布", { exact: true })).toBeVisible();
    await drafts.getByRole("button", { name: "撤回此版本" }).click();
    await drafts.getByRole("button", { name: "确认撤回目录版本" }).click();
    await expect(drafts.getByText("已撤回", { exact: true })).toBeVisible();
    await expect(viewer.getReviewedCatalogItem(release.entryId)).rejects.toMatchObject({ status: 404 });
    await visitor.bringToFront();
    await publicPanel.getByRole("button", { name: "刷新目录" }).click();
    await expect(detail).toHaveCount(0);
    await expect(publicPanel.getByRole("button", { name: title, exact: true })).toHaveCount(0);
    expect((await owner.getCustomAssistant(privateAssistant.id)).head.id).toBe(privateAssistant.head.id);
  } finally {
    await visitorContext.close();
  }
});
