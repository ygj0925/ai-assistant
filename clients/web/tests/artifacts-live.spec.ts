import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { AssistantClient } from "@ai-assistant/contracts";

test("writes a private Markdown artifact, restores a version and downloads its exact bytes", async ({ page }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  test.skip(!origin || process.env.ASSISTANT_WEB_TEST_ARTIFACTS !== "true",
    "Requires the isolated artifact repository.");
  const username = `qa-artifact-web-${Date.now().toString(36)}`;
  const password = "Qa.Artifact-synthetic-fixture!";
  const api = new AssistantClient({ origin: origin! });
  await api.replaceSession(await api.register({ username, password }));
  const project = await api.createProject({ name: "合成文稿项目" });
  const outsider = new AssistantClient({ origin: origin! });
  await outsider.replaceSession(await outsider.register({ username: `${username}-out`, password }));

  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const opener = page.getByRole("button", { name: "文稿", exact: true });
  await opener.click();
  const modal = page.getByRole("dialog", { name: "文稿" });
  const first = "# 合成记录\n\n• 字节按原文保留 🦀\n";
  await modal.getByLabel("所属项目").selectOption(project.id);
  await modal.getByLabel("文稿标题").fill("合成版本文稿");
  await modal.getByLabel("文稿正文").fill(first);
  await modal.getByRole("button", { name: "创建文稿" }).click();
  await expect(modal.getByText("已保存版本 1。")).toBeVisible();
  const [created] = (await api.listArtifacts({ projectId: project.id })).items;
  await expect(outsider.getArtifact(created.id)).rejects.toMatchObject({ status: 404 });

  await modal.getByLabel("文稿正文").fill("另一个内容");
  await modal.getByRole("button", { name: "保存新版本" }).click();
  await expect(modal.getByText("已保存版本 2。")).toBeVisible();
  await modal.getByRole("button", { name: "版本 1", exact: true }).click();
  await modal.getByRole("button", { name: "还原为新版本" }).click();
  await modal.getByRole("button", { name: "确认还原" }).click();
  await expect(modal.getByText("已从版本 1 创建版本 3。")).toBeVisible();
  const saved = page.waitForEvent("download");
  await modal.getByRole("button", { name: "下载当前版本" }).click();
  const download = await saved;
  expect(download.suggestedFilename()).toBe("artifact.md");
  expect(await readFile(await download.path())).toEqual(Buffer.from(first, "utf8"));
  await download.delete();

  await modal.getByRole("button", { name: "删除文稿", exact: true }).click();
  const deleted = page.waitForResponse((response) => response.request().method() === "DELETE"
    && response.url().endsWith(`/artifacts/${created.id}`));
  await modal.getByRole("button", { name: "确认删除文稿和版本" }).click();
  expect((await deleted).status()).toBe(204);
  await expect(modal.getByRole("region", { name: "已有文稿" })).toHaveCount(0);
  expect((await api.listArtifacts({ projectId: project.id })).items).toEqual([]);
  await modal.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(opener).toBeFocused();
});

test("creates an artifact from a completed reply and prevents access after source erasure", async ({ page }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  test.skip(!origin || process.env.ASSISTANT_WEB_TEST_ARTIFACTS !== "true",
    "Requires the isolated artifact repository and local-echo.");
  const username = `qa-artifact-reply-${Date.now().toString(36)}`;
  const password = "Qa.Artifact-reply-fixture!";
  const api = new AssistantClient({ origin: origin! });
  await api.replaceSession(await api.register({ username, password }));
  const conversation = await api.createConversation({ title: "合成文稿来源" });
  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: /^合成文稿来源/ }).click();
  await page.getByLabel("消息", { exact: true }).fill("将合成回复保存为文稿");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByRole("button", { name: "保存为文稿", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "文稿" });
  const original = "本地模拟回复：将合成回复保存为文稿";
  await expect(modal.getByLabel("文稿正文")).toHaveValue(original);
  await modal.getByRole("button", { name: "创建文稿" }).click();
  await expect(modal.getByText("已保存版本 1。")).toBeVisible();
  const [stored] = (await api.listArtifacts()).items;
  expect(stored.sourceMessageId).toBeTruthy();
  expect((await api.getArtifact(stored.id)).head).toMatchObject({ content: original });
  await api.deleteConversation(conversation.id);
  await expect(api.getArtifact(stored.id)).rejects.toMatchObject({ status: 404 });
  await expect(api.downloadArtifactVersion(stored.id, stored.headVersionId, "markdown")).rejects.toMatchObject({ status: 404 });
});
