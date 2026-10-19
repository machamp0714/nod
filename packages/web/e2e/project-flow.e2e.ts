import type { Locator, Page } from "@playwright/test";
import { expect, test, waitForServerEvents } from "./fixtures";
import type { NodData } from "./support/nod";

// Project 詳細の一覧とフローの切り替えと、依存関係のフロー（design/nod.pen「Project詳細｜フロー」R4bvo）

const flowRegion = (page: Page) => page.getByRole("region", { name: "依存関係のフロー", exact: true });
const viewTabs = (page: Page) => page.getByRole("tablist", { name: "Issue の表示", exact: true });
const viewTab = (page: Page, name: "一覧" | "フロー") => viewTabs(page).getByRole("tab", { name, exact: true });
// カードは Issue 詳細へのリンク。名前は「ID タイトル、状態、前提、Project外」の順
const card = (scope: Page | Locator, id: string) => scope.getByRole("link", { name: new RegExp(`^${id} `) });
const rows = (page: Page) => page.getByRole("table").locator("tbody tr");
const arrows = (page: Page) => flowRegion(page).locator("svg path[marker-end]");

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("要素が表示されていない");
  return b;
}

interface Seeded {
  projectId: number;
  externalProjectId: number;
}

// 分岐と合流のある Project（id は空の DB なので 1）を作る。
// FL-1 → FL-2・FL-3・FL-8、FL-2・FL-3 → FL-4。Project 外の OUT-1 も FL-4 を止め、OUT-2 は OUT-1 だけを止める（再帰して展開しない）
// FL-5（未着手）・FL-6（中止）は依存関係なし、FL-7 はアーカイブ済み
async function seedBranchAndMerge(nod: NodData): Promise<Seeded> {
  const fl = (await nod.me.initWorkspace({ path: nod.repo("flow"), key: "FL", name: "flow-repo" })).workspace;
  const out = (await nod.me.initWorkspace({ path: nod.repo("payments"), key: "OUT", name: "payments" })).workspace;
  const project = await nod.me.createProject({ name: "検索 API の高速化", description: "/search の p95 を下げる" });
  const external = await nod.me.createProject({ name: "決済基盤" });
  const issue = (workspaceId: number, title: string, projectRef?: string) => nod.me.createIssue({ workspaceId, title, projectRef });
  const p = String(project.id);
  await issue(fl.id, "現状を計測する", p); // FL-1
  await issue(fl.id, "N+1 を解消する", p); // FL-2
  await issue(fl.id, "負荷シナリオを作成", p); // FL-3
  await issue(fl.id, "負荷試験で効果を確認", p); // FL-4
  await issue(fl.id, "スロークエリのログ整備", p); // FL-5
  await issue(fl.id, "旧ダッシュボードの撤去", p); // FL-6
  await issue(fl.id, "アーカイブ済みの調査", p); // FL-7
  await issue(fl.id, "計測方法を決めてから進める", p); // FL-8
  await issue(out.id, "決済 API の仕様を確定する", String(external.id)); // OUT-1
  await issue(out.id, "外部のさらに前提", String(external.id)); // OUT-2
  for (const [from, to] of [["FL-1", "FL-2"], ["FL-1", "FL-3"], ["FL-1", "FL-8"], ["FL-2", "FL-4"], ["FL-3", "FL-4"], ["OUT-1", "FL-4"], ["OUT-2", "OUT-1"]]) {
    await nod.me.relateIssue(from!, { blocks: to });
  }
  await nod.me.updateIssue("FL-6", { status: "canceled", reason: "不要になった" });
  await nod.me.archiveIssue("FL-7");
  // 未決事項が残る Todo（人が needs_clarification から戻した）。前提は完了しても着手可能ではない
  await nod.me.askQuestion("FL-8", "計測は本番相当のデータで行いますか？");
  await nod.me.updateIssue("FL-8", { status: "todo" });
  await nod.claude.startIssue("FL-1");
  await nod.claude.completeIssue("FL-1", { summary: "計測した" });
  await nod.claude.startIssue("FL-2");
  return { projectId: project.id, externalProjectId: external.id };
}

