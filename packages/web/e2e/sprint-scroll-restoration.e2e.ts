import type { Page } from "@playwright/test";
import { expect, test, waitForServerEvents } from "./fixtures";
import { disableScrollAnchoring, expectPositions, holdRequests, openDetailFrom, positions, scrollRegion, scrollRegions, visibleIssueLink } from "./support/list-scroll";
import type { NodData } from "./support/nod";

// Sprint 詳細のタスク一覧からタスク詳細を開き、同じ履歴エントリへ戻ったときのスクロール位置。
// 通常の Sprint と、旧Cycleから移行した読取専用の Sprint の両方を確かめる。
// 期待値は、リンクを押す直前に各領域を実測した値にする。待つときは固定の sleep ではなく、応答・行・位置を観測する。
// データセット: Sprint 15（AAA）と 16（BBB）は通常の Sprint で各 40 件、旧Cycle 1「過去」は移行時の写し 42 件
test.use({ dataset: "sprint-scroll" });
test.beforeEach(({ page }) => disableScrollAnchoring(page));

const row = (page: Page, name: string) => page.getByRole("main").getByRole("link", { name, exact: true });
const lastRow = (page: Page, key = "AAA") => row(page, `スクロール確認 ${key} 40`);
const lastSnapshot = (page: Page) => row(page, "移行スクロール 40");
const nav = (page: Page) => page.getByRole("navigation", { name: "メイン" });
const ISSUE_LISTS = /\/api\/issues(\?.*)?$/;
const SPRINT_DETAIL = /\/api\/sprints\/[^/?]+$/;
const SPRINT_LIST = /\/api\/sprints$/;
const UUID = /\/sprints\/[0-9a-f]{8}-[0-9a-f-]{27}$/;

// Sprint 15 のタスク一覧の行（Ready の絞り込みでない方）を、n 件で読み直すまで待つ
const sprintRowsLoaded = (page: Page, n: number) =>
  page.waitForResponse(async (response) => {
    const url = new URL(response.url());
    if (!ISSUE_LISTS.test(url.pathname) || url.searchParams.get("sprint") !== "15" || url.searchParams.has("ready")) return false;
    return ((await response.json()) as { issues: unknown[] }).issues.length === n;
  });

// 描画が落ち着くまで（2フレーム）待つ。引き戻しがないことを確かめる前に使う
const nextFrames = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

// 一覧に出ている Issue の参照（AAA-43 など）
const shownRefs = (page: Page) => page.locator("main [data-issue-row]").evaluateAll((rows) => [...new Set(rows.map((el) => el.getAttribute("data-issue-row")!))]);

// 旧URLから移行済みの Sprint へ案内され、読取専用の写しが出るまで待つ
async function openMigrated(page: Page, search = ""): Promise<string> {
  await page.goto(`/cycles/1${search}`);
  await expect(page).toHaveURL(/\/sprints\/[0-9a-f-]+(\?.*)?$/);
  await expect(page.getByText("移行履歴・読取専用", { exact: true })).toBeVisible();
  await expect(lastSnapshot(page)).toHaveCount(1);
  return new URL(page.url()).pathname;
}

test("通常の Sprint の List は主領域の縦位置を復元し、履歴の表示状態を保つ", async ({ page }) => {
  await page.goto("/sprints/15");
  await expect(lastRow(page)).toHaveCount(1);
  await page.evaluate(() => window.history.replaceState({ ...window.history.state, listNavigationMarker: "維持する値" }, ""));
  await scrollRegion(page, "main", { y: 900 });
  const expected = await openDetailFrom(page, await visibleIssueLink(page));
  expect(expected.main!.y).toBeGreaterThan(800);
  await page.goBack();
  await expect(page).toHaveURL(/\/sprints\/15$/);
  await expect(lastRow(page)).toHaveCount(1);
  await expectPositions(page, { main: expected.main! });
  expect(await page.evaluate(() => window.history.state.listNavigationMarker)).toBe("維持する値");
});

