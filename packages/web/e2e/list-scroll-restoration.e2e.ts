import type { Page } from "@playwright/test";
import { expect, test, waitForServerEvents } from "./fixtures";
import { chooseDisplay, closeDisplay } from "./support/issue-list";
import { disableScrollAnchoring, expectPositions, holdRequests, openDetailFrom, positions, scrollRegion, scrollRegions, visibleIssueLink } from "./support/list-scroll";
import type { NodData } from "./support/nod";

// Issues の一覧からタスク詳細を開き、同じ履歴エントリへ戻ったときのスクロール位置。
// 期待値は、リンクを押す直前に各領域を実測した値にする。待つときは固定の sleep ではなく、応答・行・位置を観測する
test.use({ dataset: "issue-list" });
test.beforeEach(({ page }) => disableScrollAnchoring(page));

const TITLE = "スクロール確認 Issue";

async function addIssues(nod: NodData, n: number, workspace = "API"): Promise<string[]> {
  const [ws] = (await nod.me.listWorkspaces()).filter((w) => w.key === workspace);
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    const issue = await nod.me.createIssue({ workspaceId: ws!.id, title: `${TITLE} ${workspace} ${String(i).padStart(2, "0")}` });
    ids.push(issue.id);
  }
  return ids;
}

const savedDisplays = async (page: Page) => (await (await page.request.get("/api/page-displays")).json()) as Record<string, unknown>;

// ページ表示設定への書き込み（GET 以外）を数える
function recordDisplayWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/page-displays/") && request.method() !== "GET") writes.push(request.method());
  });
  return writes;
}

const lastRow = (page: Page, workspace = "API", n = 40) => page.getByRole("link", { name: `${TITLE} ${workspace} ${String(n).padStart(2, "0")}`, exact: true });

test("List の主領域を縦にスクロールして詳細を開き、戻ると直前の位置から再開し、履歴の表示状態と保存値を保つ", async ({ page, nod }) => {
  await addIssues(nod, 40);
  await page.goto("/issues");
  await expect(lastRow(page)).toHaveCount(1);
  // 並び順を変えて（push）、履歴の表示状態（pageDisplay）を作る
  await chooseDisplay(page, "並び順", "タイトル");
  await closeDisplay(page);
  await expect.poll(() => savedDisplays(page)).toMatchObject({ issues: { sort: "title" } });
  await page.evaluate(() => window.history.replaceState({ ...window.history.state, listNavigationMarker: "維持する値" }, ""));
  const state = await page.evaluate(() => window.history.state.pageDisplay);
  expect(state).toMatchObject({ key: "issues", display: { sort: "title" } });
  const before = await savedDisplays(page);
  const writes = recordDisplayWrites(page);

  await scrollRegion(page, "main", { y: 700 });
  const expected = await openDetailFrom(page, await visibleIssueLink(page));
  expect(expected.main!.y).toBeGreaterThan(600);
  await page.goBack();
  await expect(lastRow(page)).toHaveCount(1);
  await expectPositions(page, { main: expected.main! });
  // 既存の履歴の表示状態と他の履歴情報を失わず、保存値も書き換えない
  expect(await page.evaluate(() => window.history.state.pageDisplay)).toEqual(state);
  expect(await page.evaluate(() => window.history.state.listNavigationMarker)).toBe("維持する値");
  expect(await savedDisplays(page)).toEqual(before);
  expect(writes).toEqual([]);
  expect(positions(await scrollRegions(page)).main).toEqual(expected.main);
});

const API_TABLE = 'table:["API"]';
const NOD_TABLE = 'table:["NOD"]';
const BLOG_TABLE = 'table:["BLOG"]';
const ISSUE_LISTS = /\/api\/issues(\?.*)?$/;
const nav = (page: Page) => page.getByRole("navigation", { name: "メイン" });

// 描画が落ち着くまで（2フレーム）待つ。引き戻しがないことを確かめる前に使う
const nextFrames = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