test.describe("分岐と合流のある Project", () => {
  test("一覧とフローを切り替えると URL に残り、再読み込み・戻る・進むで復元し、一覧の設定を保つ", async ({ page, nod }) => {
    const { projectId } = await seedBranchAndMerge(nod);
    await page.goto(`/projects/${projectId}?q=負荷&blocked=false`);
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByRole("cell", { name: "FL-3", exact: true })).toBeVisible();
    await expect(viewTab(page, "一覧")).toHaveAttribute("aria-selected", "true");

    await viewTab(page, "フロー").click();
    await expect(page).toHaveURL(/view=flow/);
    await expect(page).toHaveURL(/q=/);
    await expect(page).toHaveURL(/blocked=false/);
    await expect(viewTab(page, "フロー")).toHaveAttribute("aria-selected", "true");
    await expect(viewTab(page, "フロー")).toBeFocused();
    await expect(card(flowRegion(page), "FL-4")).toBeVisible();

    await page.reload();
    await expect(viewTab(page, "フロー")).toHaveAttribute("aria-selected", "true");
    await expect(card(flowRegion(page), "FL-4")).toBeVisible();

    await page.goBack();
    await expect(page).not.toHaveURL(/view=flow/);
    await expect(viewTab(page, "一覧")).toHaveAttribute("aria-selected", "true");
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByRole("cell", { name: "FL-3", exact: true })).toBeVisible();

    await page.goForward();
    await expect(page).toHaveURL(/view=flow/);
    await expect(flowRegion(page)).toBeVisible();

    // フローから一覧へ戻しても、検索語・ブロックの絞り込みは URL と一覧に残る
    await viewTab(page, "一覧").click();
    await expect(page).not.toHaveURL(/view=flow/);
    await expect(page).toHaveURL(/q=/);
    await expect(page).toHaveURL(/blocked=false/);
    await expect(page.getByRole("combobox", { name: "ブロック" })).toHaveValue("false");
    await expect(page.getByRole("textbox", { name: "検索" })).toHaveValue("負荷");
    await expect(rows(page)).toHaveCount(1);
  });

  test("Display のグループ化とレイアウトもフローをまたいで保つ", async ({ page, nod }) => {
    const { projectId } = await seedBranchAndMerge(nod);
    await page.goto(`/projects/${projectId}?groupBy=status&layout=board`);
    await viewTab(page, "フロー").click();
    await expect(page).toHaveURL(/view=flow/);
    await expect(page).toHaveURL(/groupBy=status/);
    await expect(page).toHaveURL(/layout=board/);
    await viewTab(page, "一覧").click();
    await expect(page).toHaveURL(/groupBy=status/);
    await expect(page).toHaveURL(/layout=board/);
    await expect(page).not.toHaveURL(/view=flow/);
  });

  test("フローは一覧の絞り込みに関わらず Project 全体を出し、一覧専用の操作を出さない", async ({ page, nod }) => {
    const { projectId } = await seedBranchAndMerge(nod);
    await page.goto(`/projects/${projectId}?view=flow&q=負荷&tab=ready&showCompleted=false&blocked=true`);
    const flow = flowRegion(page);
    // アーカイブ済みの FL-7 を除く Project の Issue をすべて出す（完了・中止も含む）
    for (const id of ["FL-1", "FL-2", "FL-3", "FL-4", "FL-5", "FL-6", "FL-8"]) await expect(card(flow, id)).toBeVisible();
    await expect(card(flow, "FL-7")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 2, name: "Issue 一覧 7" })).toBeVisible();
    await expect(page.getByText("Project 全体を表示しています（一覧の検索・絞り込みは適用されません）")).toBeVisible();
    await expect(page.getByRole("button", { name: "検索を開く" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "検索" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "表示設定", exact: true })).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "表示中の Issue をすべて選択" })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "絞り込み条件" })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "ブロック" })).toHaveCount(0);
    await expect(page.getByRole("tablist", { name: "絞り込み", exact: true })).toHaveCount(0);
    await expect(page.getByRole("table")).toHaveCount(0);
  });

  test("一覧でも検索・タブの行の上に「Issue 一覧」と Project 内の件数、右に切り替えを出し、一覧の操作は保つ", async ({ page, nod }) => {
    const { projectId } = await seedBranchAndMerge(nod);
    // 件数は一覧の検索・タブに関わらず、アーカイブ済みを除く Project 内の Issue（完了・中止を含む）
    await page.goto(`/projects/${projectId}?q=負荷&tab=ready`);
    const heading = page.getByRole("heading", { level: 2, name: "Issue 一覧 7" });
    await expect(heading).toBeVisible();
    const tabs = page.getByRole("tablist", { name: "絞り込み", exact: true });
    await expect(tabs).toBeVisible();
    const switcher = page.getByRole("tablist", { name: "Issue の表示", exact: true });
    await expect(switcher.getByRole("tab", { name: "一覧" })).toHaveAttribute("aria-selected", "true");
    const head = await box(heading);
    const sw = await box(switcher);
    expect(head.y + head.height).toBeLessThanOrEqual((await box(tabs)).y);
    // 切り替えは見出しと同じ行の右側
    expect(Math.abs(sw.y + sw.height / 2 - (head.y + head.height / 2))).toBeLessThan(sw.height);
    expect(sw.x).toBeGreaterThan(head.x + head.width);
    await expect(page.getByRole("textbox", { name: "検索" })).toHaveValue("負荷");
    await expect(page.getByRole("button", { name: "表示設定", exact: true })).toBeVisible();
    await expect(page.getByRole("group", { name: "絞り込み条件" })).toBeVisible();
  });

  test("分岐と合流をカード・状態の文字・前提・矢印・列の順で示す", async ({ page, nod }) => {
    const { projectId } = await seedBranchAndMerge(nod);
    await page.goto(`/projects/${projectId}?view=flow`);
    const flow = flowRegion(page);
    const a = card(flow, "FL-1");
    const b = card(flow, "FL-2");
    const c = card(flow, "FL-3");
    const d = card(flow, "FL-4");
    await expect(a).toContainText("FL-1");
    await expect(a).toContainText("現状を計測する");
    // 状態は色だけでなく文字でも示す
    await expect(a).toContainText("完了");
    await expect(b).toContainText("対応中");
    await expect(b).toContainText("前提：FL-1 完了");
    await expect(c).toContainText("着手可能");
    await expect(d).toContainText("前提待ち");
    await expect(d).toContainText("FL-2・FL-3・OUT-1 の完了後");
    await expect(d).toHaveAttribute("aria-label", "FL-4 負荷試験で効果を確認、前提待ち、FL-2・FL-3・OUT-1 の完了後");
    // 矢印は Project 内と Project 外からの辺（OUT-2 → OUT-1 は出さない）
    await expect(arrows(page)).toHaveCount(6);
    const [ba, bb, bc, bd] = await Promise.all([box(a), box(b), box(c), box(d)]);
    expect(ba.x + ba.width).toBeLessThan(bb.x);
    expect(ba.x + ba.width).toBeLessThan(bc.x);
    expect(bb.x).toBe(bc.x);
    expect(bb.x + bb.width).toBeLessThan(bd.x);
    expect(bc.x + bc.width).toBeLessThan(bd.x);
    // 凡例はキャンバスの下
    await expect(page.getByRole("list", { name: "凡例" })).toContainText("完了対応中着手可能前提待ち");
  });

  test("未決事項の残る Todo は前提が完了していても着手可能とせず、状態名を出す", async ({ page, nod }) => {
    const { projectId } = await seedBranchAndMerge(nod);
    await page.goto(`/projects/${projectId}?view=flow`);
    const h = card(flowRegion(page), "FL-8");
    await expect(h).toContainText("Todo");
    await expect(h).toContainText("前提：FL-1 完了");
    await expect(h).not.toContainText("着手可能");
    await expect(h).not.toContainText("前提待ち");
  });

  test("Project 外のブロック元は参照ノードとして Project と Workspace を添え、さらに先は展開しない", async ({ page, nod }) => {
    const { projectId } = await seedBranchAndMerge(nod);
    await page.goto(`/projects/${projectId}?view=flow`);
    const flow = flowRegion(page);
    const ref = card(flow, "OUT-1");
    await expect(ref).toContainText("決済 API の仕様を確定する");
    await expect(ref).toContainText("Project外 · 決済基盤 · payments");
    await expect(card(flow, "OUT-2")).toHaveCount(0);
    // 見出しの件数に Project 外は数えない
    await expect(page.getByRole("heading", { level: 2, name: "Issue 一覧 7" })).toBeVisible();
  });

  test("Project 外で Project のない Issue は「Projectなし」と出す", async ({ page, nod }) => {
    const { projectId } = await seedBranchAndMerge(nod);
    const out = (await nod.me.listWorkspaces()).find((w) => w.key === "OUT")!;
    await nod.me.createIssue({ workspaceId: out.id, title: "Project のない前提" }); // OUT-3
    await nod.me.relateIssue("OUT-3", { blocks: "FL-5" });
    await page.goto(`/projects/${projectId}?view=flow`);
    await expect(card(flowRegion(page), "OUT-3")).toContainText("Project外 · Projectなし · payments");
  });

  test("依存辺のない Issue は「依存関係なし」の枠にまとめる", async ({ page, nod }) => {
    const { projectId } = await seedBranchAndMerge(nod);
    await page.goto(`/projects/${projectId}?view=flow`);
    const frame = flowRegion(page).getByRole("region", { name: "依存関係なし", exact: true });
    await expect(frame.getByRole("heading")).toHaveText("依存関係なし · 2 件");
    await expect(card(frame, "FL-5")).toHaveAccessibleName(/、着手可能$/);
    await expect(card(frame, "FL-6")).toHaveAccessibleName(/、Canceled$/);
    // 枠はキャンバスの中で、矢印のグラフの下
    const graphBottom = (await box(card(flowRegion(page), "FL-3"))).y;
    expect((await box(frame)).y).toBeGreaterThan(graphBottom);
  });

  test("Tab でカードに移り Enter で Issue 詳細を開く", async ({ page, nod }) => {
    const { projectId } = await seedBranchAndMerge(nod);
    await page.goto(`/projects/${projectId}?view=flow`);
    const target = card(flowRegion(page), "FL-1");
    await expect(target).toBeVisible();
    await viewTab(page, "フロー").focus();
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("Tab");
      if (await target.evaluate((el) => el === document.activeElement)) break;
    }
    await expect(target).toBeFocused();
    // フォーカスの輪は 2px
    expect(await target.evaluate((el) => getComputedStyle(el).outlineWidth)).toBe("2px");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/issues\/FL-1$/);
  });

  test("進捗報告は一覧でもフローでも Issue の表示の下に置く", async ({ page, nod }) => {
    const { projectId } = await seedBranchAndMerge(nod);
    const updates = page.getByRole("region", { name: "進捗報告" });
    await page.goto(`/projects/${projectId}`);
    await expect(rows(page).first()).toBeVisible();
    const table = await box(page.getByRole("table"));
    expect((await box(updates)).y).toBeGreaterThanOrEqual(table.y + table.height);
    await viewTab(page, "フロー").click();
    await expect(card(flowRegion(page), "FL-1")).toBeVisible();
    const flow = await box(flowRegion(page));
    const legend = await box(page.getByRole("list", { name: "凡例" }));
    expect((await box(updates)).y).toBeGreaterThanOrEqual(flow.y + flow.height);
    expect((await box(updates)).y).toBeGreaterThanOrEqual(legend.y + legend.height);
  });

  test("書きかけの進捗報告は一覧とフローを切り替えても残る", async ({ page, nod }) => {
    const { projectId } = await seedBranchAndMerge(nod);
    const input = page.getByRole("textbox", { name: "進捗報告の本文" });
    await page.goto(`/projects/${projectId}`);
    await input.fill("切り替えても消えない下書き");
    await page.getByRole("button", { name: /^健全性: / }).click();
    await page.getByRole("listbox", { name: "健全性" }).getByRole("option").filter({ hasText: "At risk" }).getByRole("button").click();
    await expect(page.getByRole("button", { name: "健全性: At risk" })).toBeVisible();
    await viewTab(page, "フロー").click();
    await expect(card(flowRegion(page), "FL-1")).toBeVisible();
    await expect(input).toHaveValue("切り替えても消えない下書き");
    await expect(page.getByRole("button", { name: "健全性: At risk" })).toBeVisible();
    await viewTab(page, "一覧").click();
    await expect(rows(page).first()).toBeVisible();
    await expect(input).toHaveValue("切り替えても消えない下書き");
    await expect(page.getByRole("button", { name: "健全性: At risk" })).toBeVisible();
    // 送信すると下書きは空に戻る
    await page.getByRole("button", { name: "報告する" }).click();
    await expect(page.getByRole("article", { name: "進捗報告の記録" })).toHaveCount(1);
    await expect(input).toHaveValue("");
    await expect(page.getByRole("button", { name: "健全性: 未指定" })).toBeVisible();
    await viewTab(page, "フロー").click();
    await expect(input).toHaveValue("");
  });
});

