import { expect, test } from "./fixtures";

const region = (page: import("@playwright/test").Page, name: string) => page.getByRole("region", { name, exact: true });

test("Issue 詳細は見出し、チップ、パンくず、説明を出す", async ({ page }) => {
  await page.goto("/issues/API-12");
  await expect(page.getByRole("heading", { level: 1, name: "検索 API の N+1 を解消" })).toBeVisible();
  const crumbs = page.getByRole("navigation", { name: "パンくず" });
  await expect(crumbs.getByRole("link", { name: "検索 API の高速化" })).toHaveAttribute("href", "/projects/1");
  await expect(crumbs).toContainText("API-12");
  await expect(region(page, "説明")).toContainText("100 件の検索でクエリが 3 回以下");
  await expect(region(page, "説明").getByRole("button", { name: "編集" })).toBeDisabled();
});

test("計画は進捗を出し、作業中の Task の Step を開いておく", async ({ page }) => {
  await page.goto("/issues/API-12");
  const plan = region(page, "計画");
  await expect(plan).toContainText("Task 1 / 4");
  await expect(plan).toContainText("2026-09-27-search-n1.md");
  await expect(plan.getByRole("button", { name: /インデックス設計/ })).toHaveAttribute("aria-expanded", "true");
  await expect(plan.getByText("複合インデックスの案を作る")).toBeVisible();
  await plan.getByRole("button", { name: /実装/ }).click();
  await expect(plan.getByRole("button", { name: /実装/ })).toHaveAttribute("aria-expanded", "true");
  await expect(plan.getByRole("button", { name: /インデックス設計/ })).toHaveAttribute("aria-expanded", "false");
  await expect(plan.getByText("インデックスを足すマイグレーションを書く")).toBeVisible();
  await expect(plan.getByText("複合インデックスの案を作る")).toHaveCount(0);
});

test("未決事項は決定数 / 総数と、質問ごとの操作を出す", async ({ page }) => {
  await page.goto("/issues/API-12");
  const questions = region(page, "未決事項");
  await expect(questions).toContainText("1 / 2 決定");
  await expect(questions).toContainText("回答：ステージングのダンプで計測してください");
  await expect(questions.getByRole("button", { name: "質問文をコピー" })).toHaveCount(1);
  await expect(questions.getByRole("button", { name: "回答を記録" })).toBeDisabled();
  await expect(questions.getByRole("button", { name: "未決事項を追加" })).toBeDisabled();
});

test("プロパティと関連 Issue を出す", async ({ page }) => {
  await page.goto("/issues/API-12");
  const props = region(page, "プロパティ");
  for (const text of ["In Progress", "High", "api-server", "検索 API の高速化", "perf", "claude-code", "入力待ち", "feat-search-n1"]) {
    await expect(props).toContainText(text);
  }
  await expect(region(page, "関連 Issue").getByRole("link", { name: "API-13" })).toHaveAttribute("href", "/issues/API-13");
});

test("Documents、Sub-issue、Activity を出す", async ({ page }) => {
  await page.goto("/issues/API-12");
  await expect(region(page, "Documents").getByRole("link", { name: "検索 API の N+1 解消 実装計画" })).toHaveAttribute("href", "/documents/2");
  await expect(region(page, "Sub-issue").getByRole("link", { name: "workspace の取得をまとめる" })).toBeVisible();
  const activity = region(page, "Activity");
  await expect(activity).toContainText("claude-code が確認を求めた");
  await expect(activity).toContainText("claude-code がステータスを Todo から In Progress に変えた");
  await expect(activity.getByRole("textbox", { name: "コメント" })).toBeVisible();
  await expect(activity.getByRole("button", { name: "コメントする" })).toBeDisabled();
});

test("計画や未決事項のない Issue は、ないことを出す", async ({ page }) => {
  await page.goto("/issues/NOD-6");
  await expect(region(page, "計画")).toContainText("計画はありません");
  await expect(region(page, "未決事項")).toContainText("未決事項はありません");
  await expect(region(page, "Documents")).toContainText("Document はありません");
  await expect(region(page, "Sub-issue")).toContainText("Sub-issue はありません");
  await expect(region(page, "関連 Issue")).toContainText("関連 Issue はありません");
});

test("関連 Issue のリンクで別の Issue に移ると、その Issue の内容に変わる", async ({ page }) => {
  await page.goto("/issues/API-12");
  await region(page, "関連 Issue").getByRole("link", { name: "API-13" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "workspace の取得をまとめる" })).toBeVisible();
  await expect(region(page, "計画")).toContainText("計画はありません");
});

test("存在しない Issue は見つかりませんと出す", async ({ page }) => {
  await page.goto("/issues/NOPE-1");
  await expect(page.getByRole("heading", { level: 1, name: "Issue が見つかりません" })).toBeVisible();
});

test("Issue 詳細を直接開いて再読み込みしても同じ画面が出る", async ({ page }) => {
  await page.goto("/issues/API-12");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "検索 API の N+1 を解消" })).toBeVisible();
});
