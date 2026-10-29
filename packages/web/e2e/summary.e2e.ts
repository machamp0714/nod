import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";
import { measureFilterBar } from "./layout-measure";
import type { NodData } from "./support/nod";

// API で LLM の着手・ブロッカー記録・質問・完了報告と、人の回答を記録する
async function seed(nod: NodData) {
  const api = await seedApiWorkspace(nod);
  const web = (await nod.me.initWorkspace({ path: nod.repo("web-app"), key: "WEB", name: "web-app" })).workspace;
  const project = await nod.me.createProject({ name: "検索" });
  const rejected = await api.startedIssue("決済 Webhook の署名検証を追加");
  await nod.me.updateIssue(rejected.id, { projectRef: "検索" });
  await nod.claude.logWork(rejected.id, "CI の権限が足りず push できない", { kind: "blocker" });
  await nod.claude.askQuestion(rejected.id, "複合インデックスにしてよいですか？");
  await nod.me.answerQuestion(rejected.id, "はい");
  const approved = await api.completedIssue("検索 API の N+1 を解消", "直した");
  const archived = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "古い調査" });
  await nod.me.archiveIssue(archived.id);
  await nod.me.createIssue({ workspaceId: web.id, title: "料金ページの比較表を更新" });
  return { project, rejected, approved, archived };
}

const card = (page: import("@playwright/test").Page, name: string) => page.getByRole("region", { name, exact: true });
const list = (page: import("@playwright/test").Page, name: string) => page.getByRole("region", { name: `${name}の一覧` });