test("通常の Sprint の Board は主領域の縦位置と Board の横位置を復元する（概要があるので Board は主領域の中で伸びる）", async ({ page }) => {
  await page.goto("/sprints/15?layout=board");
  await expect(lastRow(page)).toHaveCount(1);
  const regions = await scrollRegions(page);
  expect(regions.board!.maxX).toBeGreaterThan(100);
  expect(regions.board!.maxY).toBe(0);
  expect(regions.main!.maxY).toBeGreaterThan(200);
  await scrollRegion(page, "board", { x: 120 });
  await scrollRegion(page, "main", { y: 200 });
  const expected = await openDetailFrom(page, await visibleIssueLink(page));
  expect(expected.board!.x).toBe(120);
  await page.goBack();
  await expect(lastRow(page)).toHaveCount(1);
  await expectPositions(page, { main: expected.main!, board: expected.board! });
});

test("通常の Sprint をグループ化した List は表ごとの横位置を、グループ化した Board はグループごとの横位置を復元する", async ({ page }) => {
  await page.setViewportSize({ width: 860, height: 960 });
  await page.goto("/sprints/15?groupBy=priority");
  await expect(lastRow(page)).toHaveCount(1);
  const regions = await scrollRegions(page);
  const tables = Object.keys(regions).filter((key) => key.startsWith("table:") && regions[key]!.maxX > 30);
  expect(tables.length).toBeGreaterThanOrEqual(3);
  for (const [n, key] of tables.entries()) await scrollRegion(page, key, { x: 10 * (n + 1) });
  await scrollRegion(page, "main", { y: 500 });
  const list = await openDetailFrom(page, await visibleIssueLink(page));
  expect(new Set(tables.map((key) => list[key]!.x)).size).toBe(tables.length);
  await page.goBack();
  await expect(lastRow(page)).toHaveCount(1);
  await expectPositions(page, Object.fromEntries(["main", ...tables].map((key) => [key, list[key]!])));

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/sprints/15?layout=board&groupBy=priority");
  await expect(lastRow(page)).toHaveCount(1);
  const boardRegions = await scrollRegions(page);
  const boards = Object.keys(boardRegions).filter((key) => key.startsWith("board:") && boardRegions[key]!.maxX > 60);
  expect(boards.length).toBeGreaterThanOrEqual(2);
  for (const [n, key] of boards.entries()) await scrollRegion(page, key, { x: 20 * (n + 1) });
  await scrollRegion(page, "main", { y: 300 });
  const board = await openDetailFrom(page, await visibleIssueLink(page));
  await page.goBack();
  await expect(lastRow(page)).toHaveCount(1);
  await expectPositions(page, Object.fromEntries(["main", ...boards].map((key) => [key, board[key]!])));
});

test("旧URLから案内された移行済みの Sprint は、読取専用の List と Board で位置を復元する", async ({ page }) => {
  const path = await openMigrated(page);
  await scrollRegion(page, "main", { y: 800 });
  const list = await openDetailFrom(page, await visibleIssueLink(page));
  expect(list.main!.y).toBeGreaterThan(700);
  await page.goBack();
  // 旧URLの履歴は置き換え済みなので、戻ると移行済みの Sprint の一覧に戻る
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  await expect(page.getByText("移行履歴・読取専用", { exact: true })).toBeVisible();
  await expect(lastSnapshot(page)).toHaveCount(1);
  await expectPositions(page, { main: list.main! });

  await page.goto(`${path}?layout=board`);
  await expect(lastSnapshot(page)).toHaveCount(1);
  const regions = await scrollRegions(page);
  expect(regions.board!.maxX).toBeGreaterThan(100);
  await scrollRegion(page, "board", { x: 90 });
  await scrollRegion(page, "main", { y: 300 });
  const board = await openDetailFrom(page, await visibleIssueLink(page));
  expect(board.board!.x).toBe(90);
  await page.goBack();
  await expect(lastSnapshot(page)).toHaveCount(1);
  await expectPositions(page, { main: board.main!, board: board.board! });
});

