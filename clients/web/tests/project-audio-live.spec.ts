import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AssistantClient } from "@ai-assistant/contracts";

test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream"] } });

function wave(samples: Buffer, annotation?: string) {
  const tag = annotation ? Buffer.from(annotation) : Buffer.alloc(0);
  const extra = annotation ? Buffer.alloc(8 + tag.length + (tag.length & 1)) : Buffer.alloc(0);
  if (annotation) {
    extra.write("JUNK");
    extra.writeUInt32LE(tag.length, 4);
    tag.copy(extra, 8);
  }
  const header = Buffer.alloc(36);
  header.write("RIFF");
  header.writeUInt32LE(36 + samples.length + extra.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  const data = Buffer.alloc(8);
  data.write("data");
  data.writeUInt32LE(samples.length, 4);
  return Buffer.concat([header, extra, data, samples]);
}

test("requires explicit audio upload and plays only scanned canonical WAVE until revoked", async ({ page }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  test.skip(!origin || process.env.ASSISTANT_WEB_TEST_PROJECT_AUDIO !== "true",
    "Requires isolated audio storage and a live scanner.");
  const sampleBytes = Buffer.alloc(65536);
  for (let index = 0; index < sampleBytes.length / 2; index += 1) {
    sampleBytes.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / 16000) * 1000), index * 2);
  }
  const original = wave(sampleBytes, "unpublished metadata");
  const approved = wave(sampleBytes);
  const username = `qa-audio-web-${randomUUID().slice(0, 8)}`;
  const password = "Qa.Private-audio-fixture!";
  const owner = new AssistantClient({ origin: origin! });
  await owner.replaceSession(await owner.register({ username, password }));
  const project = await owner.createProject({ name: "合成音频项目" });
  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "项目", exact: true }).click();
  const projects = page.getByRole("dialog", { name: "项目", exact: true });
  await projects.getByRole("button", { name: "查看项目音频 合成音频项目" }).click();
  const panel = page.getByRole("dialog", { name: "项目音频" });
  const input = panel.getByLabel("选择 WAV 文件");
  await input.setInputFiles({ name: "synthetic.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("irrelevant") });
  await expect(panel.getByRole("alert")).toContainText("请选择 1 MiB 以内的 WAV 文件");
  await input.setInputFiles({ name: "synthetic.wav", mimeType: "audio/wav", buffer: original });
  expect((await owner.listProjectAudioAttachments(project.id)).items).toEqual([]);
  await panel.getByRole("button", { name: "上传 WAV" }).click();
  await expect(panel.getByText("已接收音频。可刷新查看检查结果。")).toBeVisible();
  await expect.poll(async () => (await owner.listProjectAudioAttachments(project.id)).items[0]?.state,
    { timeout: 20_000 }).toBe("approved");
  const [stored] = (await owner.listProjectAudioAttachments(project.id)).items;
  expect(stored.audio).toEqual({ sampleRate: 16000, channels: 1, durationMillis: 2048 });
  expect((await owner.listProjectAttachments(project.id)).items).toEqual([]);
  await panel.getByRole("button", { name: "刷新状态" }).click();
  await panel.getByRole("button", { name: "预览", exact: true }).click();
  const player = panel.locator("audio[aria-label='项目上传的音频预览']");
  await expect(player).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => player.evaluate((media: HTMLAudioElement) => media.duration)).toBeCloseTo(2.048);
  const saving = page.waitForEvent("download");
  await panel.getByRole("button", { name: "下载 WAV" }).click();
  const file = await saving;
  expect(file.suggestedFilename()).toBe("audio.wav");
  expect(await readFile(await file.path())).toEqual(approved);
  await file.delete();
  await owner.deleteProjectAudioAttachment(project.id, stored.id);
  await expect(player).toHaveCount(0, { timeout: 12_000 });
  await expect(owner.downloadProjectAudioAttachment(project.id, stored.id)).rejects.toMatchObject({ status: 404 });
});