test("グループ化した List は表ごとの横位置を復元し、消えたグループの位置を他の表に使わない", async ({ page, nod }) => {
  // 表の最小幅（640）より主領域が狭いと、表ごとに横へスクロールする
  await page.setViewportSize({ width: 860, height: 960 });
  await addIssues(nod, 30);
  const nodIds = (await nod.me.queryIssues({ workspace: ["NOD"] })).issues.map((issue) => issue.id);
  await page.goto("/issues?groupBy=workspace");
  await expect(lastRow(page, "API", 30)).toHaveCount(1);
  const regions = await scrollRegions(page);
  const maxX = regions[API_TABLE]!.maxX;
  for (const key of [API_TABLE, NOD_TABLE, BLOG_TABLE]) expect(regions[key]?.maxX, key).toBeGreaterThan(20);
  // 表ごとに違う位置にする（消える NOD の位置を他の表に使えば分かる）
  await scrollRegion(page, API_TABLE, { x: Math.round(maxX / 4) });
  await scrollRegion(page, NOD_TABLE, { x: maxX });
  await scrollRegion(page, BLOG_TABLE, { x: Math.round(maxX / 2) });
  await scrollRegion(page, "main", { y: 300 });
  const expected = await openDetailFrom(page, await visibleIssueLink(page));
  expect(new Set([API_TABLE, NOD_TABLE, BLOG_TABLE].map((key) => expected[key]!.x)).size).toBe(3);
  // 詳細を開いている間に NOD のグループが消える
  for (const id of nodIds) await nod.me.archiveIssue(id);
  await page.goBack();
  await expect.poll(async () => Object.keys(await scrollRegions(page))).not.toContain(NOD_TABLE);
  await expectPositions(page, { main: expected.main!, [API_TABLE]: expected[API_TABLE]!, [BLOG_TABLE]: expected[BLOG_TABLE]! });
});

test("グループのない Board は Board の中の縦横の位置を復元する", async ({ page, nod }) => {
  await addIssues(nod, 30);
  await page.goto("/issues?layout=board");
  await expect(lastRow(page, "API", 30)).toHaveCount(1);
  const regions = await scrollRegions(page);
  expect(regions.board!.maxX).toBeGreaterThan(200);
  expect(regions.board!.maxY).toBeGreaterThan(400);
  await scrollRegion(page, "board", { x: 150, y: 600 });
  const expected = await openDetailFrom(page, await visibleIssueLink(page));
  expect(expected.board).toEqual({ x: 150, y: 600 });
  await page.goBack();
  await expect(lastRow(page, "API", 30)).toHaveCount(1);
  await expectPositions(page, { main: expected.main!, board: expected.board! });
});

test("グループ化した Board はグループごとの横位置と主領域の縦位置を復元する", async ({ page, nod }) => {
  await page.setViewportSize({ width: 1000, height: 960 });
  await addIssues(nod, 12);
  await page.goto("/issues?layout=board&groupBy=workspace");
  await expect(lastRow(page, "API", 12)).toHaveCount(1);
  const regions = await scrollRegions(page);
  const boards = Object.keys(regions).filter((key) => key.startsWith("board:") && regions[key]!.maxX > 60);
  expect(boards.length).toBeGreaterThanOrEqual(2);
  for (const [n, key] of boards.entries()) await scrollRegion(page, key, { x: 20 * (n + 1) });
  expect(regions.main!.maxY).toBeGreaterThan(200);
  await scrollRegion(page, "main", { y: 200 });
  const expected = await openDetailFrom(page, await visibleIssueLink(page));
  await page.goBack();
  await expect(lastRow(page, "API", 12)).toHaveCount(1);
  await expectPositions(page, Object.fromEntries(["main", ...boards].map((key) => [key, expected[key]!])));
});

test("一覧内のプレビューから詳細を開いても、戻ると一覧の位置とプレビューを保つ", async ({ page, nod }) => {
  const ids = await addIssues(nod, 40);
  await page.goto(`/issues?preview=${ids[0]}`);
  const pane = page.getByRole("complementary", { name: `${ids[0]} のプレビュー`, exact: true });
  const open = pane.getByRole("link", { name: "Issue を開く" });
  await expect(open).toBeVisible();
  await expect(lastRow(page)).toHaveCount(1);
  await scrollRegion(page, "main", { y: 800 });
  const expected = await openDetailFrom(page, open);
  expect(expected.main!.y).toBeGreaterThan(700);
  await page.goBack();
  await expect(open).toBeVisible();
  await expectPositions(page, { main: expected.main! });
});

