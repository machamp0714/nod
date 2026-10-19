import { expect, test } from "./fixtures";
import { setLayout } from "./support/issue-list";

test.use({ dataset: "issue-list" });

const rows = (page: import("@playwright/test").Page) => page.getByRole("table").locator("tbody tr");

test("Projects は Active の Project を列つきで出す", async ({ page }) => {
  await page.goto("/projects");
  await expect(page.getByRole("table").getByRole("columnheader")).toHaveText(["Name", "Workspace", "Progress", "健全性", "LLM の状況", "Updated"]);
  await expect(rows(page)).toHaveCount(4);
  const search = page.getByRole("row", { name: /検索 API の高速化/ });
  await expect(search).toContainText("0/3");
  await expect(search).toContainText("入力待ち 1");
  await expect(search).toContainText("api-server");
  await expect(page.getByRole("row", { name: /nod CLI/ })).toHaveCount(0);
});

test("Completed のタブで完了した Project を出す", async ({ page }) => {
  await page.goto("/projects");
  await page.getByRole("tablist", { name: "Project の絞り込み" }).getByRole("tab", { name: "Completed" }).click();
  await expect(page).toHaveURL(/tab=completed/);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText("nod CLI");
});

test("不正な tab は Active に戻す", async ({ page }) => {
  await page.goto("/projects?tab=zzz");
  await expect(page.getByRole("tab", { name: "Active" })).toHaveAttribute("aria-selected", "true");
  await expect(rows(page)).toHaveCount(4);
});

test("Project 名を押すと Project 詳細に移る", async ({ page }) => {
  await page.goto("/projects");
  await page.getByRole("link", { name: "決済まわり" }).click();
  await expect(page).toHaveURL(/\/projects\/2$/);
  await expect(page.getByRole("heading", { level: 1, name: "決済まわり" })).toBeVisible();
});

test("New project は準備中で押せない", async ({ page }) => {
  await page.goto("/projects");
  await expect(page.getByRole("button", { name: "New project" })).toBeDisabled();
});

test("Project 詳細は API からその Project の Issue、件数、Documents を読む", async ({ page }) => {
  // ダミーデータにはない変更を API で加え、画面が API を読んでいることを確かめる
  const moved = await page.request.post("/api/issues/API-4/update", { data: { projectRef: "1" } });
  expect(moved.status()).toBe(200);
  await page.goto("/projects/1");
  await expect(page.getByRole("heading", { level: 1, name: "検索 API の高速化" })).toBeVisible();
  await expect(rows(page)).toHaveCount(4);
  for (const id of ["API-12", "API-13", "API-9", "API-4"]) {
    await expect(page.getByRole("cell", { name: id, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("tab", { name: "Ready 1", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Needs Clarification 1", exact: true })).toBeVisible();
  await expect(page.getByText("0/4 完了")).toBeVisible();
  await expect(page.getByRole("link", { name: "検索 API の高速化 設計" })).toHaveAttribute("href", "/documents/1");
  await expect(page.getByText("Filter", { exact: true })).toHaveCount(0);
});

// design/nod.pen「Project詳細｜一覧（正本）」（DOM7I）：概要・Documents・Milestones → Issue 一覧 → 進捗報告の順（NOD-29）
test("Project 詳細は Issue 一覧を進捗報告より上に出し、Board でも順序を保つ", async ({ page }) => {
  await page.goto("/projects/1");
  const top = async (locator: import("@playwright/test").Locator) => (await locator.boundingBox())!.y;
  const sections = async () => [
    await top(page.getByRole("heading", { name: "Documents" })),
    await top(page.getByRole("region", { name: "Milestones" })),
    await top(page.getByRole("tab", { name: /^All / })),
    await top(page.getByRole("region", { name: "進捗報告" })),
  ];
  await expect(rows(page)).toHaveCount(3);
  const ascending = (ys: number[]) => ys.slice(1).forEach((y, i) => expect(y).toBeGreaterThan(ys[i]!));
  ascending(await sections());
  // 進捗報告は一覧の表より下に置く
  expect(await top(page.getByRole("region", { name: "進捗報告" }))).toBeGreaterThan(await top(rows(page).last()));

  await page.goto("/projects/1?layout=board");
  await expect(page.getByRole("region", { name: "進捗報告" })).toBeVisible();
  ascending(await sections());
});

test("Project 詳細の Issue 一覧を検索で絞り込んでも、Board に切り替えても、下に置いた進捗報告の下書きを保つ", async ({ page }) => {
  await page.goto("/projects/1");
  const draft = page.getByRole("textbox", { name: "進捗報告の本文" });
  await draft.fill("書きかけの報告");
  await page.getByRole("button", { name: "検索を開く" }).click();
  await page.getByRole("textbox", { name: "検索" }).fill("API-12");
  await expect(rows(page)).toHaveCount(1);
  await expect(page).toHaveURL(/q=API-12/);
  await expect(draft).toHaveValue("書きかけの報告");
  await setLayout(page, "Board");
  await expect(page).toHaveURL(/layout=board/);
  await expect(draft).toHaveValue("書きかけの報告");
});

test("Projects の All は完了した Project も出し、Workspace の列を Issue から集める", async ({ page }) => {
  const moved = await page.request.post("/api/issues/API-4/update", { data: { projectRef: "3" } });
  expect(moved.status()).toBe(200);
  await page.goto("/projects?tab=all");
  await expect(rows(page)).toHaveCount(5);
  const webUi = page.getByRole("row", { name: /nod Web UI/ });
  await expect(webUi).toContainText("api-server");
  await expect(webUi).toContainText("nod");
  await expect(page.getByRole("row", { name: /nod CLI/ })).toContainText("1/1");
});

test("Projects の読み込み中を status として伝える", async ({ page }) => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  // 一覧は ?includeClosed=true を付けて読むため、クエリを除いたパスで止める。
  await page.route((url) => url.pathname === "/api/projects", async (route) => {
    await waiting;
    await route.continue();
  });
  try {
    await page.goto("/projects");
    await expect(page.getByRole("status")).toHaveText("読み込み中…");
    release();
    await expect(rows(page)).toHaveCount(4);
    await expect(page.getByRole("status")).toHaveCount(0);
  } finally {
    release();
  }
});
