import { defineConfig, devices } from "@playwright/test";

const api = process.env.ASSISTANT_WEB_TEST_API_ORIGIN;
if (api) {
  const url = new URL(api);
  if (!["http:", "https:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
    throw new Error("ASSISTANT_WEB_TEST_API_ORIGIN must be a bare HTTP(S) loopback origin.");
  }
}

const baseURL = "http://127.0.0.1:3100";
const fixture = "http://127.0.0.1:3101";
const production = process.env.ASSISTANT_WEB_TEST_PRODUCTION === "true";

export default defineConfig({
  testDir: "./tests",
  workers: 1,
  reporter: "list",
  timeout: 45_000,
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    actionTimeout: 8_000,
    channel: process.env.ASSISTANT_WEB_TEST_BROWSER === "chrome" ? "chrome" : undefined,
    trace: "retain-on-failure",
  },
  webServer: [
    ...(!api ? [{ command: "node tests/fixture.mjs", url: fixture + "/health" }] : []),
    {
      command: `npm run ${production ? "start" : "dev"} -- --hostname 127.0.0.1 --port 3100`,
      url: baseURL,
      env: { ASSISTANT_API_ORIGIN: api || fixture },
      stdout: production ? "pipe" : "ignore",
      timeout: 120_000,
    },
  ],
});