test("検索語と並び順の違う一覧は、それぞれの履歴エントリで自分の位置に戻る", async ({ page, nod }) => {
  await addIssues(nod, 40);
  await page.goto(`/issues?q=${encodeURIComponent(TITLE)}`);
  await expect(lastRow(page)).toHaveCount(1);
  await scrollRegion(page, "main", { y: 500 });
  const first = await openDetailFrom(page, await visibleIssueLink(page));
  await page.goBack();
  await expectPositions(page, { main: first.main! });
  // 並び順を変える（新しい履歴エントリになる）。ポップオーバーを開くと主領域が動くため、
  // 元のエントリの期待値は、離れた瞬間の位置（並び順を変えた直後も同じ一覧の DOM が残す位置）にする
  await chooseDisplay(page, "並び順", "タイトル");
  await expect(page).toHaveURL(/sort=title/);
  const left = positions(await scrollRegions(page)).main!;
  await closeDisplay(page);
  await scrollRegion(page, "main", { y: 1000 });
  const second = await openDetailFrom(page, await visibleIssueLink(page));
  expect(second.main!.y).not.toBe(left.y);
  await page.goBack();
  await expect(page).toHaveURL(/sort=title/);
  await expectPositions(page, { main: second.main! });
  await page.goBack();
  await expect(page).not.toHaveURL(/sort=title/);
  await expect(page).toHaveURL(/q=/);
  await expectPositions(page, { main: left });
  await page.goForward();
  await expect(page).toHaveURL(/sort=title/);
  await expectPositions(page, { main: second.main! });
});

test("同じ URL でも別の履歴エントリの位置は使わず、Sidebar から新しく開いた一覧は先頭から出す", async ({ page, nod }) => {
  await addIssues(nod, 40);
  await page.goto("/issues");
  await expect(lastRow(page)).toHaveCount(1);
  await scrollRegion(page, "main", { y: 600 });
  const first = await openDetailFrom(page, await visibleIssueLink(page));
  // 詳細から Sidebar で Issues を開き直す（同じ URL の新しい履歴エントリ）
  await nav(page).getByRole("link", { name: "Issues", exact: true }).click();
  await expect(page).toHaveURL(/\/issues$/);
  await expect(lastRow(page)).toHaveCount(1);
  await nextFrames(page);
  await expectPositions(page, { main: { x: 0, y: 0 } });
  await scrollRegion(page, "main", { y: 1100 });
  const second = await openDetailFrom(page, await visibleIssueLink(page));
  await page.goBack();
  await expectPositions(page, { main: second.main! });
  await page.goBack();
  await expect(page).toHaveURL(/\/issues\/[A-Z]+-\d+$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/issues$/);
  await expectPositions(page, { main: first.main! });
});

test("戻ったときの再取得を待たせても、キャッシュの行で直前の位置に戻り、応答の後も保つ", async ({ page, nod }) => {
  await addIssues(nod, 40);
  await page.goto("/issues");
  await expect(lastRow(page)).toHaveCount(1);
  await scrollRegion(page, "main", { y: 900 });
  const expected = await openDetailFrom(page, await visibleIssueLink(page));
  await addIssues(nod, 3, "BLOG");
  const hold = await holdRequests(page, ISSUE_LISTS);
  await page.goBack();
  await expect.poll(() => hold.count()).toBeGreaterThan(0);
  await expectPositions(page, { main: expected.main! });
  await expect(lastRow(page, "BLOG", 3)).toHaveCount(0);
  await hold.release();
  await expect(lastRow(page, "BLOG", 3)).toHaveCount(1);
  await expectPositions(page, { main: expected.main! });
});