test.describe("進捗報告の保存中の切り替え", () => {
  test.use({ allowedConsoleErrors: [/status of 500/] });
  const reports = "**/api/projects/*/reports";

  // POST を止めておき、release で本物の server へ流すか、失敗を返す
  async function holdReports(page: Page, outcome: "continue" | "fail") {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const posts: string[] = [];
    await page.route(reports, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posts.push(route.request().postData() ?? "");
      await released;
      if (outcome === "continue") return route.continue();
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL", message: "壊れた" } }) });
    });
    return { release, posts };
  }

  test("保存中に一覧とフローを切り替えても保存中のまま入力と送信を止め、保存の完了で下書きを空にし、その後の新しい下書きは残る", async ({ page, nod }) => {
    const { projectId } = await seedBranchAndMerge(nod);
    const input = page.getByRole("textbox", { name: "進捗報告の本文" });
    const held = await holdReports(page, "continue");
    await page.goto(`/projects/${projectId}`);
    await input.fill("保存中に切り替える報告");
    await page.getByRole("button", { name: "報告する" }).click();
    await expect(page.getByRole("button", { name: "保存中…" })).toBeDisabled();
    await viewTab(page, "フロー").click();
    await expect(card(flowRegion(page), "FL-1")).toBeVisible();
    // 作り直された欄でも保存中のまま、書き換えも二重の送信もできない
    await expect(input).toBeDisabled();
    await expect(input).toHaveValue("保存中に切り替える報告");
    await expect(page.getByRole("button", { name: "保存中…" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "報告する" })).toHaveCount(0);
    await viewTab(page, "一覧").click();
    await expect(input).toBeDisabled();
    held.release();
    await expect(page.getByRole("article", { name: "進捗報告の記録" })).toHaveCount(1);
    await expect(page.getByRole("article", { name: "進捗報告の記録" })).toContainText("保存中に切り替える報告");
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue("");
    expect(held.posts).toHaveLength(1);
    // 保存の後に書いた下書きは、切り替えても消えない
    await input.fill("次の下書き");
    await viewTab(page, "フロー").click();
    await expect(input).toHaveValue("次の下書き");
    await expect(page.getByRole("article", { name: "進捗報告の記録" })).toHaveCount(1);
    expect((await nod.me.getProject(String(projectId))).updates.map((u) => u.body)).toEqual(["保存中に切り替える報告"]);
  });

  test("保存中に切り替えて保存に失敗すると、新しい欄に失敗を出して下書き（本文と健全性）を残し、送り直せる", async ({ page, nod }) => {
    const { projectId } = await seedBranchAndMerge(nod);
    const input = page.getByRole("textbox", { name: "進捗報告の本文" });
    const held = await holdReports(page, "fail");
    await page.goto(`/projects/${projectId}?view=flow`);
    await expect(card(flowRegion(page), "FL-1")).toBeVisible();
    await input.fill("失敗しても残る報告");
    await page.getByRole("button", { name: /^健全性: / }).click();
    await page.getByRole("listbox", { name: "健全性" }).getByRole("option").filter({ hasText: "At risk" }).getByRole("button").click();
    await page.getByRole("button", { name: "報告する" }).click();
    await expect(page.getByRole("button", { name: "保存中…" })).toBeDisabled();
    await viewTab(page, "一覧").click();
    await expect(rows(page).first()).toBeVisible();
    await expect(input).toBeDisabled();
    held.release();
    const updates = page.getByRole("region", { name: "進捗報告" });
    await expect(updates.getByRole("alert")).toContainText("保存できませんでした");
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue("失敗しても残る報告");
    await expect(page.getByRole("button", { name: "健全性: At risk" })).toBeVisible();
    await expect(page.getByRole("article", { name: "進捗報告の記録" })).toHaveCount(0);
    expect(held.posts).toHaveLength(1);
    // 切り替えても失敗と下書きは残り、送り直すと保存できる
    await viewTab(page, "フロー").click();
    await expect(updates.getByRole("alert")).toContainText("保存できませんでした");
    await expect(input).toHaveValue("失敗しても残る報告");
    await page.unroute(reports);
    await page.getByRole("button", { name: "報告する" }).click();
    await expect(page.getByRole("article", { name: "進捗報告の記録" })).toHaveCount(1);
    await expect(updates.getByRole("alert")).toHaveCount(0);
    await expect(input).toHaveValue("");
    expect((await nod.me.getProject(String(projectId))).updates.map((u) => u.body)).toEqual(["失敗しても残る報告"]);
  });
});

