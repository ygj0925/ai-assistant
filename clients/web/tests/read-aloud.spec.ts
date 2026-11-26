import { expect, test, type Page } from "@playwright/test";

const configuredBackend = Boolean(process.env.ASSISTANT_WEB_TEST_API_ORIGIN);
type VoiceType = "none" | "remote" | "local";
type PlaybackEvent = "complete" | "error" | "external-stop";
type Spoken = { text: string; voice: string | null; local: boolean | null };

declare global {
  interface Window {
    nativeReplySpeech: { selectedLocal: boolean | null; started: boolean };
    readAloudFixture: {
      spoken: Spoken[];
      canceled: number;
      voices: (type: VoiceType) => void;
      event: (type: PlaybackEvent) => void;
      background: (hidden: boolean) => void;
    };
  }
}

async function installSpeechFixture(page: Page, initial: VoiceType) {
  await page.addInitScript((initialType) => {
    let type = initialType;
    const remote = { name: "Remote", lang: "zh-CN", localService: false, default: true, voiceURI: "remote" };
    const local = { name: "Local", lang: "zh-CN", localService: true, default: false, voiceURI: "local" };
    class Utterance {
      voice: typeof local | null = null;
      lang = "";
      onstart?: () => void;
      onend?: () => void;
      onerror?: (detail: { error: string }) => void;
      constructor(readonly text: string) {}
    }
    const engine = Object.assign(new EventTarget(), {
      pending: false,
      paused: false,
      speaking: false,
      getVoices: () => type === "none" ? [] : type === "remote" ? [remote] : [remote, local],
      speak(utterance: Utterance) {
        current = utterance;
        fixture.spoken.push({ text: utterance.text, voice: utterance.voice?.voiceURI ?? null,
          local: utterance.voice?.localService ?? null });
        engine.speaking = true;
        utterance.onstart?.();
      },
      cancel() {
        fixture.canceled += 1;
        fixture.event("external-stop");
      },
    });
    let current: Utterance | undefined;
    const fixture: Window["readAloudFixture"] = {
      spoken: [],
      canceled: 0,
      voices(next) {
        type = next;
        engine.dispatchEvent(new Event("voiceschanged"));
      },
      event(event) {
        const prior = current;
        current = undefined;
        engine.speaking = false;
        if (event === "complete") prior?.onend?.();
        if (event === "error") prior?.onerror?.({ error: "synthesis-failed" });
      },
      background(hidden) {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: hidden ? "hidden" : "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      },
    };
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: engine });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: Utterance });
    window.readAloudFixture = fixture;
  }, initial);
}

