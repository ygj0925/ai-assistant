import { expect, test as base, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sourceTitle = "Synthetic attachment capture source";
const test = base.extend<object, { syntheticCamera: string }>({
  syntheticCamera: [async ({}, use) => {
    const folder = await mkdtemp(join(tmpdir(), "assistant-web-camera-"));
    const fileName = join(folder, "synthetic.y4m");
    const width = 320;
    const height = 240;
    const frame = Buffer.concat([Buffer.from("FRAME\n"), Buffer.alloc(width * height, 101),
      Buffer.alloc(width * height / 4, 86), Buffer.alloc(width * height / 4, 170)]);
    await writeFile(fileName, Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\n`), frame, frame]));
    try {
      await use(fileName);
    } finally {
      await unlink(fileName);
      await rmdir(folder);
    }
  }, { scope: "worker" }],
  launchOptions: [async ({ launchOptions, syntheticCamera }, use) => {
    await use({ ...launchOptions, args: [...(launchOptions.args ?? []), "--use-fake-device-for-media-stream",
      `--use-file-for-fake-video-capture=${syntheticCamera}`, `--auto-select-tab-capture-source-by-title=${sourceTitle}`] });
  }, { scope: "worker" }],
});

async function openCapture(page: Page, narrow = false) {
  await page.goto("/");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.getByLabel("用户名").fill(`qa-capture-${randomUUID().slice(0, 12)}`);
  await page.getByLabel("密码", { exact: true }).fill("Qa.Capture-fixture!");
  const registered = page.waitForResponse((response) => response.url().endsWith("/auth/register"));
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  expect((await registered).status()).toBe(201);
  if (narrow) await page.getByRole("button", { name: "打开对话列表" }).click();
  await page.getByRole("button", { name: "项目", exact: true }).click();
  const projects = page.getByRole("dialog", { name: "项目", exact: true });
  await projects.getByRole("button", { name: "新建项目" }).click();
  const editor = page.getByRole("dialog", { name: "新建项目" });
  await editor.getByLabel("项目名称").fill("合成取帧项目");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await projects.getByRole("button", { name: "查看项目图像 合成取帧项目" }).click();
  return page.getByRole("dialog", { name: "项目图像" });
}

function countUploads(page: Page) {
  let count = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/attachments") && request.method() === "POST") count++;
  });
  return () => count;
}

test.skip(!process.env.ASSISTANT_WEB_TEST_API_ORIGIN || process.env.ASSISTANT_WEB_TEST_CAPTURE !== "true",
  "Requires the isolated project attachment store and Chrome media fixture.");

test.describe("camera frame capture", () => {
  test("denies, discards and explicitly uploads a browser camera frame", async ({ page, context }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const cdp = await context.newCDPSession(page);
    const origin = "http://127.0.0.1:3100";
    const { targetInfo } = await cdp.send("Target.getTargetInfo");
    await cdp.send("Browser.setPermission", { browserContextId: targetInfo.browserContextId, origin,
      permission: { name: "camera" }, setting: "denied" });
    const uploads = countUploads(page);
    const dialog = await openCapture(page, true);
    const camera = dialog.getByRole("button", { name: "打开摄像头" });
    const frame = dialog.getByRole("button", { name: "选取当前帧" });
    const submit = dialog.getByRole("button", { name: "上传 PNG" });
    const local = dialog.getByRole("img", { name: "待上传的本机图像" });
    const preview = dialog.locator("video");
    await camera.click();
    await expect(dialog.getByText("未获授权或已取消。可以改用 PNG 文件或继续文字聊天。")).toBeVisible();
    await expect(submit).toBeDisabled();

    await cdp.send("Browser.setPermission", { browserContextId: targetInfo.browserContextId, origin,
      permission: { name: "camera" }, setting: "granted" });
    await camera.click();
    await expect(frame).toBeEnabled();
    const beforeRevoke = await preview.evaluateHandle((element: HTMLVideoElement) => element.srcObject as MediaStream);
    await cdp.send("Browser.setPermission", { browserContextId: targetInfo.browserContextId, origin,
      permission: { name: "camera" }, setting: "denied" });
    await expect(dialog.getByText("浏览器已停止访问。可以改用 PNG 文件或继续文字聊天。")).toBeVisible();
    expect(await beforeRevoke.evaluate((active) => active.getVideoTracks()[0].readyState)).toBe("ended");
    await expect(submit).toBeDisabled();
    expect(uploads()).toBe(0);
    await cdp.send("Browser.setPermission", { browserContextId: targetInfo.browserContextId, origin,
      permission: { name: "camera" }, setting: "granted" });
    await camera.click();
    await expect(frame).toBeEnabled();
    const stream = await preview.evaluateHandle((element: HTMLVideoElement) => element.srcObject as MediaStream);
    expect(await stream.evaluate((active) => [active.getVideoTracks().length, active.getAudioTracks().length])).toEqual([1, 0]);
    await dialog.getByRole("button", { name: "停止预览" }).click();
    expect(await stream.evaluate((active) => active.getVideoTracks()[0].readyState)).toBe("ended");
    await expect(submit).toBeDisabled();

    await camera.click();
    await expect(frame).toBeEnabled();
    await frame.click();
    await expect(local).toBeVisible();
    await expect.poll(() => local.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    expect(uploads()).toBe(0);
    await dialog.getByRole("button", { name: "丢弃当前帧" }).click();
    await expect(local).toHaveCount(0);
    await expect(submit).toBeDisabled();

    await camera.click();
    await expect(frame).toBeEnabled();
    await frame.click();
    await expect(local).toBeVisible();
    expect(uploads()).toBe(0);
    const receipt = page.waitForResponse((response) => response.url().endsWith("/attachments") && response.request().method() === "POST");
    await submit.click();
    expect((await receipt).status()).toBe(202);
    expect(uploads()).toBe(1);
    await expect.poll(async () => {
      await dialog.getByRole("button", { name: "刷新状态" }).click();
      return dialog.getByText("扫描通过", { exact: true }).count();
    }, { timeout: 15_000 }).toBe(1);
    await dialog.getByRole("button", { name: "删除图像" }).click();
    await dialog.getByRole("button", { name: "确认删除" }).click();
    await expect(dialog.getByText("暂无图像附件。")).toBeVisible();

    await camera.click();
    await expect(frame).toBeEnabled();
    const beforeClose = await preview.evaluateHandle((element: HTMLVideoElement) => element.srcObject as MediaStream);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(await beforeClose.evaluate((active) => active.getVideoTracks()[0].readyState)).toBe("ended");
  });
});

test.describe("tab capture", () => {
  test("stops when the selected tab goes away and keeps the file fallback", async ({ page, context }) => {
    const uploads = countUploads(page);
    const source = await context.newPage();
    await source.route("**/capture-qa-source", (route) => route.fulfill({
      contentType: "text/html",
      body: `<title>${sourceTitle}</title><style>@keyframes move { to { transform: translateX(48px) } }
        body { background: #176a60; color: white } p { animation: move 1.2s alternate infinite }</style>
        <p>Synthetic capture fixture</p>`,
    }));
    await source.goto("http://127.0.0.1:3100/capture-qa-source");
    await expect(source.getByText("Synthetic capture fixture")).toBeVisible();
    await source.screenshot();
    await page.bringToFront();
    const dialog = await openCapture(page);
    const screen = dialog.getByRole("button", { name: "选择共享画面" });
    const frame = dialog.getByRole("button", { name: "选取当前帧" });
    await screen.click();
    await expect(dialog.getByText("共享画面采集中 · 本机预览")).toBeVisible();
    const preview = dialog.locator("video");
    const stream = await preview.evaluateHandle((element: HTMLVideoElement) => element.srcObject as MediaStream);
    expect(await stream.evaluate((active) => ({
      surface: active.getVideoTracks()[0].getSettings().displaySurface, audio: active.getAudioTracks().length,
    }))).toEqual({ surface: "browser", audio: 0 });
    await expect.poll(() => preview.evaluate((element: HTMLVideoElement) => ({
      ready: element.readyState >= 2, hasDimensions: element.videoWidth > 0 && element.videoHeight > 0,
    })), { timeout: 12_000 }).toEqual({ ready: true, hasDimensions: true });
    await expect(frame).toBeEnabled();
    await frame.click();
    await expect(dialog.getByRole("img", { name: "待上传的本机图像" })).toBeVisible();
    expect(await stream.evaluate((active) => active.getVideoTracks()[0].readyState)).toBe("ended");
    expect(uploads()).toBe(0);
    await dialog.getByRole("button", { name: "丢弃当前帧" }).click();
    await screen.click();
    await expect(frame).toBeEnabled({ timeout: 12_000 });
    const activeCapture = await preview.evaluateHandle((element: HTMLVideoElement) => element.srcObject as MediaStream);
    await source.close();
    await expect(dialog.getByText("浏览器已停止访问。可以改用 PNG 文件或继续文字聊天。")).toBeVisible();
    expect(await activeCapture.evaluate((active) => active.getVideoTracks()[0].readyState)).toBe("ended");
    await expect(dialog.getByLabel("选择 PNG 文件")).toBeEnabled();
    expect(uploads()).toBe(0);
    if (process.env.ASSISTANT_WEB_TEST_PROJECT_AUDIO === "true") {
      await dialog.getByRole("button", { name: "改用项目音频" }).click();
      const audio = page.getByRole("dialog", { name: "项目音频" });
      await expect(dialog).toHaveCount(0);
      await expect(audio.getByLabel("选择 WAV 文件")).toBeEnabled();
      await expect(audio.getByRole("button", { name: "开始录音" })).toBeEnabled();
    }
  });
});
