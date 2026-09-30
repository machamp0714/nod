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
  return { project, reviewed };
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

test("Milestone で絞り込むと URL に残し、Project を変えるとその Project にない Milestone の選択を外す", async ({ page, nod }) => {
  const { project, reviewed } = await seed(nod);
  await nod.me.createProject({ name: "決済" });
  const alpha = await nod.me.createMilestone("検索", { name: "α" });
  await nod.me.createMilestone("決済", { name: "リリース" });
  await nod.me.updateIssue(reviewed.id, { milestoneRef: "α" });
  await page.goto("/analytics");
  const milestone = page.getByLabel("Milestone");
  // Project を選ぶ前は、同じ名前を見分けられるよう Project ごとに分けて並べる
  await expect(milestone.locator("optgroup")).toHaveCount(2);
  await milestone.selectOption(String(alpha.id));
  await expect(page).toHaveURL(new RegExp(`milestone=${alpha.id}`));
  await expect(kpi(page, "完了数")).toContainText("1");

  await page.reload();
  await expect(milestone).toHaveValue(String(alpha.id));
  await expect(kpi(page, "完了数")).toContainText("1");
  await page.getByLabel("Project").selectOption(String(project.id));
  await expect(milestone).toHaveValue(String(alpha.id));
  await expect(milestone.locator("option")).toHaveText(["すべて", "α"]);
  await page.getByLabel("Project").selectOption({ label: "決済" });
  await expect(milestone).toHaveValue("");
  await expect(page).not.toHaveURL(/milestone=/);
  await expect(page.getByText("この期間に完了した Issue はありません")).toBeVisible();
});

test("消えた Milestone の ID が URL に残っていると、見つからないことを知らせる", async ({ page, nod }) => {
  await seed(nod);
  await page.goto("/analytics?milestone=999");
  await expect(page.getByText("条件の Milestone（999）が見つかりません").first()).toBeVisible();
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
  const totals = section.getByRole("table", { name: "LLM ごとの合計" });
  await expect(totals.getByRole("columnheader")).toHaveText(["LLM", "完了数", "時間 中央値", "時間 合計", "担当開始", "レビュー提出"]);
  await expect(totals.getByRole("row", { name: /claude-code/ }).getByRole("cell")).toHaveText(["Cclaude-code", "1", "0.0h", "0.0h", "1", "1"]);
  await expect(totals.getByRole("row", { name: /codex/ }).getByRole("cell")).toHaveText(["Xcodex", "0", "—", "—", "1", "0"]);
  await expect(section.getByText("記録なしの 0 件は時間の集計から除く")).toBeVisible();
  const chart = section.getByRole("img", { name: "週ごとの完了数（LLM 別）" });
  await expect(chart.locator('[data-series="claude-code"]')).toHaveCount(1);
  await expect(chart.locator('[data-series="codex"]')).toHaveCount(0);

  await page.getByLabel("Workspace").selectOption("WEB");
  await expect(section.getByText("この期間に LLM の作業はありません")).toBeVisible();
});

test("各グラフは期間ごとの値の表と結びつき、表から同じ値を読める", async ({ page, nod }) => {
  await seed(nod);
  await page.goto("/analytics?by=day&range=7");
  const today = new Date();
  const label = `${today.getMonth() + 1}/${today.getDate()}`;

  const bars = page.getByRole("img", { name: "日ごとの完了数", exact: true });
  const barsTable = page.getByRole("table", { name: "日ごとの完了数", exact: true });
  await expect(bars).toHaveAttribute("aria-describedby", (await barsTable.getAttribute("id"))!);
  await expect(barsTable.getByRole("columnheader")).toHaveText(["日", "完了", "canceled"]);
  await expect(barsTable.getByRole("row")).toHaveCount(8);
  const todayRow = barsTable.getByRole("row").last();
  await expect(todayRow.getByRole("rowheader")).toHaveText(label);
  await expect(todayRow.getByRole("cell")).toHaveText(["3", "1"]);

  const lineTable = page.getByRole("table", { name: "日ごとの作業時間 中央値" });
  await expect(lineTable.getByRole("columnheader")).toHaveText(["日", "中央値", "件数", "合計", "記録なし"]);
  await expect(lineTable.getByRole("row").last().getByRole("cell")).toHaveText(["0.0h", "1", "0.0h", "2"]);

  const llmTable = page.getByRole("region", { name: "LLM 別" }).getByRole("table", { name: "日ごとの完了数（LLM 別）" });
  await expect(llmTable.getByRole("columnheader")).toHaveText(["日", "claude-code"]);
  await expect(llmTable.getByRole("row").last().getByRole("cell")).toHaveText(["1"]);
  const llmChart = page.getByRole("img", { name: "日ごとの完了数（LLM 別）" });
  await expect(llmChart).toHaveAttribute("aria-describedby", (await llmTable.getAttribute("id"))!);
});

test("作業時間の折れ線はキーボードでフォーカスすると値の吹き出しを出し、←→ で値のある点を移る", async ({ page, nod }) => {
  await seed(nod);
  await page.goto("/analytics?by=day&range=7");
  const line = page.getByRole("img", { name: "日ごとの作業時間 中央値" });
  await line.focus();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("中央値 0.0h");
  await expect(tooltip).toContainText("件数 1・合計 0.0h");
  const describedBy = (await line.getAttribute("aria-describedby"))!.split(" ");
  expect(describedBy).toContain(await tooltip.getAttribute("id"));
  // 値のある点は今日だけなので、左右に動いても同じ点にとどまる
  await line.press("ArrowLeft");
  await expect(tooltip).toContainText("中央値 0.0h");
  await line.press("Home");
  await expect(tooltip).toBeVisible();
  await line.blur();
  await expect(tooltip).toHaveCount(0);
});

test("canceled だけの期間は空の状態にせず、canceled の系列を出す", async ({ page, nod }) => {
  const web = (await nod.me.initWorkspace({ path: nod.repo("web-app"), key: "WEB", name: "web-app" })).workspace;
  const dropped = await nod.me.createIssue({ workspaceId: web.id, title: "やめた作業" });
  await nod.me.updateIssue(dropped.id, { status: "canceled" });
  await page.goto("/analytics");
  await expect(kpi(page, "完了数")).toContainText("0");
  await expect(kpi(page, "完了数")).toContainText("canceled 1 件は除く");
  await expect(kpi(page, "作業時間 中央値")).toContainText("—");
  const bars = page.getByRole("img", { name: "週ごとの完了数", exact: true });
  await expect(bars.locator('[data-series="canceled"]')).toHaveCount(1);
  await expect(bars.locator('[data-series="完了"]')).toHaveCount(0);
  await expect(page.getByText("この期間に完了した Issue はありません")).toHaveCount(0);
});