test("フローを開いたまま関係と状態を変えると、再読み込みせずにグラフを更新する", async ({ page, nod }) => {
  const { projectId } = await seedBranchAndMerge(nod);
  await page.goto(`/projects/${projectId}?view=flow`);
  const flow = flowRegion(page);
  await expect(arrows(page)).toHaveCount(6);
  await expect(card(flow, "FL-3")).toContainText("着手可能");
  const before = await box(card(flow, "FL-3"));
  const beforeD = await box(card(flow, "FL-4"));
  await waitForServerEvents(page);
  // nod（CLI と同じ core の操作）で関係を足す：FL-8 が FL-3 を止める
  await nod.me.relateIssue("FL-8", { blocks: "FL-3" });
  await expect(arrows(page)).toHaveCount(7);
  await expect(card(flow, "FL-3")).toContainText("前提待ち");
  await expect(card(flow, "FL-3")).toContainText("FL-8 の完了後");
  // FL-3 と、その後続の FL-4 が右の列へ移る
  await expect.poll(async () => (await box(card(flow, "FL-3"))).x).toBeGreaterThan(before.x);
  await expect.poll(async () => (await box(card(flow, "FL-4"))).x).toBeGreaterThan(beforeD.x);
  // nod で前提を完了にすると、前提待ちが着手可能に変わる。
  // SSE の change は server と別の接続の書き込み（nod の実行）で届く（server/src/change-feed.ts）
  await nod.me.updateIssue("FL-8", { status: "done" });
  await expect(card(flow, "FL-3")).toContainText("着手可能");
  await expect(card(flow, "FL-3")).toContainText("前提：FL-1 完了・FL-8 完了");
  await expect(card(flow, "FL-8")).toContainText("完了");
  await expect(page).toHaveURL(/view=flow/);
});