test("Sidebar の Summary から最近の動きに移り、項目が選択中になる。動きがなければ空の状態を出す", async ({ page }) => {
  await page.goto("/inbox");
  const nav = page.getByRole("navigation", { name: "メイン" });
  await nav.getByRole("link", { name: "Summary" }).click();
  await expect(page).toHaveURL(/\/summary$/);
  await expect(page.getByRole("heading", { level: 1, name: "最近の動き" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Summary" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("この期間の動きはありません")).toBeVisible();
});

test("種類ごとの件数を人と LLM に分けて出し、各行から Issue に移れる", async ({ page, nod }) => {
  const { approved } = await seed(nod);
  await page.goto("/summary");
  await expect(page.getByRole("button", { name: "24h", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(card(page, "完了")).toContainText("1人 0 / LLM 1");
  await expect(card(page, "完了報告")).toContainText("0人 0 / LLM 0");
  await expect(card(page, "質問/回答")).toContainText("2人 1 / LLM 1");
  await expect(card(page, "ブロッカー")).toContainText("1人 0 / LLM 1");
  await expect(card(page, "新規起票")).toContainText("3人 3 / LLM 0"); // アーカイブ済みの起票は既定で除く
  await expect(card(page, "アーカイブ")).toContainText("1人 1 / LLM 0");

  const sections = page.getByRole("region", { name: /の一覧$/ });
  await expect(sections.first()).toHaveAccessibleName("ブロッカーの一覧");
  await expect(list(page, "質問/回答").locator('[data-kind="asked"]')).toContainText("claude-code");
  await expect(list(page, "質問/回答").locator('[data-kind="answered"]')).toContainText("回答: はい");
  const doneRow = list(page, "完了").locator('[data-kind="completed"]');
  await expect(doneRow).toContainText("claude-code");
  await expect(doneRow).toContainText("In Progress → Done");

  await doneRow.getByRole("link", { name: /検索 API の N\+1 を解消/ }).click();
  await expect(page).toHaveURL(new RegExp(`/issues/${approved.id}$`));
});

test("期間・Workspace・Project・アーカイブを切り替えると URL に残し、読み直しても同じ条件で出す", async ({ page, nod }) => {
  const { project } = await seed(nod);
  await page.goto("/summary");
  await page.getByRole("button", { name: "7d", exact: true }).click();
  await expect(page).toHaveURL(/since=7d/);
  await page.getByLabel("Workspace").selectOption("WEB");
  await expect(page).toHaveURL(/workspace=WEB/);
  await expect(card(page, "新規起票")).toContainText("1人 1 / LLM 0");
  await expect(card(page, "完了")).toContainText("0人 0 / LLM 0");
  await expect(list(page, "完了")).toHaveCount(0);

  await page.getByLabel("Workspace").selectOption("");
  await page.getByLabel("Project").selectOption(String(project.id));
  await expect(page).toHaveURL(/project=/);
  await expect(card(page, "質問/回答")).toContainText("2");
  await expect(card(page, "新規起票")).toContainText("1人 1 / LLM 0");

  await page.getByLabel("Project").selectOption("");
  await page.getByRole("switch", { name: "アーカイブを含む" }).click();
  await expect(page).toHaveURL(/archived=true/);
  await expect(card(page, "新規起票")).toContainText("4人 4 / LLM 0");

  await page.reload();
  await expect(page.getByRole("button", { name: "7d", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("switch", { name: "アーカイブを含む" })).toHaveAttribute("aria-checked", "true");
  await expect(list(page, "新規起票").getByText("アーカイブ済み")).toBeVisible();
});

test("10件を超える種類は「他 N 件を表示」で広げる", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  for (let n = 1; n <= 12; n++) await nod.me.createIssue({ workspaceId: api.workspace.id, title: `起票 ${n}` });
  await page.goto("/summary");
  const created = list(page, "新規起票");
  await expect(created.locator('[data-kind="created"]')).toHaveCount(10);
  await expect(created.locator('[data-kind="created"]').first()).toContainText("起票 12");
  await created.getByRole("button", { name: "他 2 件を表示" }).click();
  await expect(created.locator('[data-kind="created"]')).toHaveCount(12);
  await expect(created.getByRole("button", { name: /件を表示/ })).toHaveCount(0);
});

test("URL の知らない値は既定の条件に戻す", async ({ page, nod }) => {
  await seed(nod);
  await page.goto("/summary?since=1y&project=abc&archived=maybe");
  await expect(page.getByRole("button", { name: "24h", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Project")).toHaveValue("");
  await expect(page.getByRole("switch", { name: "アーカイブを含む" })).toHaveAttribute("aria-checked", "false");
  await expect(card(page, "完了")).toContainText("1");
});

// #184：フィルタは Header の下の行（nod.pen の sNVQa の View Bar）に置く
const LONG_PROJECT = "検索 API の高速化と決済まわりの改修をまとめて進める、名前の長い Project";

test("フィルタは Header の下の高さ 43 の行に置き、select は高さ 28 の円形で、Main に横スクロールを出さない", async ({ page, nod }) => {
  await seed(nod);
  await nod.me.createProject({ name: LONG_PROJECT });
  await page.goto("/summary");
  await expect(page.getByLabel("Project").locator("option")).toHaveCount(3);
  await expect(card(page, "完了")).toContainText("1");
  const m = await measureFilterBar(page);
  console.log(`[filter] /summary ${JSON.stringify(m)}`);
  expect(m.headerHeight).toBe(44);
  expect(m.headerControls).toBe(0);
  expect(m.barTop).toBe(0);
  expect(m.barHeight).toBe(43);
  expect(m.controls).toBe(6); // 24h、7d、30d、Workspace、Project、アーカイブを含む
  expect(m.rows).toBe(1);
  expect(m.centerDiff).toBeLessThanOrEqual(2.5);
  expect(m.selectHeights).toEqual([28]);
  expect(m.selectRadius).toEqual(["9999px"]);
  expect(m.rightGap).toBeGreaterThanOrEqual(12);
  expect(m.mainOverflow).toBe(0);
  expect(m.pageOverflow).toBe(0);
});

test.describe("幅 900px", () => {
  test.use({ viewport: { width: 900, height: 960 } });

  test("幅が足りないと、フィルタは折り返し、Main に横スクロールを出さない", async ({ page, nod }) => {
    await seed(nod);
    const project = await nod.me.createProject({ name: LONG_PROJECT });
    await page.goto(`/summary?project=${project.id}`);
    await expect(page.getByLabel("Project")).toHaveValue(String(project.id));
    await expect(page.getByText("この期間の動きはありません")).toBeVisible();
    const m = await measureFilterBar(page);
    console.log(`[filter] /summary 幅 900 ${JSON.stringify(m)}`);
    expect(m.headerHeight).toBe(44);
    expect(m.barTop).toBe(0);
    expect(m.rows).toBe(2);
    expect(m.barHeight).toBeGreaterThan(43);
    expect(m.centerDiff).toBeLessThanOrEqual(2.5);
    expect(m.selectHeights).toEqual([28]);
    expect(m.rightGap).toBeGreaterThanOrEqual(12);
    expect(m.mainOverflow).toBe(0);
    expect(m.pageOverflow).toBe(0);
  });
});


test("PRレビュー入りと再提出を完了報告に数えず、Doneにしたときに完了へ表示する", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await api.startedIssue("レビュー指摘を修正して完了する");
  await nod.claude.updateIssue(issue.id, { status: "in_review" });
  await page.goto("/summary");
  const expectUnfinished = async () => {
    await expect(card(page, "完了報告")).toContainText("0人 0 / LLM 0");
    await expect(card(page, "完了")).toContainText("0人 0 / LLM 0");
    await expect(list(page, "完了報告")).toHaveCount(0);
    await expect(list(page, "完了")).toHaveCount(0);
  };
  await expectUnfinished();
  await nod.claude.startIssue(issue.id);
  await nod.claude.updateIssue(issue.id, { status: "in_review" });
  await page.reload();
  await expectUnfinished();
  await nod.claude.completeIssue(issue.id, { summary: "mergeと完了条件を確認" });
  await page.reload();
  await expect(card(page, "完了報告")).toContainText("0人 0 / LLM 0");
  await expect(card(page, "完了")).toContainText("1人 0 / LLM 1");
  await expect(list(page, "完了").locator('[data-kind="completed"]')).toContainText(issue.title);
  await expect(list(page, "完了").locator('[data-kind="completed"]')).toContainText("In Review → Done");
});
