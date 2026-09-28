import { expect, test, waitForServerEvents } from "./fixtures";
import { region } from "./helpers";
import { CHILD_TITLE, ISSUE, MAIN_ANSWER, MAIN_TITLE, PROJECT_NAME } from "./issue-detail-data";

test.use({ dataset: "issue-detail" });

test("Issue 詳細は見出し、チップ、パンくず、説明を出す", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.main}`);
  await expect(page.getByRole("heading", { level: 1, name: MAIN_TITLE })).toBeVisible();
  const crumbs = page.getByRole("navigation", { name: "パンくず" });
  await expect(crumbs.getByRole("link", { name: PROJECT_NAME })).toHaveAttribute("href", "/projects/1");
  await expect(crumbs).toContainText(ISSUE.main);
  const state = page.getByRole("group", { name: "状態" });
  await expect(state).toContainText("In Progress");
  await expect(state).toContainText("入力待ち");
  await expect(region(page, "説明")).toContainText("100 件の検索でクエリが 3 回以下");
});

test("計画は進捗を出し、作業中の Task の Step を開いておく", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.main}`);
  const plan = region(page, "計画");
  await expect(plan).toContainText("Task 1 / 4");
  await expect(plan).toContainText("2026-09-27-search-n1.md");
  await expect(plan.getByRole("button", { name: /インデックス設計/ })).toHaveAttribute("aria-expanded", "true");
  await expect(plan.getByText("複合インデックスの案を作る")).toBeVisible();
  await plan.getByRole("button", { name: /実装/ }).click();
  await expect(plan.getByRole("button", { name: /実装/ })).toHaveAttribute("aria-expanded", "true");
  await expect(plan.getByText("インデックスを足すマイグレーションを書く")).toBeVisible();
  await expect(plan.getByText("複合インデックスの案を作る")).toHaveCount(0);
});

test("未決事項は決定数 / 総数と、回答済みの回答を出す", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.main}`);
  const questions = region(page, "未決事項");
  await expect(questions).toContainText("1 / 2 決定");
  await expect(questions).toContainText(`回答：${MAIN_ANSWER}`);
  await expect(questions.getByRole("button", { name: "質問文をコピー" })).toHaveCount(1);
});

test("プロパティと関連 Issue を出す", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.main}`);
  const props = region(page, "プロパティ");
  await expect(props.getByRole("combobox", { name: "Status" })).toHaveValue("in_progress");
  await expect(props.getByRole("combobox", { name: "Priority" })).toHaveValue("2");
  await expect(props.getByRole("combobox", { name: "Project" })).toHaveValue("1");
  await expect(props.getByRole("combobox", { name: "Assignee" })).toHaveValue("claude-code");
  await expect(props.getByRole("button", { name: "ラベル perf を外す" })).toBeVisible();
  for (const text of ["api-server", "入力待ち", "feat-search-n1"]) {
    await expect(props).toContainText(text);
  }
  await expect(region(page, "関連 Issue").getByRole("link", { name: ISSUE.child })).toHaveAttribute("href", `/issues/${ISSUE.child}`);
});

test("Documents、Sub-issue、Activity を出す", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.main}`);
  const documents = region(page, "Documents");
  await expect(documents.getByRole("link", { name: "検索 API の N+1 解消 実装計画" })).toHaveAttribute("href", "/documents/2");
  await expect(documents.getByRole("link", { name: "nod 設計" })).toHaveAttribute("href", "/documents/3");
  await expect(region(page, "Sub-issue").getByRole("link", { name: CHILD_TITLE })).toBeVisible();
  const activity = region(page, "Activity");
  await expect(activity).toContainText("claude-code が確認を求めた");
  await expect(activity).toContainText("claude-code がステータスを Todo から In Progress に変えた");
  await expect(activity.getByRole("textbox", { name: "コメント" })).toBeVisible();
});

test("計画や未決事項のない Issue は、ないことを出す", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.empty}`);
  await expect(region(page, "計画")).toContainText("計画はありません");
  await expect(region(page, "未決事項")).toContainText("未決事項はありません");
  await expect(region(page, "Documents")).toContainText("Document はありません");
  await expect(region(page, "Sub-issue")).toContainText("Sub-issue はありません");
  await expect(region(page, "関連 Issue")).toContainText("関連 Issue はありません");
});

test("関連 Issue のリンクで別の Issue に移ると、その Issue の内容に変わる", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.main}`);
  await region(page, "関連 Issue").getByRole("link", { name: ISSUE.child }).click();
  await expect(page.getByRole("heading", { level: 1, name: CHILD_TITLE })).toBeVisible();
  await expect(region(page, "計画")).toContainText("計画はありません");
});

test("Issue 詳細を直接開いて再読み込みしても同じ画面が出る", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.main}`);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: MAIN_TITLE })).toBeVisible();
});

test("LLM が nod で書き込むと、再読み込みせずに Activity に出る", async ({ page, nod }) => {
  await page.goto(`/issues/${ISSUE.external}`);
  await expect(page.getByRole("heading", { level: 1, name: "外から書き込まれる Issue" })).toBeVisible();
  // ready の前に書くと、ready による読み直しで画面が変わり、change の経路を試せない（H）
  await waitForServerEvents(page);
  await nod.claude.commentIssue(ISSUE.external, "外の接続から書いた経過");
  await expect(region(page, "Activity")).toContainText("外の接続から書いた経過");
});

test.describe("見つからない Issue", () => {
  test.use({ allowedConsoleErrors: [/status of 40[04]/] });

  test("存在しない Issue と形の違う ID は、再試行を待たずに見つかりませんと出す", async ({ page }) => {
    await page.goto("/issues/NOPE-1");
    await expect(page.getByRole("heading", { level: 1, name: "Issue が見つかりません" })).toBeVisible({ timeout: 2_000 });
    await page.goto("/issues/nope");
    await expect(page.getByRole("heading", { level: 1, name: "Issue が見つかりません" })).toBeVisible({ timeout: 2_000 });
  });
});