test.describe("project microphone", () => {
  test("ends the actual browser track and sends a scanned WAV only after confirmation", async ({ page, context }) => {
    const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
    test.skip(!origin || process.env.ASSISTANT_WEB_TEST_PROJECT_AUDIO !== "true", "Requires Chrome and the isolated audio scanner.");
    const username = `qa-mic-web-${randomUUID().slice(0, 12)}`;
    const password = "Qa.Private-mic-fixture!";
    const owner = new AssistantClient({ origin: origin! });
    await owner.replaceSession(await owner.register({ username, password }));
    const project = await owner.createProject({ name: "合成录音项目" });
    type MicFixture = Window & { testedMicrophone?: MediaStreamTrack };
    await page.addInitScript(() => {
      const devices = navigator.mediaDevices;
      const capture = devices.getUserMedia.bind(devices);
      devices.getUserMedia = async (constraints) => {
        const stream = await capture(constraints);
        (window as MicFixture).testedMicrophone = stream.getAudioTracks()[0];
        return stream;
      };
    });
    const cdp = await context.newCDPSession(page);
    const { targetInfo } = await cdp.send("Target.getTargetInfo");
    const setMicrophone = (setting: "denied" | "granted") => cdp.send("Browser.setPermission", {
      browserContextId: targetInfo.browserContextId, origin: "http://127.0.0.1:3100",
      permission: { name: "microphone" }, setting,
    });
    const trackState = () => page.evaluate(() => (window as MicFixture).testedMicrophone?.readyState);
    let uploads = 0;
    const isUpload = (request: import("@playwright/test").Request) => request.method() === "POST" && request.url().endsWith("/audio-attachments");
    page.on("request", (request) => { if (isUpload(request)) uploads++; });

    await setMicrophone("denied");
    await page.goto("/");
    await page.getByLabel("用户名").fill(username);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("button", { name: "项目", exact: true }).click();
    await page.getByRole("button", { name: "查看项目音频 合成录音项目" }).click();
    const dialog = page.getByRole("dialog", { name: "项目音频" });
    const start = dialog.getByRole("button", { name: "开始录音" });
    const stop = dialog.getByRole("button", { name: "停止录音" });
    const submit = dialog.getByRole("button", { name: "上传 WAV" });
    const player = dialog.getByLabel("待上传的本机录音");
    await start.click();
    await expect(dialog.getByText("未获麦克风授权。可以选择 WAV 文件或继续文字聊天。")).toBeVisible();
    await expect(dialog.getByLabel("选择 WAV 文件")).toBeEnabled();
    await expect(submit).toBeDisabled();

    await setMicrophone("granted");
    await start.click();
    await expect(stop).toBeVisible();
    expect(await trackState()).toBe("live");
    await setMicrophone("denied");
    await expect(dialog.getByText("麦克风访问已停止，录音已清除。可以选择 WAV 文件或继续文字聊天。")).toBeVisible();
    await expect.poll(trackState).toBe("ended");
    await expect(submit).toBeDisabled();

    await setMicrophone("granted");
    await start.click();
    await expect(stop).toBeVisible();
    await context.setOffline(true);
    await expect(dialog.getByText("网络已断开，录音已清除。")).toBeVisible();
    await expect.poll(trackState).toBe("ended");
    await context.setOffline(false);

    async function recordDraft() {
      await start.click();
      await expect(stop).toBeVisible();
      // Let the synthetic microphone produce enough encoded audio to hear in the preview.
      await page.waitForTimeout(1200);
      await stop.click();
      await expect(player).toHaveAttribute("src", /^blob:/);
      await expect.poll(trackState).toBe("ended");
      await expect.poll(() => player.evaluate((audio: HTMLAudioElement) => audio.duration)).toBeGreaterThan(0.5);
    }

    await recordDraft();
    await setMicrophone("denied");
    await expect(player).toHaveCount(0);
    await expect(submit).toBeDisabled();
    expect(uploads).toBe(0);
    expect((await owner.listProjectAudioAttachments(project.id)).items).toEqual([]);

    await setMicrophone("granted");
    await recordDraft();
    const receipt = page.waitForResponse((response) => isUpload(response.request()));
    await submit.click();
    expect((await receipt).status()).toBe(202);
    expect(uploads).toBe(1);
    await expect(player).toHaveCount(0);
    await expect.poll(async () => (await owner.listProjectAudioAttachments(project.id)).items[0]?.state,
      { timeout: 20_000 }).toBe("approved");
    const [stored] = (await owner.listProjectAudioAttachments(project.id)).items;
    expect(stored.audio).toMatchObject({ sampleRate: 16000, channels: 1 });
    const approved = await owner.downloadProjectAudioAttachment(project.id, stored.id);
    const canonical = Buffer.from(await approved.arrayBuffer());
    expect(canonical.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(canonical.subarray(8, 16).toString("ascii")).toBe("WAVEfmt ");
    expect(canonical.subarray(36, 40).toString("ascii")).toBe("data");
    expect(canonical.readUInt32LE(40)).toBe(canonical.length - 44);
    expect(canonical.subarray(44).some((byte) => byte !== 0)).toBe(true);

    await start.click();
    await expect(stop).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(await trackState()).toBe("ended");
    await owner.deleteProjectAudioAttachment(project.id, stored.id);
  });
});
