import { test as base, expect, type Page } from "@playwright/test";
import { type NodData, nodData, resetData } from "./support/nod";

interface Options {
  dataset: string; // 各テストの前に入れるデータセット。既定は空の DB
  allowedConsoleErrors: RegExp[]; // 合うコンソールのエラーでは失敗させない
}

interface Fixtures {
  resetDatabase: void;
  consoleErrors: string[];
  nod: NodData;
}

export const test = base.extend<Fixtures & Options>({
  // test.use({ dataset: "issue-list" }) で、e2e/datasets/issue-list.ts を入れる
  dataset: ["empty", { option: true }],
  // API がわざと 4xx を返すテストだけ、test.use({ allowedConsoleErrors: [/status of 409/] }) で許す
  allowedConsoleErrors: [[], { option: true }],
  // すべてのテストは1つの DB を共有するため、各テストの前に DB を空にしてデータセットを入れる
  resetDatabase: [
    async ({ dataset }, use) => {
      await resetData(dataset);
      await use();
    },
    { auto: true },
  ],
  consoleErrors: [
    async ({ page, allowedConsoleErrors }, use) => {
      const errors: string[] = [];
      const record = (text: string) => {
        if (!allowedConsoleErrors.some((pattern) => pattern.test(text))) errors.push(text);
      };
      page.on("console", (message) => {
        if (message.type() === "error") record(message.text());
      });
      page.on("pageerror", (error) => record(error.message));
      await use(errors);
      expect(errors, "コンソールにエラーが出ている").toEqual([]);
    },
    { auto: true },
  ],
  nod: async ({}, use) => {
    await use(nodData());
  },
});

// SSE の接続が ready になるまで待つ。外部の書き込みを試すテストは、書く前にこれを呼ぶ。
// ready の前に書くと、ready による読み直しで画面が変わり、change の経路を試せないためである
export async function waitForServerEvents(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-server-events", "ready");
}

export { expect };