test.describe("読み込みの失敗", () => {
  test.use({ allowedConsoleErrors: [/status of 500/] });
  test("フローを読めないと alert と再試行を出し、空の表示と取り違えない。再試行で表示する", async ({ page, nod }) => {
    const { projectId } = await seedBranchAndMerge(nod);
    const pattern = "**/api/projects/*/flow";
    await page.route(pattern, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL", message: "壊れた" } }) }));
    await page.goto(`/projects/${projectId}?view=flow`);
    const alert = flowRegion(page).getByRole("alert");
    await expect(alert).toBeVisible({ timeout: 20_000 });
    await expect(alert).toContainText("フローを読み込めませんでした");
    await expect(page.getByText("この Project に Issue はありません")).toHaveCount(0);
    await expect(page.getByText("依存関係はまだありません")).toHaveCount(0);
    await page.unroute(pattern);
    await alert.getByRole("button", { name: "再試行" }).click();
    await expect(card(flowRegion(page), "FL-4")).toBeVisible();
    await expect(flowRegion(page).getByRole("alert")).toHaveCount(0);
  });

  test("表示中の読み直しに失敗しても、直前のグラフを残して alert と再試行を添える", async ({ page, nod }) => {
    const { projectId } = await seedBranchAndMerge(nod);
    await page.goto(`/projects/${projectId}?view=flow`);
    await expect(card(flowRegion(page), "FL-4")).toBeVisible();
    await waitForServerEvents(page);
    const pattern = "**/api/projects/*/flow";
    await page.route(pattern, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL", message: "壊れた" } }) }));
    // nod の変更が SSE で届き、フローを読み直して失敗する
    await nod.me.updateIssue("FL-3", { title: "読み直しの確認" });
    const alert = flowRegion(page).getByRole("alert");
    await expect(alert).toBeVisible({ timeout: 20_000 });
    await expect(card(flowRegion(page), "FL-4")).toBeVisible();
    await expect(arrows(page)).toHaveCount(6);
    await page.unroute(pattern);
    await alert.getByRole("button", { name: "再試行" }).click();
    await expect(card(flowRegion(page), "FL-3")).toContainText("読み直しの確認");
    await expect(flowRegion(page).getByRole("alert")).toHaveCount(0);
  });
});

test("依存関係のない Project と Issue のない Project はそれぞれの文言を出す", async ({ page, nod }) => {
  const ws = (await nod.me.initWorkspace({ path: nod.repo("flat"), key: "FT", name: "flat" })).workspace;
  const flat = await nod.me.createProject({ name: "依存のない Project" });
  const empty = await nod.me.createProject({ name: "空の Project" });
  await nod.me.createIssue({ workspaceId: ws.id, title: "ひとつめ", projectRef: String(flat.id) });
  await nod.me.createIssue({ workspaceId: ws.id, title: "ふたつめ", projectRef: String(flat.id) });

  await page.goto(`/projects/${flat.id}?view=flow`);
  await expect(page.getByText("依存関係はまだありません")).toBeVisible();
  const frame = flowRegion(page).getByRole("region", { name: "依存関係なし", exact: true });
  await expect(frame).toContainText("依存関係なし · 2 件");
  await expect(arrows(page)).toHaveCount(0);

  await page.goto(`/projects/${empty.id}?view=flow`);
  await expect(page.getByText("この Project に Issue はありません")).toBeVisible();
  await expect(page.getByText("依存関係はまだありません")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2, name: "Issue 一覧 0" })).toBeVisible();
});