async function openReply(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.getByLabel("用户名").fill("audio-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6));
  await page.getByLabel("密码", { exact: true }).fill("local-audio-fixture!");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await expect(page.getByRole("heading", { name: "对话工作区" })).toBeVisible();
  const composer = page.getByRole("textbox", { name: "消息", exact: true });
  await composer.fill("本机朗读合成验收");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const reply = page.getByRole("article", { name: "助手回复" });
  await expect(reply.getByRole("button", { name: "举报", exact: true })).toBeVisible({ timeout: 18_000 });
  return reply;
}

test.describe("browser-local reply speech", () => {
  test.skip(configuredBackend, "Uses only the browser and loopback text fixture.");

  test("omits the action for remote-only voices and responds to a local catalog change", async ({ page }) => {
    await installSpeechFixture(page, "remote");
    const reply = await openReply(page);
    const start = reply.getByRole("button", { name: "本机朗读", exact: true });
    const stop = reply.getByRole("button", { name: "停止朗读", exact: true });
    await expect(start).toHaveCount(0);
    await expect(reply.getByText("流式接续成功。")).toBeVisible();
    expect(await page.evaluate(() => window.readAloudFixture.spoken)).toEqual([]);

    await page.evaluate(() => window.readAloudFixture.voices("local"));
    await start.focus();
    await page.keyboard.press("Enter");
    await expect(stop).toBeFocused();
    expect(await page.evaluate(() => window.readAloudFixture.spoken)).toEqual([{
      text: "首段回答。流式接续成功。\n\n| 键 | 值 |\n| --- | --- |\n| 示例 | 生效 |\n\n```js\nconst value = 1;\n```\n\n[可访问链接](https://example.com) [无效链接](javascript:alert%281%29)",
      voice: "local", local: true,
    }]);
    await page.evaluate(() => window.readAloudFixture.voices("remote"));
    await expect(start).toHaveCount(0);
    await expect(stop).toHaveCount(0);
    await expect(reply.getByText("本机语音已不可用。")).toBeVisible();
    expect(await page.evaluate(() => window.readAloudFixture.canceled)).toBe(1);
    await expect(reply.getByRole("table")).toBeVisible();
  });

  test("syncs playback, error, cancel, background, modal and conversation/logout exits", async ({ page }) => {
    await installSpeechFixture(page, "local");
    const reply = await openReply(page);
    const start = reply.getByRole("button", { name: "本机朗读", exact: true });
    const stop = reply.getByRole("button", { name: "停止朗读", exact: true });
    await page.getByText("对话操作", { exact: true }).click();
    await page.getByRole("button", { name: "重命名", exact: true }).click();
    await page.getByLabel("对话名称").fill("朗读中的对话");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("heading", { name: "朗读中的对话", exact: true })).toBeVisible();

    await start.click();
    await stop.click();
    await expect(start).toBeVisible();
    expect(await page.evaluate(() => window.readAloudFixture.canceled)).toBe(1);
    await start.click();
    await page.evaluate(() => window.readAloudFixture.event("complete"));
    await expect(start).toBeVisible();
    expect(await page.evaluate(() => window.readAloudFixture.canceled)).toBe(1);
    await start.click();
    await page.evaluate(() => window.readAloudFixture.event("external-stop"));
    await expect(start).toBeVisible();
    await start.click();
    await page.evaluate(() => window.readAloudFixture.event("error"));
    await expect(reply.getByText("本机朗读失败。")).toBeVisible();

    await start.click();
    await page.evaluate(() => window.readAloudFixture.background(true));
    await expect(start).toBeVisible();
    await page.evaluate(() => window.readAloudFixture.background(false));
    expect(await page.evaluate(() => window.readAloudFixture.spoken.length)).toBe(5);
    await start.click();
    await reply.getByRole("button", { name: "举报", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "举报回复" })).toBeVisible();
    expect(await page.evaluate(() => window.readAloudFixture.canceled)).toBe(4);
    await page.keyboard.press("Escape");
    await expect(start).toBeVisible();

    await start.click();
    const existing = page.getByRole("navigation", { name: "对话列表" }).getByRole("button", { name: /^朗读中的对话/ });
    await page.getByRole("button", { name: "新建对话", exact: true }).click();
    await expect(reply).toHaveCount(0);
    expect(await page.evaluate(() => window.readAloudFixture.canceled)).toBe(5);
    await existing.click();
    await start.click();
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(page.getByRole("heading", { name: "登录青屿" })).toBeVisible();
    expect(await page.evaluate(() => window.readAloudFixture.canceled)).toBe(6);
    expect(await page.evaluate(() => window.readAloudFixture.spoken.every((item) => item.local === true))).toBe(true);
  });

  test("starts and stops native playback on an opted-in browser with local voices", async ({ page }) => {
    test.skip(process.env.ASSISTANT_WEB_TEST_NATIVE_SPEECH !== "true", "Opt in on a machine with a native local voice.");
    await page.addInitScript(() => {
      const engine = window.speechSynthesis;
      const speak = engine.speak;
      window.nativeReplySpeech = { selectedLocal: null, started: false };
      engine.speak = function (utterance) {
        window.nativeReplySpeech.selectedLocal = utterance.voice?.localService ?? null;
        utterance.addEventListener("start", () => { window.nativeReplySpeech.started = true; }, { once: true });
        return speak.call(this, utterance);
      };
    });
    const reply = await openReply(page);
    const start = reply.getByRole("button", { name: "本机朗读", exact: true });
    await start.click();
    await expect.poll(() => page.evaluate(() => window.nativeReplySpeech)).toEqual({ selectedLocal: true, started: true });
    await reply.getByRole("button", { name: "停止朗读", exact: true }).click();
    await expect(start).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.speechSynthesis.speaking)).toBe(false);
  });
});
