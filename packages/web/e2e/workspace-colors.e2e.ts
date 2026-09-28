import type { Page } from "@playwright/test";
import type { Workspace } from "../src/api/types";
import { expect, test, waitForServerEvents } from "./fixtures";

test.use({ dataset: "workspace-colors" });

function rgb(hex: string): string {
  return `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
}

async function expectSavedColors(page: Page, keys = ["API", "WEB", "NOD", "BLOG"]) {
  const rows: Workspace[] = await (await page.request.get("/api/workspaces")).json();
  expect(new Set(rows.map((row) => row.color)).size).toBe(rows.length);
  for (const key of keys) {
    const workspace = rows.find((row) => row.key === key)!;
    const badges = page.locator(`[data-workspace-key="${key}"]`);
    await expect(badges.first()).toBeVisible();
    for (const badge of await badges.all()) {
      await expect(badge).toHaveAttribute("data-workspace-color-state", "ready");
      await expect(badge.locator(":scope > span").first()).toHaveCSS("background-color", rgb(workspace.color));
    }
  }
  return rows;
}

test("APIとWEBの目印は保存色を使って異なる色になる", async ({ page }) => {
  await page.goto("/issues");
  const rows: Workspace[] = await (await page.request.get("/api/workspaces")).json();
  expect(rows.find((row) => row.key === "API")!.color).not.toBe(rows.find((row) => row.key === "WEB")!.color);
  // 変更前のselectorでも表示色の不一致を検出し、データ属性がないだけの失敗にしない。
  for (const key of ["API", "WEB"]) {
    await expect(page.locator(`span[title="${key}"] > span`).first()).toHaveCSS("background-color", rgb(rows.find((row) => row.key === key)!.color));
  }
});

for (const route of ["/issues", "/views/1", "/projects/1", "/projects", "/inbox", "/triage", "/reviews"]) {
  test(`${route}の既存Workspace目印が保存値と一致する`, async ({ page }) => {
    await page.goto(route);
    await expectSavedColors(page);
  });
}

for (const route of ["/issues", "/views/1", "/projects/1"]) {
  for (const layout of ["list", "board"]) {
    test(`${route}の${layout}グループ見出しに同じ保存色を使う`, async ({ page }) => {
      await page.goto(`${route}?groupBy=workspace&layout=${layout}`);
      await expect(page.locator('section[aria-label="Workspace API"]')).toBeVisible();
      await expectSavedColors(page);
    });
  }
}

test("Issue詳細のパンくずとプロパティで同じ保存色になる", async ({ page }) => {
  await page.goto("/issues/API-1");
  await expect(page.locator('[data-workspace-key="API"]')).toHaveCount(2);
  await expectSavedColors(page, ["API"]);
});

test("Workspace取得中は仮色を表示せず、取得後に保存色だけを表示する", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/workspaces", async (route) => { await gate; await route.continue(); });
  try {
    await page.goto("/inbox");
    const badge = page.locator('[data-workspace-key="API"]').first();
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute("data-workspace-color-state", "pending");
    await expect(badge.locator(":scope > span").first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(badge).toHaveText("API");
    release();
    await expectSavedColors(page);
  } finally { release(); }
});

test("未知キーと不正色の応答は透明な目印と文字を残す", async ({ page }) => {
  await page.route("**/api/workspaces", async (route) => {
    const response = await route.fetch();
    const rows: Workspace[] = await response.json();
    await route.fulfill({ json: rows.filter((row) => row.key !== "API").map((row) => row.key === "WEB" ? { ...row, color: "invalid" } : row) });
  });
  await page.goto("/inbox");
  for (const key of ["API", "WEB"]) {
    const badge = page.locator(`[data-workspace-key="${key}"]`).first();
    await expect(badge).toHaveAttribute("data-workspace-color-state", "missing");
    await expect(badge.locator(":scope > span").first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(badge).toContainText(key);
  }
});

test.describe("Workspace取得の障害", () => {
  test.use({ allowedConsoleErrors: [/status of 503/] });

  test("取得失敗時は文字を残して色の取得失敗を示す", async ({ page }) => {
    await page.route("**/api/workspaces", (route) => route.fulfill({ status: 503, json: { error: { code: "DB_BUSY", message: "再試行してください" } } }));
    await page.goto("/inbox");
    const badge = page.locator('[data-workspace-key="API"]').first();
    await expect(badge).toHaveAttribute("data-workspace-color-state", "error", { timeout: 15000 });
    await expect(badge).toHaveAttribute("title", "API（Workspace の色を取得できません）");
    await expect(badge).toHaveText("API");
    await expect(badge.locator(":scope > span").first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  });

  test("SSEで再取得が失敗しても既存キャッシュの保存色を保つ", async ({ page, nod }) => {
    await page.goto("/inbox");
    await waitForServerEvents(page);
    await expectSavedColors(page);
    let failures = 0;
    await page.route("**/api/workspaces", (route) => {
      failures++;
      return route.fulfill({ status: 503, json: { error: { code: "DB_BUSY", message: "再試行してください" } } });
    });
    await nod.codex.initWorkspace({ path: nod.repo("new"), key: "NEW" });
    await expect.poll(() => failures, { timeout: 15000 }).toBeGreaterThanOrEqual(4);
    await expectSavedColors(page);
  });
});

test("SSE・削除再利用・検索・並び順・リロードで既存色が安定する", async ({ page, nod }) => {
  await page.goto("/issues");
  await waitForServerEvents(page);
  const before = await expectSavedColors(page);
  const added = await nod.codex.initWorkspace({ path: nod.repo("new"), key: "NEW" });
  await nod.me.createIssue({ workspaceId: added.workspace.id, title: "NEW 追加課題" });
  await expectSavedColors(page, ["API", "WEB", "NOD", "BLOG", "NEW"]);
  await nod.codex.removeWorkspace("NEW");
  await expect(page.locator('[data-workspace-key="NEW"]')).toHaveCount(0);
  const replacement = await nod.codex.initWorkspace({ path: nod.repo("next"), key: "NEXT" });
  expect(replacement.workspace.color).toBe(added.workspace.color);
  await nod.me.createIssue({ workspaceId: replacement.workspace.id, title: "NEXT 追加課題" });
  await expectSavedColors(page, ["API", "WEB", "NOD", "BLOG", "NEXT"]);
  const after = await nod.codex.listWorkspaces();
  for (const workspace of before) expect(after.find((row) => row.key === workspace.key)?.color).toBe(workspace.color);
  await page.getByRole("textbox", { name: "検索", exact: true }).fill("API");
  await expect(page.locator('tbody [data-workspace-key="WEB"]')).toHaveCount(0);
  await expectSavedColors(page, ["API"]);
  await page.getByRole("textbox", { name: "検索", exact: true }).fill("");
  await expectSavedColors(page);
  const orderBefore = await page.locator("tbody tr td:nth-child(2)").allTextContents();
  await nod.me.updateIssue("WEB-1", { priority: 1 });
  await expect.poll(() => page.locator("tbody tr td:nth-child(2)").allTextContents()).not.toEqual(orderBefore);
  await expectSavedColors(page);
  await page.reload();
  await expectSavedColors(page);
});
