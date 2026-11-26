import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { AssistantClient } from "@ai-assistant/contracts";

const run = promisify(execFile);
const fixture = join(__dirname, "../../../qa/assistant-project-pdf-smoke.mjs");

test("extracts an approved private PDF as literal text and withdraws the open preview", async ({ page }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  test.skip(!origin || process.env.ASSISTANT_WEB_TEST_PROJECT_PDF !== "true", "Requires the isolated real PDF scanner.");
  test.setTimeout(65_000);
  const username = `qa-pdf-web-${randomUUID().slice(0, 8)}`;
  const password = "Qa.Pdf-Web-only-fixture!";
  const api = new AssistantClient({ origin: origin! });
  await api.replaceSession(await api.register({ username, password }));
  const project = await api.createProject({ name: "合成 PDF 项目" });
  const { stdout } = await run(process.execPath, [fixture, "--profile-fixture-base64"]);
  const bytes = Buffer.from(stdout.trim(), "base64");
  const canonical = "Basic PDF contains <em>plain text</em>.\nQuarter (four) C:\\files\n";

  const uploads: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/pdf-attachments")) {
      uploads.push(request.headers()["content-type"]);
    }
  });
  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page.getByRole("dialog", { name: "项目", exact: true })
    .getByRole("button", { name: "查看项目 PDF 合成 PDF 项目" }).click();
  const panel = page.getByRole("dialog", { name: "项目PDF", exact: true });
  const chooser = panel.getByLabel("选择 PDF 文件");
  await chooser.setInputFiles({ name: "over.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(32769) });
  await expect(panel.getByRole("alert")).toContainText("32 KiB");
  expect(uploads).toHaveLength(0);
  await chooser.setInputFiles({ name: "synthetic.pdf", mimeType: "application/pdf", buffer: bytes });
  expect(uploads).toHaveLength(0);
  await panel.getByRole("button", { name: "上传 PDF" }).click();
  await expect(panel.getByText("已接收PDF。可刷新查看检查结果。")).toBeVisible();
  expect(uploads).toEqual(["application/pdf"]);

  await expect.poll(async () => (await api.listProjectPdfAttachments(project.id)).items[0]?.state,
    { timeout: 20_000 }).toBe("approved");
  const [record] = (await api.listProjectPdfAttachments(project.id)).items;
  await panel.getByRole("button", { name: "刷新状态" }).click();
  await panel.getByRole("button", { name: "预览提取文本" }).click();
  const preview = panel.locator("figure pre");
  await expect(preview).toBeVisible();
  expect(await preview.textContent()).toBe(canonical);
  await expect(panel.locator("figure em, figure iframe, figure object, figure embed")).toHaveCount(0);

  const pending = page.waitForEvent("download");
  await panel.getByRole("button", { name: "下载 提取文本" }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe("extracted.txt");
  expect(await readFile(await download.path(), "utf8")).toBe(canonical);
  await download.delete();

  await api.deleteProjectPdfAttachment(project.id, record.id);
  await expect(preview).toHaveCount(0, { timeout: 12_000 });
  await expect(api.getProjectPdfAttachmentText(project.id, record.id)).rejects.toMatchObject({ status: 404 });
  await panel.getByRole("button", { name: "刷新状态" }).click();
  await expect(panel.getByText("暂无PDF附件。")).toBeVisible();

  const extended = process.env.ASSISTANT_WEB_TEST_GENERAL_PDF_FILE;
  if (extended) {
    await expect(panel.getByText(/最多 8 页/)).toBeVisible();
    await chooser.setInputFiles({ name: "compressed-multilingual.pdf", mimeType: "application/pdf", buffer: await readFile(extended) });
    expect(uploads).toHaveLength(1);
    await panel.getByRole("button", { name: "上传 PDF" }).click();
    await expect.poll(async () => (await api.listProjectPdfAttachments(project.id)).items[0]?.state,
      { timeout: 20_000 }).toBe("approved");
    expect(uploads).toHaveLength(2);
    await panel.getByRole("button", { name: "刷新状态" }).click();
    await panel.getByRole("button", { name: "预览提取文本" }).click();
    await expect(preview).toBeVisible();
    const normalized = "中文\n\né\n";
    expect(await preview.textContent()).toBe(normalized);
    const saving = page.waitForEvent("download");
    await panel.getByRole("button", { name: "下载 提取文本" }).click();
    const file = await saving;
    expect(file.suggestedFilename()).toBe("extracted.txt");
    expect(await readFile(await file.path())).toEqual(Buffer.from(normalized));
    await file.delete();
    const [multilingual] = (await api.listProjectPdfAttachments(project.id)).items;
    await api.deleteProjectPdfAttachment(project.id, multilingual.id);
  }
});

test("labels scan-derived text and issues no grant before the owner confirms", async ({ page }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  const scanned = process.env.ASSISTANT_WEB_TEST_OCR_PDF_FILE;
  test.skip(!origin || !scanned, "Requires the isolated OCR worker and synthetic scan.");
  test.setTimeout(65_000);
  const username = `qa-ocr-web-${randomUUID().slice(0, 8)}`;
  const password = "Qa.Scan-Web-only-fixture!";
  const api = new AssistantClient({ origin: origin! });
  await api.replaceSession(await api.register({ username, password }));
  const project = await api.createProject({ name: "合成扫描项目" });
  const expected = "扫描件 OCR 文本，可能有误，请对照原件。\n"
    + "Scanned OCR text may contain errors. Check the original.\n\n中文测试\n工作空间\nENGLISH OCR 12345\n";
  const grants: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/download-grant")) {
      grants.push(request.headers()["x-assistant-ocr-reviewed"]);
    }
  });
  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page.getByRole("dialog", { name: "项目", exact: true })
    .getByRole("button", { name: "查看项目 PDF 合成扫描项目" }).click();
  const panel = page.getByRole("dialog", { name: "项目PDF", exact: true });
  await expect(panel.getByText(/支持合格的单页扫描件识别/)).toBeVisible();
  await panel.getByLabel("选择 PDF 文件").setInputFiles(scanned!);
  await panel.getByRole("button", { name: "上传 PDF" }).click();
  await expect.poll(async () => (await api.listProjectPdfAttachments(project.id)).items[0]?.approximateText,
    { timeout: 20_000 }).toBe(true);
  await panel.getByRole("button", { name: "刷新状态" }).click();
  await expect(panel.getByText("扫描件 OCR 文本 · 可能有误，请对照原件。")).toBeVisible();
  await panel.getByRole("button", { name: "预览提取文本" }).click();
  const preview = panel.locator("figure pre");
  await expect(preview).toBeVisible();
  expect(await preview.textContent()).toBe(expected);

  const download = panel.getByRole("button", { name: "下载 提取文本" });
  const confirm = panel.getByRole("button", { name: "确认并下载 OCR 文本" });
  await download.click();
  await expect(confirm).toBeVisible();
  await panel.getByRole("button", { name: "取消", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  expect(grants).toEqual([]);
  await download.click();
  const saving = page.waitForEvent("download");
  await confirm.click();
  const file = await saving;
  expect(file.suggestedFilename()).toBe("extracted.txt");
  expect(await readFile(await file.path())).toEqual(Buffer.from(expected));
  expect(grants).toEqual(["true"]);
  await file.delete();

  await download.click();
  const [record] = (await api.listProjectPdfAttachments(project.id)).items;
  await api.deleteProjectPdfAttachment(project.id, record.id);
  await confirm.click();
  await expect(panel.getByRole("alert")).toBeVisible();
  expect(grants).toEqual(["true"]);
  await expect(preview).toHaveCount(0, { timeout: 12_000 });
});