test("循環した依存関係は警告つきの別枠に出し、画面は崩れない", async ({ page, nod }) => {
  const ws = (await nod.me.initWorkspace({ path: nod.repo("cycle"), key: "CY", name: "cycle" })).workspace;
  const project = await nod.me.createProject({ name: "循環のある Project" });
  for (const title of ["前の作業", "後の作業", "続く作業", "循環の前提"]) await nod.me.createIssue({ workspaceId: ws.id, title, projectRef: String(project.id) });
  await nod.me.relateIssue("CY-4", { blocks: "CY-1" });
  await nod.me.relateIssue("CY-1", { blocks: "CY-2" });
  await nod.me.relateIssue("CY-2", { blocks: "CY-1" });
  await nod.me.relateIssue("CY-2", { blocks: "CY-3" });
  await page.goto(`/projects/${project.id}?view=flow`);
  const frame = flowRegion(page).getByRole("region", { name: "循環している依存関係", exact: true });
  await expect(frame.getByRole("heading")).toHaveText("循環している依存関係 · 2 件");
  await expect(frame.getByRole("note")).toContainText("依存関係が循環しているため");
  await expect(card(frame, "CY-1")).toBeVisible();
  await expect(card(frame, "CY-2")).toBeVisible();
  // 循環の外の CY-3 はフローに出す
  await expect(card(flowRegion(page), "CY-3")).toBeVisible();
  // 循環へ続く前提は矢印を描けないため、カードに循環の中の後続を示し、依存関係なしと区別する
  await expect(card(flowRegion(page), "CY-4")).toContainText("後続（循環）：CY-1");
  await expect(flowRegion(page).getByRole("region", { name: "依存関係なし", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "進捗報告" })).toBeVisible();
});

