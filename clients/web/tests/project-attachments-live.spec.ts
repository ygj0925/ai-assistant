import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

function pngChunk(type: string, data: Buffer) {
  const content = Buffer.concat([Buffer.from(type), data]);
  let checksum = 0xffffffff;
  for (const byte of content) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      const polynomial = checksum & 1 ? 0xedb88320 : 0;
      checksum = (checksum >>> 1) ^ polynomial;
    }
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((checksum ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, content, crc]);
}

const width = 160;
const height = 128;
const header = Buffer.alloc(13);
header.writeUInt32BE(width);
header.writeUInt32BE(height, 4);
header[8] = 8;
header[9] = 6;
const pixels = Buffer.alloc(height * (width * 4 + 1));
const png = Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"),
  pngChunk("IHDR", header),
  // Level zero keeps the test file above the general JSON proxy size limit.
  pngChunk("IDAT", deflateSync(pixels, { level: 0 })),
  pngChunk("IEND", Buffer.alloc(0)),
]);

test("uploads, scans, previews, downloads and revokes a private PNG", async ({ page }) => {
  test.skip(!process.env.ASSISTANT_WEB_TEST_API_ORIGIN || process.env.ASSISTANT_WEB_TEST_ATTACHMENTS !== "true",
    "Requires the private object store and scanner in the loopback backend.");
  await page.goto("/");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.getByLabel("用户名").fill(`qa-image-web-${Date.now().toString(36)}`);
  await page.getByLabel("密码", { exact: true }).fill("Qa.Attachment-fixture!");
  const registered = page.waitForResponse((response) => response.url().endsWith("/auth/register"));
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  expect((await registered).status()).toBe(201);
  await page.getByRole("button", { name: "项目", exact: true }).click();
  const projects = page.getByRole("dialog", { name: "项目", exact: true });
  await projects.getByRole("button", { name: "新建项目" }).click();
  const editor = page.getByRole("dialog", { name: "新建项目" });
  await editor.getByLabel("项目名称").fill("合成图像附件");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  const opener = projects.getByRole("button", { name: "查看项目图像 合成图像附件" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "项目图像" });
  const input = dialog.getByLabel("选择 PNG 文件");
  const submit = dialog.getByRole("button", { name: "上传 PNG" });
  await input.setInputFiles({ name: "超出大小.png", mimeType: "image/png", buffer: Buffer.alloc(1024 * 1024 + 1) });
  await expect(dialog.getByRole("alert")).toContainText("1 MiB");
  await expect(submit).toBeDisabled();
  await input.setInputFiles({ name: "合成样本.png", mimeType: "image/png", buffer: png });
  const receipt = page.waitForResponse((response) => response.url().endsWith("/attachments") && response.request().method() === "POST");
  await submit.click();
  expect((await receipt).status()).toBe(202);
  const approved = dialog.getByText("扫描通过", { exact: true });
  await expect.poll(async () => {
    await dialog.getByRole("button", { name: "刷新状态" }).click();
    return await approved.count();
  }, { timeout: 15_000 }).toBe(1);
  await dialog.getByRole("button", { name: "预览", exact: true }).click();
  const image = dialog.getByRole("img", { name: "项目上传的图像预览" });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(width);
  const pending = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载 PNG" }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe("image.png");
  expect(await readFile(await download.path())).toEqual(png);
  await download.delete();
  await dialog.getByRole("button", { name: "删除图像" }).click();
  await dialog.getByRole("button", { name: "确认删除" }).click();
  await expect(dialog.getByText("暂无图像附件。")).toBeVisible();
  await expect(image).toHaveCount(0);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(opener).toBeFocused();
  await projects.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "退出登录" }).click();
});
