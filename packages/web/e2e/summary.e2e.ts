import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";
import type { NodData } from "./support/nod";

// API で claude-code が着手・ブロッカー記録・質問・レビュー提出し、人が回答・差し戻す。完了1件・アーカイブ1件、WEB に起票1件
async function seed(nod: NodData) {
  const api = await seedApiWorkspace(nod);
  const web = (await nod.me.initWorkspace({ path: nod.repo("web-app"), key: "WEB", name: "web-app" })).workspace;
  const project = await nod.me.createProject({ name: "検索" });
  const rejected = await api.inReview("決済 Webhook の署名検証を追加", "実装しました");
  await nod.me.updateIssue(rejected.id, { projectRef: "検索" });
  await nod.claude.logWork(rejected.id, "CI の権限が足りず push できない", { kind: "blocker" });
  await nod.claude.askQuestion(rejected.id, "複合インデックスにしてよいですか？");
  await nod.me.answerQuestion(rejected.id, "はい");
  await nod.me.rejectReview(rejected.id, "署名ヘッダが無いリクエストのテストが無い");
  const approved = await api.inReview("検索 API の N+1 を解消", "直した");
  await nod.me.approveReview(approved.id);
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
  const { rejected, approved } = await seed(nod);
  await page.goto("/summary");
  await expect(page.getByRole("tab", { name: "24h" })).toHaveAttribute("aria-selected", "true");
  await expect(card(page, "完了")).toContainText("1人 0 / LLM 1");
  await expect(card(page, "レビュー提出")).toContainText("2人 0 / LLM 2");
  await expect(card(page, "差し戻し")).toContainText("1人 1 / LLM 0");
  await expect(card(page, "質問/回答")).toContainText("2人 1 / LLM 1");
  await expect(card(page, "ブロッカー")).toContainText("1人 0 / LLM 1");
  await expect(card(page, "新規起票")).toContainText("3人 3 / LLM 0"); // アーカイブ済みの起票は既定で除く
  await expect(card(page, "アーカイブ")).toContainText("1人 1 / LLM 0");

  const sections = page.getByRole("region", { name: /の一覧$/ });
  await expect(sections.first()).toHaveAccessibleName("ブロッカーの一覧");
  const rejectRow = list(page, "差し戻し").locator('[data-kind="rejected"]');
  await expect(rejectRow).toContainText(rejected.id);
  await expect(rejectRow).toContainText("人 · me");
  await expect(rejectRow).toContainText("理由: 署名ヘッダが無いリクエストのテストが無い");
  await expect(list(page, "質問/回答").locator('[data-kind="asked"]')).toContainText("claude-code");
  await expect(list(page, "質問/回答").locator('[data-kind="answered"]')).toContainText("回答: はい");
  const doneRow = list(page, "完了").locator('[data-kind="completed"]');
  await expect(doneRow).toContainText("claude-code");
  await expect(doneRow).toContainText("In Review → Done");

  await doneRow.getByRole("link", { name: /検索 API の N\+1 を解消/ }).click();
  await expect(page).toHaveURL(new RegExp(`/issues/${approved.id}$`));
});

test("期間・Workspace・Project・アーカイブを切り替えると URL に残し、読み直しても同じ条件で出す", async ({ page, nod }) => {
  const { project } = await seed(nod);
  await page.goto("/summary");
  await page.getByRole("tab", { name: "7d" }).click();
  await expect(page).toHaveURL(/since=7d/);
  await page.getByLabel("Workspace").selectOption("WEB");
  await expect(page).toHaveURL(/workspace=WEB/);
  await expect(card(page, "新規起票")).toContainText("1人 1 / LLM 0");
  await expect(card(page, "完了")).toContainText("0人 0 / LLM 0");
  await expect(list(page, "完了")).toHaveCount(0);

  await page.getByLabel("Workspace").selectOption("");
  await page.getByLabel("Project").selectOption(String(project.id));
  await expect(page).toHaveURL(/project=/);
  await expect(card(page, "差し戻し")).toContainText("1");
  await expect(card(page, "新規起票")).toContainText("1人 1 / LLM 0");

  await page.getByLabel("Project").selectOption("");
  await page.getByRole("switch", { name: "アーカイブを含む" }).click();
  await expect(page).toHaveURL(/archived=true/);
  await expect(card(page, "新規起票")).toContainText("4人 4 / LLM 0");

  await page.reload();
  await expect(page.getByRole("tab", { name: "7d" })).toHaveAttribute("aria-selected", "true");
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
  await expect(page.getByRole("tab", { name: "24h" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Project")).toHaveValue("");
  await expect(page.getByRole("switch", { name: "アーカイブを含む" })).toHaveAttribute("aria-checked", "false");
  await expect(card(page, "完了")).toContainText("1");
});