test("Issue が多く画面が狭くても、フローの中だけを横にスクロールしてカードを潰さない", async ({ page, nod }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const ws = (await nod.me.initWorkspace({ path: nod.repo("many"), key: "MN", name: "many" })).workspace;
  const project = await nod.me.createProject({ name: "大量の Issue" });
  for (let i = 1; i <= 25; i++) await nod.me.createIssue({ workspaceId: ws.id, title: `作業 ${i} の長いタイトルを折り返して確かめる`, projectRef: String(project.id) });
  // MN-1 から MN-12 の鎖と、そこから分かれる枝
  for (let i = 1; i < 12; i++) await nod.me.relateIssue(`MN-${i}`, { blocks: `MN-${i + 1}` });
  for (let i = 13; i <= 25; i++) await nod.me.relateIssue(`MN-${(i % 11) + 1}`, { blocks: `MN-${i}` });
  await page.goto(`/projects/${project.id}?view=flow`);
  const first = card(flowRegion(page), "MN-1");
  await expect(first).toBeVisible();
  expect(Math.round((await box(first)).width)).toBe(232);
  const scroller = flowRegion(page).getByRole("region", { name: "依存関係の図", exact: true });
  const overflow = await scroller.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(overflow.scroll).toBeGreaterThan(overflow.client);
  const doc = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(doc.scroll).toBeLessThanOrEqual(doc.inner + 1);
  // 縦にも上限を置き、図の中でスクロールする（横のスクロールバーがページの奥に隠れない）
  const vertical = await scroller.evaluate((el) => ({ client: el.clientHeight, inner: window.innerHeight }));
  expect(vertical.client).toBeLessThanOrEqual(vertical.inner);
});
