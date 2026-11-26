import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AssistantClient } from "@ai-assistant/contracts";

const firstPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPgCsj8DwAC7gHDSedwyAAAAABJRU5ErkJggg==", "base64");
const secondPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNYZRLzHwAFAAI65LgxvgAAAABJRU5ErkJggg==", "base64");

test("versions approved PNG assets and replaces a scrubbed head after source revocation", async ({ page }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  test.skip(!origin || process.env.ASSISTANT_WEB_TEST_IMAGE_ASSETS !== "true", "Requires isolated private PNG storage and version grants.");
  const username = `qa-asset-web-${randomUUID().slice(0, 8)}`;
  const password = "Qa.Image-asset-fixture!";
  const owner = new AssistantClient({ origin: origin! });
  await owner.replaceSession(await owner.register({ username, password }));
  const { id: projectId } = await owner.createProject({ name: "合成图片资产项目" });
  const [first, second] = await Promise.all([firstPng, secondPng].map((bytes) => owner.uploadProjectAttachment(
    projectId, new Blob([Uint8Array.from(bytes)], { type: "image/png" }), randomUUID(),
  )));
  await expect.poll(async () => (await owner.listProjectAttachments(projectId)).items.filter(({ state }) => state === "approved").length,
    { timeout: 20_000 }).toBe(2);

  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "文稿", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "文稿" });
  await dialog.getByLabel("所属项目").selectOption(projectId);
  await dialog.getByLabel("文件格式").selectOption("image");
  await dialog.getByLabel("文稿标题").fill("受控图片资产样例");
  await expect(dialog.getByRole("button", { name: "创建图片资产" })).toBeDisabled();
  const chooser = dialog.getByRole("combobox", { name: "图片来源", exact: true });
  await chooser.selectOption(first.id);
  await dialog.getByLabel("替代文字").fill("第一版蓝色图片");
  await dialog.getByRole("button", { name: "创建图片资产" }).click();
  await expect(dialog.getByText("已保存版本 1。")).toBeVisible();
  const [initial] = (await owner.listArtifacts({ projectId })).items;
  await dialog.getByRole("button", { name: "预览当前图片版本" }).click();
  const preview = dialog.getByRole("img", { name: "第一版蓝色图片" });
  await expect(preview).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
  await dialog.getByRole("button", { name: "关闭图片版本预览" }).click();

  await chooser.selectOption(second.id);
  await dialog.getByLabel("替代文字").fill("仅第二版存在的替代文字");
  await dialog.getByRole("button", { name: "保存新版本" }).click();
  await expect(dialog.getByText("已保存版本 2。")).toBeVisible();
  const changed = await owner.getArtifact(initial.id);
  expect(changed.head).toMatchObject({ image: { attachmentId: second.id, altText: "仅第二版存在的替代文字" } });
  await dialog.getByRole("button", { name: "版本 1", exact: true }).click();
  const pending = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载所选版本" }).click();
  const file = await pending;
  expect(file.suggestedFilename()).toBe("image.png");
  expect(await readFile(await file.path())).toEqual(firstPng);
  await file.delete();

  await owner.deleteProjectAttachment(projectId, second.id);
  await expect(owner.downloadArtifactVersion(initial.id, changed.head.id, "image")).rejects.toMatchObject({ status: 404 });
  await dialog.getByRole("button", { name: "刷新文稿" }).click();
  await dialog.getByRole("button", { name: /^图片来源已撤回 · 版本 2$/ }).click();
  await expect(dialog.getByLabel("替代文字")).toHaveValue("");
  await chooser.selectOption(first.id);
  await dialog.getByLabel("文稿标题").fill("源已重新确认的图片资产");
  await dialog.getByLabel("替代文字").fill("重新选用的蓝色图片");
  await dialog.getByRole("button", { name: "保存新版本" }).click();
  await expect(dialog.getByText("已保存版本 3。")).toBeVisible();
  const restored = await owner.getArtifact(initial.id);
  expect(restored.head).toMatchObject({ image: { attachmentId: first.id, altText: "重新选用的蓝色图片" } });
  await expect(owner.downloadArtifactVersion(initial.id, changed.head.id, "image")).rejects.toMatchObject({ status: 404 });
  expect(Buffer.from(await (await owner.downloadArtifactVersion(initial.id, restored.head.id, "image")).arrayBuffer())).toEqual(firstPng);
});
