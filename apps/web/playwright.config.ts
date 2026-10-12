import { defineConfig } from "@playwright/test";

// Defaults for local runs / CI; override via the environment. These are development values only.
const env = {
  DATABASE_URL: "postgresql://collabcode:collabcode@localhost:5432/collabcode",
  COLLAB_JWT_SECRET: "dev-only-collab-secret-change-me-please-0123456789",
  COLLAB_PUBLIC_URL: "ws://localhost:1234",
  WEB_ORIGIN: "http://localhost:3000",
  API_URL: "http://localhost:4000",
  AUTH_SECRET: "e2e-auth-secret",
  AUTH_URL: "http://localhost:3000",
  DEV_LOGIN: "true",
  ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
};

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    // Optional: use an already-installed Chromium (e.g. PW_CHROMIUM_PATH=/opt/pw-browsers/chromium).
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  // Start the API and web app unless they are already running (docker compose / dev servers).
  webServer: [
    { command: "pnpm --filter @collabcode/collab start", url: "http://localhost:1234/health", reuseExistingServer: true, cwd: "../..", env },
    { command: "pnpm --filter @collabcode/api start", url: "http://localhost:4000/health", reuseExistingServer: true, cwd: "../..", env },
    { command: "pnpm --filter @collabcode/web dev", url: "http://localhost:3000", reuseExistingServer: true, cwd: "../..", env, timeout: 120_000 },
  ],
});
