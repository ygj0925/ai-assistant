import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AssistantClient } from "@ai-assistant/contracts";

test("keeps code drafts literal, preserves line endings and restores old downloads", async ({ page }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  test.skip(!origin || process.env.ASSISTANT_WEB_TEST_CODE_DRAFTS !== "true", "Requires the isolated private code draft API.");
  const username = `qa-code-web-${randomUUID().slice(0, 8)}`;
  const password = "Qa.CodeDraft-fixture!";
  const api = new AssistantClient({ origin: origin! });
  await api.replaceSession(await api.register({ username, password }));
  const { id: projectId } = await api.createProject({ name: "合成代码项目" });
  const previous = "const label = '<template>汉字 🦀</template>';\r\n\tconst line = 1;\r\n";
  await api.createArtifact({ projectId, title: "合成代码稿", format: "code",
    code: { language: "javascript", source: previous } }, randomUUID());
  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "文稿", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "文稿" });
  await panel.getByRole("button", { name: "合成代码稿 · 版本 1" }).click();
  await expect(panel.getByLabel("代码语言")).toHaveValue("javascript");
  await expect(panel.getByLabel("源码")).toHaveValue(previous.replaceAll("\r\n", "\n"));
  await panel.getByLabel("代码语言").selectOption("typescript");
  await panel.getByLabel("源码").fill("const heading: string = '新版';\n");
  await panel.getByRole("button", { name: "保存新版本" }).click();
  await expect(panel.getByText("已保存版本 2。")).toBeVisible();
  const [draft] = (await api.listArtifacts({ projectId })).items;
  expect((await api.getArtifact(draft.id)).head).toMatchObject({ code: {
    language: "typescript", source: "const heading: string = '新版';\r\n",
  } });
  await panel.getByRole("button", { name: "版本 1", exact: true }).click();
  await expect(panel.locator("pre code")).toContainText("'<template>汉字 🦀</template>'");
  await expect(panel.locator("pre template")).toHaveCount(0);
  await panel.getByRole("button", { name: "还原为新版本" }).click();
  await panel.getByRole("button", { name: "确认还原" }).click();
  await expect(panel.getByText("已从版本 1 创建版本 3。")).toBeVisible();
  const pending = page.waitForEvent("download");
  await panel.getByRole("button", { name: "下载当前版本" }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe("artifact-3.js.txt");
  expect(await readFile(await download.path())).toEqual(Buffer.from(previous, "utf8"));
  await download.delete();
});
