import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { AssistantClient } from "@ai-assistant/contracts";

const run = promisify(execFile);
const syntheticImage = join(__dirname, "../../../qa/assistant-local-image-edit-smoke.mjs");

test("reviews a private crop and rotation, then withholds its asset when the original is withdrawn", async ({ page }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  test.skip(!origin || process.env.ASSISTANT_WEB_TEST_LOCAL_IMAGE_EDITS !== "true", "Requires the isolated PNG edit worker and scanner.");
  test.setTimeout(65_000);
  const username = `qa-edit-web-${randomUUID().slice(0, 8)}`;
  const password = "Qa.Crop-Web-only!";
  const api = new AssistantClient({ origin: origin! });
  await api.replaceSession(await api.register({ username, password }));
  const project = await api.createProject({ name: "合成图像编辑项目" });
  const { stdout } = await run(process.execPath, [syntheticImage, "--fixture-base64"]);
  const original = await api.uploadProjectAttachment(project.id, new Blob([
    new Uint8Array(Buffer.from(stdout.trim(), "base64")),
  ], { type: "image/png" }), randomUUID());
  await expect.poll(async () => (await api.listProjectAttachments(project.id)).items[0]?.state,
    { timeout: 20_000 }).toBe("approved");

  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/local-image-edits")) writes.push(request.url());
  });
  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page.getByRole("dialog", { name: "项目", exact: true })
    .getByRole("button", { name: "查看项目图像 合成图像编辑项目" }).click();
  const panel = page.getByRole("dialog", { name: "项目图像", exact: true });
  await panel.getByRole("button", { name: "裁剪或旋转" }).click();
  const editor = panel.getByRole("region", { name: "编辑项目图像" });
  await expect(editor.getByRole("img", { name: "正在编辑的项目原图" })).toBeVisible();
  await editor.getByLabel("起点 X").fill("3");
  await editor.getByLabel("裁剪宽度").fill("2");
  await editor.getByRole("button", { name: "审核裁剪与旋转" }).click();
  await expect(editor.getByRole("alert")).toContainText("图像范围内");
  await editor.getByLabel("起点 X").fill("1");
  await editor.getByLabel("顺时针旋转").selectOption("90");
  await editor.getByRole("button", { name: "审核裁剪与旋转" }).click();
  await expect(editor.getByText(/副本尺寸 3 × 2 像素/)).toBeVisible();
  expect(writes).toHaveLength(0);
  await editor.getByRole("button", { name: "确认生成编辑副本" }).click();
  await expect(panel.getByText("编辑副本已提交，可刷新查看扫描结果。")).toBeVisible();
  expect(writes).toHaveLength(1);

  await expect.poll(async () => (await api.listProjectAttachments(project.id)).items
    .find((item) => item.localEdit)?.state, { timeout: 20_000 }).toBe("approved");
  const derived = (await api.listProjectAttachments(project.id)).items.find((item) => item.localEdit)!;
  expect(derived).toMatchObject({ width: 3, height: 2, localEdit: {
    algorithm: "local_image_edit_v1", sourceAttachmentId: original.id, x: 1, y: 0, width: 2, height: 3, rotation: 90,
  } });
  const asset = await api.createArtifact({ projectId: project.id, format: "image", title: "合成编辑资产",
    image: { attachmentId: derived.id, altText: "经过裁剪和旋转的合成 PNG" } }, randomUUID());
  const rendered = await api.downloadArtifactVersion(asset.id, asset.head.id, "image");
  const bytes = Buffer.from(await rendered.arrayBuffer());
  expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([3, 2]);

  await panel.getByRole("button", { name: "刷新状态" }).click();
  const descendant = panel.getByRole("listitem").filter({ hasText: "本地编辑副本" });
  await expect(descendant).toBeVisible();
  await expect(descendant.getByRole("button", { name: "裁剪或旋转" })).toHaveCount(0);
  await api.deleteProjectAttachment(project.id, original.id);
  await panel.getByRole("button", { name: "刷新状态" }).click();
  await expect(descendant).toHaveCount(0);
  await expect(api.getArtifact(asset.id)).rejects.toMatchObject({ status: 404 });
});
