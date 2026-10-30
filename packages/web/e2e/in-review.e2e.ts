import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";
import { closeDisplay, setLayout } from "./support/issue-list";
import { associateSprint, seedSprint } from "./support/nod";

test("詳細でレビュー中を選び、一覧の絞り込みとボードで同じIssueを確認できる", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await api.startedIssue("レビューに提出する Issue");
  await api.startedIssue("別の実装中 Issue");
  await page.goto(`/issues/${issue.id}`);
  await page.getByRole("button", { name: "Status", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "In Review", exact: true }).click();
  await expect(page.getByRole("group", { name: "状態" })).toContainText("In Review");
  expect((await nod.me.getIssue(issue.id)).status).toBe("in_review");
  await page.goto("/issues");
  await page.getByText("Filter", { exact: true }).click();
  await page.getByRole("checkbox", { name: "In Review", exact: true }).check();
  await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(1);
  await expect(page.getByRole("table")).toContainText(issue.title);
  await expect(page.getByRole("table")).toContainText("In Review");
  await page.reload();
  await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(1);
  await expect(page.getByRole("table")).toContainText(issue.title);
  await setLayout(page, "Board");
  await closeDisplay(page);
  const column = page.getByRole("region", { name: "In Review", exact: true });
  await expect(column.getByRole("article")).toContainText(issue.title);
  await expect(column.getByText("レビュー待ち・指摘への対応を確認", { exact: true })).toBeVisible();
});

test("Workspaceでレビュー中の表示名と遷移ルールを保存し、画面を再表示できる", async ({ page, nod }) => {
  await seedApiWorkspace(nod);
  await page.goto("/workspaces/API/settings");
  const names = page.getByRole("region", { name: "ステータスの表示名", exact: true });
  await names.getByRole("textbox", { name: "in_review の表示名" }).fill("レビュー中");
  await names.getByRole("button", { name: "表示名を保存" }).click();
  await expect(page.getByRole("status")).toHaveText("保存しました");
  const rules = page.getByRole("region", { name: "ステータス遷移", exact: true });
  await rules.getByRole("button", { name: "遷移を追加" }).click();
  await rules.getByRole("combobox", { name: "1 行目の遷移元" }).selectOption("in_review");
  await rules.getByRole("combobox", { name: "1 行目の遷移先" }).selectOption("done");
  await rules.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("保存しました");
  await expect.poll(() => nod.me.getTransitionRules("API")).toMatchObject({ forbidden: [{ from: "in_review", to: "done" }] });
  await page.reload();
  await expect(names.getByRole("textbox", { name: "in_review の表示名" })).toHaveValue("レビュー中");
  await expect(rules.getByRole("combobox", { name: "1 行目の遷移元" })).toHaveValue("in_review");
  expect((await nod.me.getStatusNames("API")).names).toEqual({ in_review: "レビュー中" });
});

test("画面からレビュー後の修正を再開し、再提出後に完了報告を残せる", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await api.startedIssue("レビュー後の完了操作", nod.me);
  await nod.me.updateIssue(issue.id, { status: "in_review" });
  await page.goto(`/issues/${issue.id}`);
  await page.getByRole("button", { name: "修正を再開" }).click();
  await expect(page.getByRole("group", { name: "状態" })).toContainText("In Progress");
  await page.getByRole("button", { name: "Status", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "In Review", exact: true }).click();
  await page.getByRole("textbox", { name: "完了報告", exact: true }).fill("mergeと検証・反映を確認しました");
  await page.getByRole("button", { name: "報告して完了" }).click();
  await expect(page.getByRole("group", { name: "状態" })).toContainText("Done");
  await expect(page.getByText("mergeと検証・反映を確認しました", { exact: true })).toBeVisible();
  expect((await nod.me.getIssue(issue.id)).status).toBe("done");
  await page.reload();
  await expect(page.getByRole("group", { name: "状態" })).toContainText("Done");
  await expect(page.getByText("mergeと検証・反映を確認しました", { exact: true })).toBeVisible();
});

test.describe("レビュー中の操作の拒否", () => {
  test.use({ allowedConsoleErrors: [/status of 409/] });
  test("担当者と遷移ルールの拒否を表示し、完了報告の入力を保持する", async ({ page, nod }) => {
    const api = await seedApiWorkspace(nod);
    const issue = await api.startedIssue("担当と禁止ルールを尊重する");
    await nod.me.updateIssue(issue.id, { status: "in_review" });
    await page.goto(`/issues/${issue.id}`);
    await page.getByRole("button", { name: "修正を再開" }).click();
    await expect(page.getByRole("alert")).toContainText("claude-code が担当しています");
    await expect(page.getByRole("group", { name: "状態" })).toContainText("In Review");
    const response = await page.request.put("/api/workspaces/API/transitions", { data: { forbidden: [{ from: "in_review", to: "done" }] } });
    expect(response.ok()).toBe(true);
    await page.getByRole("textbox", { name: "完了報告", exact: true }).fill("完了条件を確認しました");
    await page.getByRole("button", { name: "報告して完了" }).click();
    await expect(page.getByRole("alert")).toContainText("完了できませんでした");
    await expect(page.getByRole("textbox", { name: "完了報告", exact: true })).toHaveValue("完了条件を確認しました");
    expect((await nod.me.getIssue(issue.id)).status).toBe("in_review");
  });
});

test("Projectフローでレビュー中を着手済みの独立した内訳として表示する", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const project = await nod.me.createProject({ name: "レビュー進捗" });
  const issue = await api.startedIssue("提出済みの実装");
  await nod.me.updateIssue(issue.id, { projectRef: String(project.id), status: "in_review" });
  await page.goto(`/projects/${project.id}?view=flow`);
  const independent = page.getByRole("region", { name: "独立したIssue", exact: true });
  await expect(independent.getByRole("region", { name: "In Review", exact: true })).toContainText(issue.title);
  await expect(independent.getByRole("heading", { name: "In Review 1", exact: true })).toBeVisible();
  await expect(independent.getByRole("region", { name: "その他の未完了", exact: true })).toHaveCount(0);
});

test("Sprintの移行時分析とProjectの進捗はレビュー中を未完了として表示する", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const today = new Intl.DateTimeFormat("en-CA").format(new Date());
  const project = await nod.me.createProject({ name: "レビュー進捗" });
  const issue = await api.startedIssue("レビューで確認中");
  await nod.me.updateIssue(issue.id, { projectRef: String(project.id), status: "in_review" });
  const sprint = await seedSprint({ name: "レビュー集計", startDate: today, endDate: today });
  await associateSprint(sprint.id, issue.id);
  await page.goto(`/sprints/${sprint.id}`);
  await page.getByRole("button", { name: "分析", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Sprint の分析" });
  await expect(panel.getByRole("region", { name: "進捗", exact: true })).toContainText("Started1100%");
  await expect(panel.getByRole("region", { name: "進捗", exact: true })).toContainText("Completed00%");
  await panel.getByRole("tab", { name: "Status", exact: true }).click();
  await expect(panel.getByRole("tabpanel").getByRole("listitem").filter({ hasText: "In Review" })).toHaveText(/^\s*In Review\s*1\s*$/);
  await page.goto(`/projects/${project.id}`);
  await expect(page.getByText("0/1 完了", { exact: true })).toBeVisible();
  await expect(page.getByRole("table")).toContainText("In Review");
  await nod.claude.completeIssue(issue.id, { summary: "完了条件を確認" });
  await page.reload();
  await expect(page.getByText("1/1 完了", { exact: true })).toBeVisible();
});