test("別の Sprint は先頭から出し、それぞれの履歴エントリで自分の位置に戻る（通常と移行済みを混同しない）", async ({ page }) => {
  await page.goto("/sprints/15");
  await expect(lastRow(page)).toHaveCount(1);
  await scrollRegion(page, "main", { y: 900 });
  const first = await openDetailFrom(page, await visibleIssueLink(page));
  // 詳細から Sidebar で Sprints を開き、別の Sprint を開く
  await nav(page).getByRole("link", { name: "Sprints", exact: true }).click();
  await page.getByRole("link", { name: "実行 16", exact: true }).click();
  await expect(page).toHaveURL(UUID);
  await expect(lastRow(page, "BBB")).toHaveCount(1);
  await nextFrames(page);
  await expectPositions(page, { main: { x: 0, y: 0 } });
  await scrollRegion(page, "main", { y: 400 });
  const second = await openDetailFrom(page, await visibleIssueLink(page));
  // 移行済みの Sprint も Sprints から新しく開くと先頭から出す
  await nav(page).getByRole("link", { name: "Sprints", exact: true }).click();
  await page.getByRole("link", { name: "過去", exact: true }).click();
  await expect(lastSnapshot(page)).toHaveCount(1);
  await nextFrames(page);
  await expectPositions(page, { main: { x: 0, y: 0 } });
  await scrollRegion(page, "main", { y: 600 });
  const third = await openDetailFrom(page, await visibleIssueLink(page));
  await page.goBack();
  await expect(lastSnapshot(page)).toHaveCount(1);
  await expectPositions(page, { main: third.main! });
  await page.goBack();
  await page.goBack();
  await page.goBack();
  await expect(lastRow(page, "BBB")).toHaveCount(1);
  await expectPositions(page, { main: second.main! });
  await page.goBack();
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(/\/sprints\/15$/);
  await expect(lastRow(page)).toHaveCount(1);
  await expectPositions(page, { main: first.main! });
});

test("番号とIDで開いた同じ Sprint は、別の履歴エントリとしてそれぞれの位置に戻る", async ({ page }) => {
  await page.goto("/sprints/15");
  await expect(lastRow(page)).toHaveCount(1);
  await scrollRegion(page, "main", { y: 900 });
  const byNumber = await openDetailFrom(page, await visibleIssueLink(page));
  // 詳細のプロパティから同じ Sprint を ID で開く（新しい履歴エントリ）
  await page.getByRole("main").getByRole("link", { name: /実行 15/ }).first().click();
  await expect(page).toHaveURL(UUID);
  await expect(lastRow(page)).toHaveCount(1);
  await nextFrames(page);
  await expectPositions(page, { main: { x: 0, y: 0 } });
  await scrollRegion(page, "main", { y: 300 });
  const byId = await openDetailFrom(page, await visibleIssueLink(page));
  await page.goBack();
  await expect(page).toHaveURL(UUID);
  await expectPositions(page, { main: byId.main! });
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(/\/sprints\/15$/);
  await expect(lastRow(page)).toHaveCount(1);
  await expectPositions(page, { main: byNumber.main! });
});

test("一覧内のプレビューから詳細を開いても、戻ると一覧の位置とプレビューを保つ", async ({ page }) => {
  await page.goto("/sprints/15");
  await expect(lastRow(page)).toHaveCount(1);
  const [ref] = await shownRefs(page);
  await page.goto(`/sprints/15?preview=${ref}`);
  const open = page.getByRole("complementary", { name: `${ref} のプレビュー`, exact: true }).getByRole("link", { name: "Issue を開く" });
  await expect(open).toBeVisible();
  await expect(lastRow(page)).toHaveCount(1);
  await scrollRegion(page, "main", { y: 800 });
  const expected = await openDetailFrom(page, open);
  expect(expected.main!.y).toBeGreaterThan(700);
  await page.goBack();
  await expect(open).toBeVisible();
  await expectPositions(page, { main: expected.main! });
});

test("戻ったときの再取得を待たせても、通常の Sprint はキャッシュの行で、移行済みの Sprint は写しで直前の位置に戻り、応答の後も保つ", async ({ page }) => {
  await page.goto("/sprints/15");
  await expect(lastRow(page)).toHaveCount(1);
  await scrollRegion(page, "main", { y: 900 });
  const normal = await openDetailFrom(page, await visibleIssueLink(page));
  const rows = await holdRequests(page, ISSUE_LISTS);
  await page.goBack();
  await expect.poll(() => rows.count()).toBeGreaterThan(0);
  await expectPositions(page, { main: normal.main! });
  await rows.release();
  await expect(lastRow(page)).toHaveCount(1);
  await expectPositions(page, { main: normal.main! });

  await openMigrated(page);
  await scrollRegion(page, "main", { y: 700 });
  const migrated = await openDetailFrom(page, await visibleIssueLink(page));
  const detail = await holdRequests(page, SPRINT_DETAIL);
  await page.goBack();
  await expect.poll(() => detail.count()).toBeGreaterThan(0);
  await expectPositions(page, { main: migrated.main! });
  await detail.release();
  await expect(lastSnapshot(page)).toHaveCount(1);
  await expectPositions(page, { main: migrated.main! });
});

