import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { API_PORT, WEB_PORT } from "./e2e/support/ports";

// e2e は本物の server を一時ディレクトリの DB（<NOD_E2E_DIR>/nod.db）で動かす。
// 設定はワーカーでも読み直されるため、最初に作ったディレクトリを環境変数に置き、server とすべてのワーカーで使い回す
const dir = (process.env.NOD_E2E_DIR ??= mkdtempSync(join(tmpdir(), "nod-e2e-")));

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  // すべてのテストが1つの DB を共有し、各テストの前に DB を戻すため、1つずつ実行する
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  // 一時ディレクトリを最後に消す
  globalTeardown: "./e2e/support/teardown.ts",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    viewport: { width: 1440, height: 960 },
  },
  webServer: [
    {
      command: "bun e2e/server.ts",
      url: `http://127.0.0.1:${API_PORT}/api/workspaces`,
      env: { NOD_E2E_DIR: dir },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `bun run dev --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      env: { NOD_API_URL: `http://127.0.0.1:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
