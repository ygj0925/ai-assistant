import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

test.use({ trace: "off", screenshot: "off", video: "off" });

type Fixture = {
  username: string;
  password: string;
  idpUsername: string;
  idpPassword: string;
  workspaceId: string;
  organizationName: string;
  conversationTitle: string;
  outsiderTitle?: string;
  personalTitle?: string;
};

async function enterOrganization(page: Page, fixture: Fixture) {
  await page.goto("/");
  await page.getByLabel("用户名").fill(fixture.username);
  await page.getByLabel("密码", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: `账号与数据 · ${fixture.username}` }).click();
  await page.getByRole("button", { name: "切换工作空间" }).click();
  await page.getByRole("dialog", { name: "切换工作空间" })
    .getByRole("button", { name: `工作空间 ${fixture.workspaceId.slice(0, 8)}`, exact: true }).click();
  await page.getByRole("button", { name: "组织与座席", exact: true }).click();
}

async function signInAtProvider(page: Page, issuer: string, fixture: Fixture) {
  await page.waitForURL((url) => url.origin === new URL(issuer).origin && url.pathname.startsWith(new URL(issuer).pathname + "/"));
  await page.locator("#username").fill(fixture.idpUsername);
  await page.locator("#password").fill(fixture.idpPassword);
  await page.locator("#kc-login").click();
}

test("requires reviewed linking, authenticates at Keycloak and limits the browser session to one organization", async ({ page, browser }) => {
  const fixturePath = process.env.ASSISTANT_WEB_TEST_SSO_FIXTURE;
  const issuer = process.env.ASSISTANT_WEB_SSO_ISSUER;
  test.skip(!fixturePath || !issuer, "Requires real local Keycloak and reserved synthetic members.");
  test.setTimeout(90_000);
  const fixture = JSON.parse(await readFile(fixturePath!, "utf8")) as Fixture;
  await page.goto("/");
  const status = await page.request.get("/api/assistant/v1/organization-sso/status");
  expect(await status.json()).toEqual({ available: true });
  await expect(page.getByRole("link", { name: "使用组织 SSO", exact: true })).toBeVisible();
  const origin = new URL(page.url()).origin;
  const forged = await page.request.post("/organization-sso/start", { headers: { Origin: "http://127.0.0.1:3104" } });
  expect(forged.status()).toBe(403);
  expect((await page.request.post("/api/assistant/v1/organization-sso/complete", { data: {} })).status()).toBe(404);

  await enterOrganization(page, fixture);
  const panel = page.getByRole("region", { name: "组织 SSO 身份" });
  await panel.getByRole("button", { name: "绑定组织身份" }).click();
  await expect(panel.getByLabel("当前青屿账号密码")).toBeVisible();
  await panel.getByRole("button", { name: "取消", exact: true }).click();
  await expect(panel.getByLabel("当前青屿账号密码")).toHaveCount(0);
  await panel.getByRole("button", { name: "绑定组织身份" }).click();
  await panel.getByLabel("当前青屿账号密码").fill(fixture.password);
  await panel.getByRole("button", { name: "确认并前往组织验证" }).click();
  await signInAtProvider(page, issuer!, fixture);
  await expect(page).toHaveURL(origin + "/organization-sso?status=linked");
  await expect(page.getByRole("status").filter({ hasText: "身份核对已完成" })).toBeVisible();

  const sso = await browser.newContext({ baseURL: origin });
  try {
    const scoped = await sso.newPage();
    await scoped.goto("/organization-sso");
    await scoped.getByRole("button", { name: "使用组织账号登录" }).click();
    await signInAtProvider(scoped, issuer!, fixture);
    await expect(scoped).toHaveURL(origin + "/organization-sso");
    await expect(scoped.getByRole("heading", { name: fixture.organizationName })).toBeVisible();
    await expect(scoped.getByRole("link", { name: fixture.conversationTitle })).toBeVisible();
    if (fixture.outsiderTitle) await expect(scoped.getByText(fixture.outsiderTitle, { exact: true })).toHaveCount(0);
    if (fixture.personalTitle) await expect(scoped.getByText(fixture.personalTitle, { exact: true })).toHaveCount(0);
    const cookie = (await sso.cookies(origin + "/organization-sso"))
      .find((entry) => entry.name === "assistant_organization_sso");
    expect(cookie?.httpOnly === true && cookie.sameSite === "Lax" && cookie.path === "/organization-sso").toBe(true);
    expect(await scoped.evaluate(() => document.cookie.includes("assistant_organization_sso="))).toBe(false);
    expect((await scoped.request.get("/api/assistant/v1/auth/me")).status()).toBe(401);
    const ordinary = await scoped.request.get("/api/assistant/v1/auth/me",
      { headers: { Authorization: "Bearer " + cookie!.value } });
    expect(ordinary.status()).toBe(401);
    await scoped.getByRole("link", { name: fixture.conversationTitle }).click();
    await expect(scoped.getByRole("region", { name: "对话摘要" }).getByRole("heading", { name: fixture.conversationTitle })).toBeVisible();
    await scoped.getByRole("button", { name: "退出组织会话" }).click();
    await expect(scoped).toHaveURL(origin + "/organization-sso?status=signed-out");
    expect((await scoped.request.get("/organization-sso/session")).status()).toBe(401);
  } finally {
    await sso.close();
  }

  await enterOrganization(page, fixture);
  await panel.getByRole("button", { name: "解除组织身份绑定" }).click();
  await panel.getByLabel("当前青屿账号密码").fill(fixture.password);
  await panel.getByRole("button", { name: "确认解除绑定" }).click();
  await expect(panel.getByRole("status").filter({ hasText: "已解除组织身份绑定" })).toBeVisible();
});
