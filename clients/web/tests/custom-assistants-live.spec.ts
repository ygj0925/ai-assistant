import { expect, test } from "@playwright/test";
import { AssistantApiError, AssistantClient } from "@ai-assistant/contracts";

test("edits a private project assistant and restores its earlier instructions as a new version", async ({ page }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  test.skip(!origin || process.env.ASSISTANT_WEB_TEST_CUSTOM_ASSISTANTS !== "true",
    "Requires the isolated private assistant registry.");
  const username = `qa-custom-web-${Date.now().toString(36)}`;
  const password = "Qa.Custom-synthetic-fixture!";
  const client = new AssistantClient({ origin: origin! });
  const session = await client.register({ username, password });
  await client.replaceSession(session);
  const project = await client.createProject({ name: "合成助手项目" });
  const handbook = await client.createProjectResource(project.id, { name: "合成助手手册", content: "合成标记：项目资料。" });
  const conversation = await client.createConversation({ title: "合成助手会话", projectId: project.id });
  const other = new AssistantClient({ origin: origin! });
  await other.replaceSession(await other.register({ username: `${username}-outside`, password }));

  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const opener = page.getByRole("button", { name: "定制助手", exact: true });
  await opener.click();
  const panel = page.getByRole("dialog", { name: "定制助手" });
  await expect(panel.getByLabel("助手名称")).toBeEditable();
  await panel.getByLabel("助手名称").fill("合成项目整理助手");
  await panel.getByLabel("助手指令").fill("格式：项目符号");
  await panel.getByLabel("绑定私有项目").selectOption(project.id);
  await panel.getByRole("checkbox", { name: "合成助手手册" }).check();
  await panel.getByRole("checkbox", { name: "允许检索所选项目资料" }).check();
  await panel.getByRole("button", { name: "创建助手", exact: true }).click();
  await expect(panel.getByText("已保存版本 1。")).toBeVisible();

  const [created] = (await client.listCustomAssistants()).items;
  const v1 = await client.getCustomAssistantVersion(created.id, created.headVersionId);
  expect(v1.resourceIds).toEqual([handbook.id]);
  expect(v1.tools).toEqual(["project_resource_lookup"]);
  await expect(other.getCustomAssistant(created.id)).rejects.toBeInstanceOf(AssistantApiError);
  await expect(other.getCustomAssistantVersion(created.id, v1.id)).rejects.toMatchObject({ status: 404 });
  expect((await other.listCustomAssistants()).items).toEqual([]);

  await panel.getByLabel("助手指令").fill("格式：简短叙述");
  await panel.getByRole("button", { name: "保存新版本" }).click();
  await expect(panel.getByText("已保存版本 2。")).toBeVisible();
  await panel.getByRole("button", { name: /^版本 1 · / }).click();
  await expect(panel.getByText("格式：项目符号", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "基于此版本还原" }).click();
  await panel.getByRole("button", { name: "确认还原此版本" }).click();
  await expect(panel.getByText("已从版本 1 创建版本 3。")).toBeVisible();
  await expect(panel.getByLabel("助手指令")).toHaveValue("格式：项目符号");
  const restored = await client.getCustomAssistant(created.id);
  expect(restored.head).toMatchObject({ number: 3, restoredFromVersionId: v1.id });
  expect(restored.head.id).not.toBe(v1.id);

  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(opener).toBeFocused();
  await page.getByRole("button", { name: /^合成助手会话/ }).click();
  const choices = page.getByRole("combobox", { name: "定制助手" });
  await choices.selectOption(restored.head.id);
  await page.getByLabel("消息", { exact: true }).fill("合成标记");
  const accepted = page.waitForResponse((reply) => reply.request().method() === "POST"
    && reply.url().endsWith(`/conversations/${conversation.id}/runs`));
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const reply = await accepted;
  expect(reply.ok()).toBe(true);
  const result = await reply.json();
  expect(result.customAssistant).toEqual({ id: created.id, versionId: restored.head.id });
  await expect(page.getByText("本地定制助手（项目资料命中 1 项）：", { exact: true })).toBeVisible();
  await expect.poll(async () => (await client.getRunSnapshot(result.runId)).state).toBe("completed");
  expect((await client.getRunSnapshot(result.runId)).content).toContain("\n- 合成标记");

  await opener.click();
  await panel.getByRole("button", { name: "合成项目整理助手 · 版本 3" }).click();
  await panel.getByRole("button", { name: "删除定制助手", exact: true }).click();
  await panel.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(panel.getByRole("region", { name: "已保存定制助手" })).toHaveCount(0);
  await expect(client.getCustomAssistant(created.id)).rejects.toMatchObject({ status: 404 });
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(opener).toBeFocused();
});