test("キャッシュの一覧が短いまま戻っても端に収めて目標を保ち、再取得で伸びたら元の位置へ戻る", async ({ page, nod }) => {
  const ids = await addIssues(nod, 40);
  await page.goto("/issues");
  await expect(lastRow(page)).toHaveCount(1);
  await waitForServerEvents(page);
  const { maxY } = await scrollRegion(page, "main", { y: 10_000 });
  await scrollRegion(page, "main", { y: maxY - 40 });
  const expected = await openDetailFrom(page, await visibleIssueLink(page));
  for (const id of ids.slice(10)) await nod.me.archiveIssue(id);
  // Projects も同じ全件の一覧を読むため、そこで読み直したキャッシュは短くなる
  const reloaded = page.waitForResponse((response) => /\/api\/issues$/.test(response.url()));
  await nav(page).getByRole("link", { name: "Projects", exact: true }).click();
  await reloaded;
  const hold = await holdRequests(page, ISSUE_LISTS);
  for (const id of ids.slice(10)) await nod.me.unarchiveIssue(id);
  await expect.poll(() => hold.count()).toBeGreaterThan(0);
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(/\/issues$/);
  await expect(page.getByRole("link", { name: `${TITLE} API 05`, exact: true })).toHaveCount(1);
  await expect(lastRow(page)).toHaveCount(0);
  await expect.poll(async () => { const m = (await scrollRegions(page)).main!; return m.y === m.maxY && m.y < expected.main!.y; }).toBe(true);
  await hold.release();
  await expect(lastRow(page)).toHaveCount(1);
  await expectPositions(page, { main: expected.main! });
});

// 詳細を開いている間に一覧の大半をアーカイブし、戻った後で元に戻す
async function shrinkWhileDetail(page: Page, nod: NodData) {
  const ids = await addIssues(nod, 40);
  await page.goto("/issues");
  await expect(lastRow(page)).toHaveCount(1);
  await waitForServerEvents(page);
  const { maxY } = await scrollRegion(page, "main", { y: 10_000 });
  await scrollRegion(page, "main", { y: maxY - 40 });
  const expected = await openDetailFrom(page, await visibleIssueLink(page));
  for (const id of ids.slice(10)) await nod.me.archiveIssue(id);
  await page.goBack();
  await expect(lastRow(page)).toHaveCount(0);
  await expect(page.getByRole("link", { name: `${TITLE} API 05`, exact: true })).toHaveCount(1);
  // 最終的に短くなった一覧では、到達できる範囲に収め、範囲外の空白を残さない
  await expect.poll(async () => { const m = (await scrollRegions(page)).main!; return m.y === m.maxY && m.y < expected.main!.y; }).toBe(true);
  return { expected: expected.main!, grow: async () => { for (const id of ids.slice(10)) await nod.me.unarchiveIssue(id); } };
}

test("最終的に短くなった一覧は到達できる範囲に収め、更新通知で伸びたら元の位置へ当て直す", async ({ page, nod }) => {
  const { expected, grow } = await shrinkWhileDetail(page, nod);
  await grow();
  await expect(lastRow(page)).toHaveCount(1);
  await expectPositions(page, { main: expected });
});

test("復元を待っている間に利用者がスクロールしたら、その後に一覧が伸びても引き戻さない", async ({ page, nod }) => {
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

test("復元を待っている間に一覧から離れたら、保留中の復元を別の画面に当てず、戻ったときに元の目標で復元する", async ({ page, nod }) => {
  const { expected, grow } = await shrinkWhileDetail(page, nod);
  // 利用者の入力を伴わない履歴の操作（進む）で、復元を待っている一覧から詳細へ離れる
  await page.goForward();
  await expect(page).toHaveURL(/\/issues\/[A-Z]+-\d+$/);
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
  const before = (await scrollRegions(page)).main!.y;
  await grow();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.serverEvents)).toBe("ready");
  await nextFrames(page);
  expect((await scrollRegions(page)).main!.y).toBe(before);
  await page.goBack();
  await expect(lastRow(page)).toHaveCount(1);
  await expectPositions(page, { main: expected });
});

