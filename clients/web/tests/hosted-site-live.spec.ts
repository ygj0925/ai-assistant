import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { AssistantClient } from "@ai-assistant/contracts";

test("publishes, updates and rolls back a reviewed website at an isolated anonymous address", async ({ page, browser }) => {
  const origin = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
  test.skip(!origin || process.env.ASSISTANT_WEB_TEST_HOSTED_SITE !== "true", "Requires isolated localhost hosting.");
  test.setTimeout(65_000);

  const username = `qa-host-web-${randomUUID().slice(0, 8)}`;
  const password = "Qa.Site-Web-fixture!";
  const client = new AssistantClient({ origin: origin! });
  await client.replaceSession(await client.register({ username, password }));
  const project = await client.createProject({ name: "站点验收项目" });
  const title = "站点公开合成草案";
  const firstHeading = "第一版报告";
  const secondHeading = "第二版报告";
  const literal = '<img src="http://localhost:39997/forbidden-site-request">';
  const website = { heading: firstHeading, introduction: literal,
    sections: [{ title: "进度", paragraphs: ["合成发布内容，仅用于浏览器测试。"] }] };
  const item = await client.createArtifact({ projectId: project.id, title, format: "webpage", website }, randomUUID());
  const changed = await client.createArtifactVersion(item.id, { baseVersionId: item.head.id, title,
    website: { ...website, heading: secondHeading } });

  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().endsWith("/hosting")) requests.push(request.url());
  });
  await page.goto("/");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "文稿", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "文稿" });
  await dialog.getByRole("button", { name: `${title} · 版本 2` }).click();
  const site = dialog.getByRole("region", { name: "站点公开托管" });
  const iframe = site.locator('[title="公开发布前预览"]');

  async function approve(number: number, expectedHeading: string, priorWrites: number) {
    await page.bringToFront();
    await site.getByRole("button", { name: `审核公开版本 ${number}` }).click();
    await expect(iframe).toHaveAttribute("sandbox", "");
    await expect(iframe.contentFrame().getByRole("heading", { name: expectedHeading, exact: true })).toBeVisible();
    expect(requests).toHaveLength(priorWrites);
    await site.getByRole("button", { name: `确认公开版本 ${number}` }).click();
    await expect(site.getByText(`版本 ${number} 已公开。`, { exact: true })).toBeVisible();
    return (await site.getByRole("link", { name: "打开公开站点" }).getAttribute("href"))!;
  }

  await dialog.getByRole("button", { name: "版本 1", exact: true }).click();
  const address = await approve(1, firstHeading, 0);
  expect(new URL(address).hostname).toBe("localhost");
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    const visitor = await context.newPage();
    const attempted: string[] = [];
    await visitor.route("**/*", (route) => {
      if (route.request().url() === address) return route.continue();
      attempted.push(route.request().url());
      return route.abort();
    });
    const initial = await visitor.goto(address);
    expect(initial?.status()).toBe(200);
    expect(initial?.headers()["cache-control"]).toContain("no-store");
    expect(initial?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    await expect(visitor.getByRole("heading", { name: firstHeading })).toBeVisible();
    await expect(visitor.getByText(literal, { exact: true })).toBeVisible();
    await expect(visitor.locator("script, img, form, iframe")).toHaveCount(0);
    expect(await context.cookies()).toEqual([]);
    expect(attempted).toEqual([]);

    if (process.env.ASSISTANT_WEB_TEST_PUBLIC_TARGET_REPORTS === "true") {
      const reporterName = `qa-site-reporter-${randomUUID().slice(0, 8)}`;
      const reporter = new AssistantClient({ origin: origin! });
      await reporter.replaceSession(await reporter.register({ username: reporterName, password }));
      const reportingContext = await browser.newContext();
      try {
        const reviewer = await reportingContext.newPage();
        const external: string[] = [];
        reviewer.on("request", (request) => {
          if (new URL(request.url()).hostname === "example.invalid") external.push(request.url());
        });
        await reviewer.goto("/");
        await reviewer.getByLabel("用户名").fill(reporterName);
        await reviewer.getByLabel("密码", { exact: true }).fill(password);
        await reviewer.getByRole("button", { name: "登录", exact: true }).click();
        await reviewer.getByRole("button", { name: `账号与数据 · ${reporterName}` }).click();
        const reporting = reviewer.getByRole("region", { name: "举报公开站点" });
        const input = reporting.getByLabel("公开站点链接");
        const verifyVersion = reporting.getByRole("button", { name: "核对发布版本" });
        await input.fill(`https://example.invalid${new URL(address).pathname}`);
        await verifyVersion.click();
        await expect(reporting.getByRole("alert")).toContainText("不匹配");
        expect(external).toEqual([]);
        await input.fill(address);
        await verifyVersion.click();
        await expect(reporting.getByRole("link", { name: "打开已核对的站点" })).toHaveAttribute("href", address);
        const metadata = await reporter.getHostedSiteReportTarget(new URL(address).pathname.split("/").at(-1)!);
        expect(initial?.headers()["x-assistant-publication-revision"]).toBe(metadata.revision);
        await reporting.getByRole("button", { name: "举报已核对的站点" }).click();
        const report = reviewer.getByRole("dialog", { name: "举报公开站点" });
        await report.getByLabel("举报原因").selectOption("privacy");
        const receipt = reviewer.waitForResponse((response) => response.url().endsWith("/api/assistant/v1/reports")
          && response.request().method() === "POST");
        await report.getByRole("button", { name: "提交举报" }).click();
        const submitted = await receipt;
        expect(submitted.status()).toBe(201);
        expect(submitted.request().postDataJSON()).toEqual({ targetType: "hosted_site", targetId: metadata.siteId,
          revision: metadata.revision, reason: "privacy" });
        await expect(reporting.getByText("举报已提交。", { exact: true })).toBeVisible();
      } finally {
        await reportingContext.close();
      }
    }

    await page.bringToFront();
    await dialog.getByRole("button", { name: "版本 2（当前）", exact: true }).click();
    expect(await approve(2, secondHeading, 1)).toBe(address);
    expect((await visitor.reload())?.status()).toBe(200);
    await expect(visitor.getByRole("heading", { name: secondHeading })).toBeVisible();
    await page.bringToFront();
    await dialog.getByRole("button", { name: "版本 1", exact: true }).click();
    expect(await approve(1, firstHeading, 2)).toBe(address);
    expect((await visitor.reload())?.status()).toBe(200);
    await expect(visitor.getByRole("heading", { name: firstHeading })).toBeVisible();

    await page.bringToFront();
    await site.getByRole("button", { name: "刷新发布状态" }).click();
    await site.getByRole("button", { name: "撤回公开站点", exact: true }).click();
    await site.getByRole("button", { name: "确认撤回公开站点", exact: true }).click();
    await expect(site.getByText("已撤回公开站点。", { exact: true })).toBeVisible();
    const retired = await visitor.reload();
    expect(retired?.status()).toBe(404);
    expect(retired?.headers()["cache-control"]).toContain("no-store");
    await expect(visitor.getByRole("heading", { name: "站点暂不可用" })).toBeVisible();
    await expect(visitor.getByText(firstHeading)).toHaveCount(0);
    expect(await client.getArtifact(item.id)).toMatchObject({ headVersionId: changed.head.id });
    expect((await client.getArtifactVersion(item.id, item.head.id)).id).toBe(item.head.id);
  } finally {
    await context.close();
  }
});
