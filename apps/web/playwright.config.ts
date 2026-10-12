import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    // Optional: use an already-installed Chromium (e.g. PW_CHROMIUM_PATH=/opt/pw-browsers/chromium).
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  // Start the API and web app unless they are already running (docker compose / dev servers).
  webServer: [
    { command: "pnpm --filter @collabcode/api start", url: "http://localhost:4000/health", reuseExistingServer: true, cwd: "../.." },
    { command: "pnpm --filter @collabcode/web dev", url: "http://localhost:3000", reuseExistingServer: true, cwd: "../.." },
  ],
});