test("詳細を開いている間に一覧が空になったら、空の表示を保ち、後で行が戻っても古い位置へ引き戻さない", async ({ page, nod }) => {
  const ids = await addIssues(nod, 40);
  await page.goto(`/issues?q=${encodeURIComponent(TITLE)}`);
  await expect(lastRow(page)).toHaveCount(1);
  await waitForServerEvents(page);
  await scrollRegion(page, "main", { y: 800 });
  await openDetailFrom(page, await visibleIssueLink(page));
  for (const id of ids) await nod.me.archiveIssue(id);
  await page.goBack();
  await expect(page.getByText("該当する Issue はありません")).toBeVisible();
  await expectPositions(page, { main: { x: 0, y: 0 } });
  for (const id of ids) await nod.me.unarchiveIssue(id);
  await expect(lastRow(page)).toHaveCount(1);
  await nextFrames(page);
  expect(positions(await scrollRegions(page)).main).toEqual({ x: 0, y: 0 });
});

test.describe("戻ったときの再取得の失敗", () => {
  test.use({ allowedConsoleErrors: [/status of 500/] });

  test("最終的に取得に失敗したら通常のエラー表示を保ち、復元を待ち続けない", async ({ page, nod }) => {
    await addIssues(nod, 40);
    await page.goto("/issues");
    await expect(lastRow(page)).toHaveCount(1);
    await scrollRegion(page, "main", { y: 900 });
    await openDetailFrom(page, await visibleIssueLink(page));
    await page.route(ISSUE_LISTS, (route) => route.fulfill({ status: 500, json: { error: { code: "INTERNAL_ERROR", message: "一覧の取得に失敗" } } }));
    await page.goBack();
    const alert = page.getByRole("main").getByRole("alert");
    await expect(alert).toContainText("一覧の取得に失敗", { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "再試行" })).toBeVisible();
    const m = (await scrollRegions(page)).main!;
    expect(m.y).toBeLessThanOrEqual(Math.max(m.maxY, 0));
    await page.unroute(ISSUE_LISTS);
  });
});

test("復元を待っている間に入力欄で Space や矢印のキーを打っても、目標を保ち、一覧が伸びたら元の位置へ戻る", async ({ page, nod }) => {
  const { expected, grow } = await shrinkWhileDetail(page, nod);
  const clamped = (await scrollRegions(page)).main!.y;
  // 一覧の条件を変えない入力欄（全画面の Issue 検索）で、空白を含む語を打ち、カーソルを動かす。入力欄のキーは一覧のスクロール操作ではない
  await page.keyboard.press("Shift+Control+F");
  const dialog = page.getByRole("dialog", { name: "Issue を検索" });
  const search = dialog.getByRole("combobox");
  await expect(search).toBeFocused();
  await page.keyboard.type("API 05");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("End");
  await expect(search).toHaveValue("API 05");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect((await scrollRegions(page)).main!.y).toBe(clamped);
  await grow();
  await expect(lastRow(page)).toHaveCount(1);
  await expectPositions(page, { main: expected });
});

test("ポインタイベントを伴わないスクロールバーの押下（WebKit の mousedown と scroll だけ）でも、その後に一覧が伸びても引き戻さない", async ({ page, nod }) => {
  const { expected, grow } = await shrinkWhileDetail(page, nod);
  const clamped = (await scrollRegions(page)).main!.y;
  // WKWebView のスクロールバーのように、pointerdown なしの mousedown の後、位置だけが変わる
  await page.evaluate(() => {
    const main = document.querySelector("main") as HTMLElement;
    main.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  });
  await scrollRegion(page, "main", { y: clamped - 150 });
  const user = (await scrollRegions(page)).main!.y;
  await grow();
  await expect(lastRow(page)).toHaveCount(1);
  // 行が出ても領域の高さはまだ伸びていないことがあるため、元の目標まで届く高さになってから確かめる
  await expect.poll(async () => (await scrollRegions(page)).main!.maxY).toBeGreaterThanOrEqual(expected.y);
  await nextFrames(page);
  expect((await scrollRegions(page)).main!.y).toBe(user);
});