// 詳細を開いている間に Sprint の一覧の大半をアーカイブし、戻った後で元に戻す
async function shrinkWhileDetail(page: Page, nod: NodData) {
  await page.goto("/sprints/15");
  await expect(lastRow(page)).toHaveCount(1);
  await waitForServerEvents(page);
  const refs = await shownRefs(page);
  const { maxY } = await scrollRegion(page, "main", { y: 10_000 });
  await scrollRegion(page, "main", { y: maxY - 40 });
  const expected = await openDetailFrom(page, await visibleIssueLink(page));
  const removed = refs.slice(10);
  for (const ref of removed) await nod.me.archiveIssue(ref);
  await page.goBack();
  await expect(page.locator("main [data-issue-row]")).toHaveCount(10);
  // 最終的に短くなった一覧では、到達できる範囲に収め、範囲外の空白を残さない
  await expect.poll(async () => { const m = (await scrollRegions(page)).main!; return m.y === m.maxY && m.y < expected.main!.y; }).toBe(true);
  return { expected: expected.main!, grow: async () => { for (const ref of removed) await nod.me.unarchiveIssue(ref); } };
}

test("最終的に短くなった Sprint の一覧は到達できる範囲に収め、更新通知で伸びたら元の位置へ当て直す", async ({ page, nod }) => {
  const { expected, grow } = await shrinkWhileDetail(page, nod);
  await grow();
  await expect(lastRow(page)).toHaveCount(1);
  await expectPositions(page, { main: expected });
});

test("復元を待っている間に利用者がスクロールしたら、その後に Sprint の一覧が伸びても引き戻さない", async ({ page, nod }) => {
  const { expected, grow } = await shrinkWhileDetail(page, nod);
  const clamped = (await scrollRegions(page)).main!.y;
  await page.locator("main").hover();
  await page.mouse.wheel(0, -300);
  await expect.poll(async () => (await scrollRegions(page)).main!.y).toBeLessThan(clamped - 100);
  const user = (await scrollRegions(page)).main!.y;
  await grow();
  await expect(lastRow(page)).toHaveCount(1);
  // 行が出ても領域の高さはまだ伸びていないことがあるため、元の目標まで届く高さになってから確かめる
  await expect.poll(async () => (await scrollRegions(page)).main!.maxY).toBeGreaterThanOrEqual(expected.y);
  await nextFrames(page);
  expect((await scrollRegions(page)).main!.y).toBe(user);
});

