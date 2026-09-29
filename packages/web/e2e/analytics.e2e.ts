import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";
import type { NodData } from "./support/nod";

// API に完了2件（うち1件は claude-code がレビューに回したもの）と canceled 1件、WEB に完了1件を今日の日付で作る
async function seed(nod: NodData) {
  const api = await seedApiWorkspace(nod);
  const web = (await nod.me.initWorkspace({ path: nod.repo("web-app"), key: "WEB", name: "web-app" })).workspace;
  const project = await nod.me.createProject({ name: "検索" });
  const reviewed = await api.inReview("検索 API の N+1 を解消", "直した");
  await nod.me.updateIssue(reviewed.id, { projectRef: "検索" });
  await nod.me.approveReview(reviewed.id);
  const direct = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "ログの整理" });
  await nod.me.updateIssue(direct.id, { status: "done" });
  const dropped = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "不要になった調査" });
  await nod.me.updateIssue(dropped.id, { status: "canceled" });
  const other = await nod.me.createIssue({ workspaceId: web.id, title: "画面の文言" });
  await nod.me.updateIssue(other.id, { status: "done" });
  return { project };
}

const kpi = (page: import("@playwright/test").Page, name: string) => page.getByRole("region", { name, exact: true });

test("Sidebar の Analytics から分析画面に移り、項目が選択中になる", async ({ page }) => {
  await page.goto("/inbox");
  const nav = page.getByRole("navigation", { name: "メイン" });
  await nav.getByRole("link", { name: "Analytics" }).click();
  await expect(page).toHaveURL(/\/analytics$/);
  await expect(page.getByRole("heading", { level: 1, name: "Analytics" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Analytics" })).toHaveAttribute("aria-current", "page");
});

test("完了がなければ空の状態を出す", async ({ page }) => {
  await page.goto("/analytics");
  await expect(page.getByText("この期間に完了した Issue はありません")).toBeVisible();
});

test("完了数・作業時間・記録なしと週ごとのグラフを API の集計から出す", async ({ page, nod }) => {
  await seed(nod);
  await page.goto("/analytics");
  await expect(kpi(page, "完了数")).toContainText("3");
  await expect(kpi(page, "完了数")).toContainText("直近12週 · canceled 1 件は除く");
  await expect(kpi(page, "作業時間 中央値")).toContainText("0.0h");
  await expect(kpi(page, "作業時間 中央値")).toContainText("着手 → レビュー提出");
  // 着手を経ずに done にした2件は作業時間を求められない
  await expect(kpi(page, "記録なし件数")).toContainText("2");
  await expect(page.getByRole("img", { name: "週ごとの完了数", exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "週ごとの作業時間 中央値" })).toBeVisible();
  const bars = page.getByRole("img", { name: "週ごとの完了数", exact: true });
  await expect(bars.locator('[data-series="完了"]')).toHaveCount(1);
  await expect(bars.locator('[data-series="canceled"]')).toHaveCount(1);
  await expect(page.getByRole("tab", { name: "週" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("範囲")).toHaveValue("12");
});

test("日/週・範囲・Workspace・Project を切り替えると URL に残し、読み直しても同じ条件で出す", async ({ page, nod }) => {
  const { project } = await seed(nod);
  await page.goto("/analytics");
  await page.getByRole("tab", { name: "日" }).click();
  await expect(page).toHaveURL(/by=day/);
  await expect(page.getByRole("img", { name: "日ごとの完了数", exact: true })).toBeVisible();
  await expect(page.getByLabel("範囲")).toHaveValue("30");
  await page.getByLabel("範囲").selectOption("7");
  await expect(page).toHaveURL(/range=7/);
  await page.getByLabel("Workspace").selectOption("WEB");
  await expect(page).toHaveURL(/workspace=WEB/);
  await expect(kpi(page, "完了数")).toContainText("1");
  await expect(kpi(page, "完了数")).toContainText("直近7日 · canceled 0 件は除く");
  await page.getByLabel("Workspace").selectOption("");
  await page.getByLabel("Project").selectOption(String(project.id));
  await expect(page).toHaveURL(/project=/);
  await expect(kpi(page, "完了数")).toContainText("1");
  await expect(kpi(page, "記録なし件数")).toContainText("0");

  await page.reload();
  await expect(page.getByRole("tab", { name: "日" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("範囲")).toHaveValue("7");
  await expect(page.getByLabel("Project")).toHaveValue(String(project.id));
  await page.getByLabel("Workspace").selectOption("WEB");
  await expect(page.getByText("この期間に完了した Issue はありません")).toBeVisible();
});

test("URL の知らない値は既定の条件に戻す", async ({ page, nod }) => {
  await seed(nod);
  await page.goto("/analytics?by=month&range=5&project=abc");
  await expect(page.getByRole("tab", { name: "週" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("範囲")).toHaveValue("12");
  await expect(page.getByLabel("Project")).toHaveValue("");
  await expect(kpi(page, "完了数")).toContainText("3");
});

test("LLM 別に完了数・作業時間・担当開始・レビュー提出の表と積み上げ棒を出す", async ({ page, nod }) => {
  await seed(nod);
  const api = (await nod.me.listWorkspaces()).find((w) => w.key === "API")!;
  const other = await nod.me.createIssue({ workspaceId: api.id, title: "codex が担当して止まった作業" });
  await nod.codex.startIssue(other.id);
  await page.goto("/analytics");
  const section = page.getByRole("region", { name: "LLM 別" });
  await expect(section.getByRole("columnheader")).toHaveText(["LLM", "完了数", "時間 中央値", "時間 合計", "担当開始", "レビュー提出"]);
  await expect(section.getByRole("row", { name: /claude-code/ }).getByRole("cell")).toHaveText(["Cclaude-code", "1", "0.0h", "0.0h", "1", "1"]);
  await expect(section.getByRole("row", { name: /codex/ }).getByRole("cell")).toHaveText(["Xcodex", "0", "—", "—", "1", "0"]);
  await expect(section.getByText("記録なしの 0 件は時間の集計から除く")).toBeVisible();
  const chart = section.getByRole("img", { name: "週ごとの完了数（LLM 別）" });
  await expect(chart.locator('[data-series="claude-code"]')).toHaveCount(1);
  await expect(chart.locator('[data-series="codex"]')).toHaveCount(0);

  await page.getByLabel("Workspace").selectOption("WEB");
  await expect(section.getByText("この期間に LLM の作業はありません")).toBeVisible();
});