test("タスク一覧から計画の画面へ移ったら、保留中の復元を計画の画面に当てず、一覧へ戻ったときに元の目標で復元する", async ({ page, nod }) => {
  // 計画の画面も主領域で縦にスクロールする高さにする
  await page.setViewportSize({ width: 1440, height: 480 });
  await page.goto("/sprints/15");
  await expect(lastRow(page)).toHaveCount(1);
  await waitForServerEvents(page);
  const refs = await shownRefs(page);
  const { maxY } = await scrollRegion(page, "main", { y: 10_000 });
  await scrollRegion(page, "main", { y: maxY - 40 });
  const expected = positions(await scrollRegions(page)).main!;
  // 主領域を動かさずに「計画」を開く（押す前に見える位置まで自動でスクロールしないように、キーで押す）
  await page.getByRole("button", { name: "計画", exact: true }).evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/section=plan/);
  await expect(page.getByRole("heading", { level: 2, name: "合意と開始" })).toBeVisible();
  // 計画の画面にいる間に一覧を短くし、更新通知でタスク一覧の行を読み直し終えてから一覧へ戻る
  const shrunk = sprintRowsLoaded(page, 10);
  for (const ref of refs.slice(10)) await nod.me.archiveIssue(ref);
  await shrunk;
  await page.goBack();
  await expect(page).not.toHaveURL(/section=/);
  await expect(page.locator("main [data-issue-row]")).toHaveCount(10);
  await expect.poll(async () => { const m = (await scrollRegions(page)).main!; return m.y === m.maxY && m.y < expected.y; }).toBe(true);
  // 復元を待っている一覧から、利用者の入力を伴わない履歴の操作（進む）で計画の画面へ移る
  await page.goForward();
  await expect(page).toHaveURL(/section=plan/);
  await expect(page.getByRole("heading", { level: 2, name: "合意と開始" })).toBeVisible();
  // 計画の画面を先頭にしておく。古い目標が当たれば主領域が動くので分かる
  const plan = await scrollRegion(page, "main", { y: 0 });
  expect(plan.maxY).toBeGreaterThan(100);
  // 一覧が伸びたことは、更新通知によるタスク一覧の行の読み直しで確かめる（計画の画面には一覧の行が出ない）
  const grown = sprintRowsLoaded(page, refs.length);
  for (const ref of refs.slice(10)) await nod.me.unarchiveIssue(ref);
  await grown;
  await nextFrames(page);
  expect((await scrollRegions(page)).main!.y).toBe(0);
  await page.goBack();
  await expect(lastRow(page)).toHaveCount(1);
  await expectPositions(page, { main: expected });
});

test("詳細を開いている間に Sprint の一覧が空になったら、空の表示を保ち、後で行が戻っても古い位置へ引き戻さない", async ({ page, nod }) => {
  await page.goto("/sprints/15");
  await expect(lastRow(page)).toHaveCount(1);
  await waitForServerEvents(page);
  const refs = await shownRefs(page);
  await scrollRegion(page, "main", { y: 900 });
  await openDetailFrom(page, await visibleIssueLink(page));
  for (const ref of refs) await nod.me.archiveIssue(ref);
  await page.goBack();
  await expect(page.getByText("該当する Issue はありません")).toBeVisible();
  await expect(page.locator("main [data-issue-row]")).toHaveCount(0);
  const empty = (await scrollRegions(page)).main!;
  expect(empty.y).toBeLessThanOrEqual(Math.max(empty.maxY, 0));
  for (const ref of refs) await nod.me.unarchiveIssue(ref);
  await expect(lastRow(page)).toHaveCount(1);
  await nextFrames(page);
  expect((await scrollRegions(page)).main!.y).toBe(Math.round(empty.y));
});

test("戻ったときに Sprint が見つからなくなったら、未検出の表示を保ち、復元を待ち続けない", async ({ page }) => {
  await page.goto("/sprints/15");
  await expect(lastRow(page)).toHaveCount(1);
  await scrollRegion(page, "main", { y: 900 });
  await openDetailFrom(page, await visibleIssueLink(page));
  await page.route(SPRINT_LIST, (route) => route.fulfill({ json: [] }));
  await page.goBack();
  await expect(page.getByText("Sprint が見つかりません")).toBeVisible();
  const m = (await scrollRegions(page)).main!;
  expect(m.y).toBeLessThanOrEqual(Math.max(m.maxY, 0));
  await page.unroute(SPRINT_LIST);
});

test.describe("戻ったときの再取得の失敗", () => {
  test.use({ allowedConsoleErrors: [/status of 500/] });

  test("Sprint の一覧の取得に最終的に失敗したら通常のエラー表示を保ち、復元を待ち続けない", async ({ page }) => {
    await page.goto("/sprints/15");
    await expect(lastRow(page)).toHaveCount(1);
    await scrollRegion(page, "main", { y: 900 });
    await openDetailFrom(page, await visibleIssueLink(page));
    await page.route(ISSUE_LISTS, (route) => route.fulfill({ status: 500, json: { error: { code: "INTERNAL_ERROR", message: "一覧の取得に失敗" } } }));
    await page.goBack();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("一覧の取得に失敗", { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "再試行" })).toBeVisible();
    const m = (await scrollRegions(page)).main!;
    expect(m.y).toBeLessThanOrEqual(Math.max(m.maxY, 0));
    await page.unroute(ISSUE_LISTS);
  });
});
