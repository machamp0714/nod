import type { Page } from "@playwright/test";
import { expect, test, waitForServerEvents } from "./fixtures";
import { chooseDisplay, closeDisplay } from "./support/issue-list";
import { disableScrollAnchoring, expectPositions, holdRequests, openDetailFrom, positions, scrollRegion, scrollRegions, visibleIssueLink } from "./support/list-scroll";
import type { NodData } from "./support/nod";

// View の一覧からタスク詳細を開き、同じ履歴エントリへ戻ったときの保存前の Filter とスクロール位置（NOD-52）。
// 期待値は、リンクを押す直前に各領域を実測した値にする。待つときは固定の sleep ではなく、応答・行・位置を観測する。
// データセットの View 1「仕事」は Workspace が API の Issue だけを出す
test.use({ dataset: "issue-list" });
test.beforeEach(({ page }) => disableScrollAnchoring(page));

const TITLE = "スクロール確認 Issue";
// データセットの BLOG の Issue。保存前の Filter で Workspace に blog を足したときだけ出る
const BLOG_ROW = "ブログの OGP 画像を自動生成";

async function addIssues(nod: NodData, n: number, workspace = "API"): Promise<string[]> {
  const [ws] = (await nod.me.listWorkspaces()).filter((w) => w.key === workspace);
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    const issue = await nod.me.createIssue({ workspaceId: ws!.id, title: `${TITLE} ${workspace} ${String(i).padStart(2, "0")}` });
    ids.push(issue.id);
  }
  return ids;
}

const lastRow = (page: Page, workspace = "API", n = 40) => page.getByRole("link", { name: `${TITLE} ${workspace} ${String(n).padStart(2, "0")}`, exact: true });
const blogRow = (page: Page) => page.getByRole("main").getByRole("link", { name: BLOG_ROW, exact: true });
const dirty = (page: Page) => page.getByText("変更あり", { exact: true });
const savedViews = async (page: Page) => (await (await page.request.get("/api/views")).json()) as unknown[];

// View とページ表示設定への書き込み（GET 以外）を数える
function recordWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if ((path.startsWith("/api/views") || path.startsWith("/api/page-displays")) && request.method() !== "GET") writes.push(`${request.method()} ${path}`);
  });
  return writes;
}

// 保存前の Filter として、Workspace に blog を足す（「Filter」のパネルは閉じておく）
async function addBlogToFilter(page: Page) {
  const filter = page.getByText("Filter", { exact: true });
  await filter.click();
  await page.getByRole("group", { name: "Workspace" }).getByRole("checkbox", { name: "blog", exact: true }).check();
  await filter.click();
  await expect(blogRow(page)).toHaveCount(1);
  await expect(dirty(page)).toHaveCount(1);
}

test("保存前の Filter と主領域の位置は、詳細から戻ると同じまま戻り、View にもページ表示設定にも保存しない", async ({ page, nod }) => {
  await addIssues(nod, 40);
  await page.goto("/views/1");
  await expect(lastRow(page)).toHaveCount(1);
  await addBlogToFilter(page);
  const before = await savedViews(page);
  const writes = recordWrites(page);

  await scrollRegion(page, "main", { y: 700 });
  const expected = await openDetailFrom(page, await visibleIssueLink(page));
  expect(expected.main!.y).toBeGreaterThan(600);
  await page.goBack();
  await expect(page).toHaveURL(/\/views\/1$/);
  await expect(blogRow(page)).toHaveCount(1);
  await expect(dirty(page)).toHaveCount(1);
  await expectPositions(page, { main: expected.main! });
  // 往復しただけでは View の定義にもページ表示設定にも書かない
  expect(await savedViews(page)).toEqual(before);
  expect(writes).toEqual([]);
  expect(positions(await scrollRegions(page)).main).toEqual(expected.main);
});

const VIEW_LISTS = /\/api\/views$/;
const ISSUE_LISTS = /\/api\/issues(\?.*)?$/;
const nav = (page: Page) => page.getByRole("navigation", { name: "メイン" });
const heading = (page: Page) => page.getByRole("main").getByRole("heading", { level: 1 });

// 描画が落ち着くまで（2フレーム）待つ。引き戻しがないことを確かめる前に使う
const nextFrames = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

// データセットの NOD の Issue。保存前の Filter で Workspace に nod を足したときだけ出る
const NOD_ROW = "Sidebar に件数を表示する";
const nodRow = (page: Page) => page.getByRole("main").getByRole("link", { name: NOD_ROW, exact: true });

test("同じ View の2つの履歴エントリを戻る・進むで行き来すると、それぞれの保存前の Filter と位置に戻る", async ({ page, nod }) => {
  await addIssues(nod, 40);
  await page.goto("/views/1");
  await expect(lastRow(page)).toHaveCount(1);
  await addBlogToFilter(page);
  // 並び順を変える（同じ View の新しい履歴エントリになる）。新しいエントリでは、保存前の Filter に nod も足す
  await chooseDisplay(page, "並び順", "タイトル");
  await expect(page).toHaveURL(/sort=title/);
  await closeDisplay(page);
  const filter = page.getByText("Filter", { exact: true });
  await filter.click();
  await page.getByRole("group", { name: "Workspace" }).getByRole("checkbox", { name: "nod", exact: true }).check();
  await filter.click();
  await expect(nodRow(page)).toHaveCount(1);
  await scrollRegion(page, "main", { y: 1000 });
  const second = positions(await scrollRegions(page)).main!;
  expect(second.y).toBeGreaterThan(900);
  // 戻ると、元のエントリの保存前の Filter（blog だけを足したもの）に戻る
  await page.goBack();
  await expect(page).not.toHaveURL(/sort=title/);
  await expect(blogRow(page)).toHaveCount(1);
  await expect(nodRow(page)).toHaveCount(0);
  await expect(dirty(page)).toHaveCount(1);
  await scrollRegion(page, "main", { y: 600 });
  const first = positions(await scrollRegions(page)).main!;
  expect(first.y).toBeGreaterThan(500);
  // 進むと、新しいエントリの保存前の Filter（nod も足したもの）と位置に戻る
  await page.goForward();
  await expect(page).toHaveURL(/sort=title/);
  await expect(nodRow(page)).toHaveCount(1);
  await expect(blogRow(page)).toHaveCount(1);
  await expectPositions(page, { main: second });
  // もう一度戻ると、元のエントリの Filter と位置に戻る
  await page.goBack();
  await expect(page).not.toHaveURL(/sort=title/);
  await expect(nodRow(page)).toHaveCount(0);
  await expect(blogRow(page)).toHaveCount(1);
  await expectPositions(page, { main: first });
});

test("別の View はそれぞれの履歴エントリで自分の条件と位置に戻り、Sidebar から開き直した View は保存した条件で先頭から出す", async ({ page, nod }) => {
  await addIssues(nod, 40);
  await addIssues(nod, 40, "BLOG");
  await page.goto("/views/1");
  await expect(lastRow(page)).toHaveCount(1);
  await addBlogToFilter(page);
  await scrollRegion(page, "main", { y: 600 });
  const work = await openDetailFrom(page, await visibleIssueLink(page));
  await page.goBack();
  await expectPositions(page, { main: work.main! });
  // 別の View（プライベート：BLOG）を違う位置で往復する
  await nav(page).getByRole("link", { name: "プライベート" }).click();
  await expect(heading(page)).toHaveText("プライベート");
  await expect(lastRow(page, "BLOG")).toHaveCount(1);
  await expect(dirty(page)).toHaveCount(0);
  await scrollRegion(page, "main", { y: 1100 });
  const blog = await openDetailFrom(page, await visibleIssueLink(page));
  expect(blog.main!.y).not.toBe(work.main!.y);
  await page.goBack();
  await expect(heading(page)).toHaveText("プライベート");
  await expectPositions(page, { main: blog.main! });
  await expect(dirty(page)).toHaveCount(0);
  // 戻る操作で元の View のエントリへ戻ると、その View の保存前の条件と位置に戻る
  await page.goBack();
  await expect(heading(page)).toHaveText("仕事");
  await expect(blogRow(page)).toHaveCount(1);
  await expect(dirty(page)).toHaveCount(1);
  await expectPositions(page, { main: work.main! });
  // Sidebar から開き直した View（同じ URL の新しい履歴エントリ）には、保存前の条件も位置も使わない
  await nav(page).getByRole("link", { name: "プライベート" }).click();
  await expect(heading(page)).toHaveText("プライベート");
  await nav(page).getByRole("link", { name: "仕事" }).click();
  await expect(heading(page)).toHaveText("仕事");
  await expect(lastRow(page)).toHaveCount(1);
  await expect(blogRow(page)).toHaveCount(0);
  await expect(dirty(page)).toHaveCount(0);
  await nextFrames(page);
  await expectPositions(page, { main: { x: 0, y: 0 } });
});

test("詳細を開いている間に View の保存した表示設定が変わったら、古い保存前の条件も位置も使わない", async ({ page, nod }) => {
  await addIssues(nod, 40);
  await page.goto("/views/1");
  await expect(lastRow(page)).toHaveCount(1);
  await waitForServerEvents(page);
  await addBlogToFilter(page);
  await scrollRegion(page, "main", { y: 700 });
  await openDetailFrom(page, await visibleIssueLink(page));
  await nod.me.updateView(1, { display: { sort: "title" } });
  await expect.poll(async () => ((await savedViews(page))[0] as { display: unknown }).display).toEqual({ sort: "title" });
  await page.goBack();
  await expect(page).toHaveURL(/\/views\/1$/);
  await expect(lastRow(page)).toHaveCount(1);
  await expect(blogRow(page)).toHaveCount(0);
  await expect(dirty(page)).toHaveCount(0);
  await nextFrames(page);
  await expectPositions(page, { main: { x: 0, y: 0 } });
});

test("戻ったときの View の再取得が遅れ、その応答で保存した条件が変わっていたら、キャッシュで当てた条件と位置を捨てる", async ({ page, nod }) => {
  await addIssues(nod, 40);
  await page.goto("/views/1");
  await expect(lastRow(page)).toHaveCount(1);
  await waitForServerEvents(page);
  await addBlogToFilter(page);
  await scrollRegion(page, "main", { y: 700 });
  const expected = await openDetailFrom(page, await visibleIssueLink(page));
  // 変更の通知による View の読み直しを止めておく（画面のキャッシュは古い定義のまま）
  const hold = await holdRequests(page, VIEW_LISTS);
  await nod.me.updateView(1, { filter: { workspace: ["API", "NOD"] } });
  await expect.poll(() => hold.count()).toBeGreaterThan(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/views\/1$/);
  // 応答の前は、キャッシュの定義（詳細を開く前と同じ）の一覧へ戻る
  await expect(blogRow(page)).toHaveCount(1);
  await expectPositions(page, { main: expected.main! });
  await hold.release();
  // 定義が変わった一覧には、古い保存前の条件と位置を当てない
  await expect(blogRow(page)).toHaveCount(0);
  await expect(dirty(page)).toHaveCount(0);
  await expect(lastRow(page)).toHaveCount(1);
  await nextFrames(page);
  await expectPositions(page, { main: { x: 0, y: 0 } });
});

test("戻ったときの一覧と View の再取得を待たせても、キャッシュで保存前の条件と位置に戻り、応答の後も保つ", async ({ page, nod }) => {
  await addIssues(nod, 40);
  await page.goto("/views/1");
  await expect(lastRow(page)).toHaveCount(1);
  await addBlogToFilter(page);
  await scrollRegion(page, "main", { y: 900 });
  const expected = await openDetailFrom(page, await visibleIssueLink(page));
  await addIssues(nod, 3, "BLOG");
  const views = await holdRequests(page, VIEW_LISTS);
  const issues = await holdRequests(page, ISSUE_LISTS);
  await page.goBack();
  await expect.poll(() => views.count()).toBeGreaterThan(0);
  await expect.poll(() => issues.count()).toBeGreaterThan(0);
  await expect(blogRow(page)).toHaveCount(1);
  await expectPositions(page, { main: expected.main! });
  await views.release();
  await issues.release();
  await expect(lastRow(page, "BLOG", 3)).toHaveCount(1);
  await expect(dirty(page)).toHaveCount(1);
  await expectPositions(page, { main: expected.main! });
});

test("View の Board（グループなし）は Board の中の縦横の位置を、プレビューから詳細を開いても復元する", async ({ page, nod }) => {
  const ids = await addIssues(nod, 30);
  await nod.me.updateView(1, { display: { layout: "board" } });
  await page.goto(`/views/1?preview=${ids[0]}`);
  const pane = page.getByRole("complementary", { name: `${ids[0]} のプレビュー`, exact: true });
  const open = pane.getByRole("link", { name: "Issue を開く" });
  await expect(open).toBeVisible();
  await expect(lastRow(page, "API", 30)).toHaveCount(1);
  await addBlogToFilter(page);
  const regions = await scrollRegions(page);
  expect(regions.board!.maxX).toBeGreaterThan(100);
  expect(regions.board!.maxY).toBeGreaterThan(400);
  await scrollRegion(page, "board", { x: 100, y: 500 });
  const expected = await openDetailFrom(page, open);
  expect(expected.board).toEqual({ x: 100, y: 500 });
  await page.goBack();
  await expect(open).toBeVisible();
  await expect(blogRow(page)).toHaveCount(1);
  await expectPositions(page, { main: expected.main!, board: expected.board! });
});

test("グループ化した View の List と Board は、表ごと・グループごとの横位置と主領域の縦位置を復元する", async ({ page, nod }) => {
  await page.setViewportSize({ width: 860, height: 960 });
  await addIssues(nod, 30);
  await page.goto("/views/1?groupBy=workspace");
  await expect(lastRow(page, "API", 30)).toHaveCount(1);
  await addBlogToFilter(page);
  const tables = ['table:["API"]', 'table:["BLOG"]'];
  const regions = await scrollRegions(page);
  for (const key of tables) expect(regions[key]?.maxX, key).toBeGreaterThan(20);
  await scrollRegion(page, tables[0]!, { x: Math.round(regions[tables[0]!]!.maxX / 3) });
  await scrollRegion(page, tables[1]!, { x: regions[tables[1]!]!.maxX });
  await scrollRegion(page, "main", { y: 300 });
  const list = await openDetailFrom(page, await visibleIssueLink(page));
  expect(list[tables[0]!]!.x).not.toBe(list[tables[1]!]!.x);
  await page.goBack();
  await expect(blogRow(page)).toHaveCount(1);
  await expectPositions(page, Object.fromEntries(["main", ...tables].map((key) => [key, list[key]!])));

  await page.goto("/views/1?groupBy=workspace&layout=board");
  await expect(lastRow(page, "API", 30)).toHaveCount(1);
  await addBlogToFilter(page);
  const boardRegions = await scrollRegions(page);
  const boards = Object.keys(boardRegions).filter((key) => key.startsWith("board:") && boardRegions[key]!.maxX > 60);
  expect(boards.length).toBeGreaterThanOrEqual(2);
  for (const [n, key] of boards.entries()) await scrollRegion(page, key, { x: 20 * (n + 1) });
  await scrollRegion(page, "main", { y: 200 });
  const board = await openDetailFrom(page, await visibleIssueLink(page));
  await page.goBack();
  await expect(blogRow(page)).toHaveCount(1);
  await expectPositions(page, Object.fromEntries(["main", ...boards].map((key) => [key, board[key]!])));
});

test("キャッシュの一覧が短いまま View へ戻っても端に収めて目標を保ち、再取得で伸びたら元の位置へ戻る", async ({ page, nod }) => {
  const ids = await addIssues(nod, 40);
  // 保存前の条件（API と BLOG）と同じ条件を保存した View。そこで読み直したキャッシュは短くなる
  const same = await nod.me.createView({ name: "API と blog", filter: { workspace: ["API", "BLOG"] } });
  await page.goto("/views/1");
  await expect(lastRow(page)).toHaveCount(1);
  await waitForServerEvents(page);
  await addBlogToFilter(page);
  const { maxY } = await scrollRegion(page, "main", { y: 10_000 });
  await scrollRegion(page, "main", { y: maxY - 40 });
  const expected = await openDetailFrom(page, await visibleIssueLink(page));
  for (const id of ids.slice(25)) await nod.me.archiveIssue(id);
  const reloaded = page.waitForResponse((response) => /\/api\/issues\?/.test(response.url()));
  await nav(page).getByRole("link", { name: same.name }).click();
  await reloaded;
  await expect(lastRow(page)).toHaveCount(0);
  const hold = await holdRequests(page, ISSUE_LISTS);
  for (const id of ids.slice(25)) await nod.me.unarchiveIssue(id);
  await expect.poll(() => hold.count()).toBeGreaterThan(0);
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(/\/views\/1$/);
  await expect(dirty(page)).toHaveCount(1);
  await expect(blogRow(page)).toHaveCount(1);
  await expect(lastRow(page)).toHaveCount(0);
  await expect.poll(async () => { const m = (await scrollRegions(page)).main!; return m.y === m.maxY && m.y < expected.main!.y; }).toBe(true);
  await hold.release();
  await expect(lastRow(page)).toHaveCount(1);
  await expectPositions(page, { main: expected.main! });
});

test("詳細を開いている間に View の一覧が短くなったら到達できる範囲に収め、利用者がスクロールした後は伸びても引き戻さない", async ({ page, nod }) => {
  const ids = await addIssues(nod, 40);
  await page.goto("/views/1");
  await expect(lastRow(page)).toHaveCount(1);
  await waitForServerEvents(page);
  await addBlogToFilter(page);
  const { maxY } = await scrollRegion(page, "main", { y: 10_000 });
  await scrollRegion(page, "main", { y: maxY - 40 });
  const expected = await openDetailFrom(page, await visibleIssueLink(page));
  for (const id of ids.slice(25)) await nod.me.archiveIssue(id);
  await page.goBack();
  await expect(lastRow(page)).toHaveCount(0);
  await expect(blogRow(page)).toHaveCount(1);
  await expect.poll(async () => { const m = (await scrollRegions(page)).main!; return m.y === m.maxY && m.y < expected.main!.y; }).toBe(true);
  const clamped = (await scrollRegions(page)).main!.y;
  expect(clamped).toBeGreaterThan(250);
  await page.locator("main").hover();
  await page.mouse.wheel(0, -200);
  await expect.poll(async () => (await scrollRegions(page)).main!.y).toBeLessThan(clamped - 50);
  const user = (await scrollRegions(page)).main!.y;
  for (const id of ids.slice(25)) await nod.me.unarchiveIssue(id);
  await expect(lastRow(page)).toHaveCount(1);
  // 行が出ても領域の高さはまだ伸びていないことがあるため、元の目標まで届く高さになってから確かめる
  await expect.poll(async () => (await scrollRegions(page)).main!.maxY).toBeGreaterThanOrEqual(expected.main!.y);
  await nextFrames(page);
  expect((await scrollRegions(page)).main!.y).toBe(user);
});

test("詳細を開いている間に View が削除されたら「View が見つかりません」を出し、古い位置を他の一覧へ漏らさない", async ({ page, nod }) => {
  await addIssues(nod, 40);
  await page.goto("/views/1");
  await expect(lastRow(page)).toHaveCount(1);
  await waitForServerEvents(page);
  await addBlogToFilter(page);
  await scrollRegion(page, "main", { y: 800 });
  await openDetailFrom(page, await visibleIssueLink(page));
  await nod.me.deleteView(1);
  await expect(nav(page).getByRole("link", { name: "仕事" })).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/views\/1$/);
  await expect(heading(page)).toHaveText("View が見つかりません");
  const m = (await scrollRegions(page)).main!;
  expect(m.y).toBeLessThanOrEqual(Math.max(m.maxY, 0));
  // 別の一覧を新しく開いても、消えた View の位置を使わない
  await nav(page).getByRole("link", { name: "Issues", exact: true }).click();
  await expect(lastRow(page)).toHaveCount(1);
  await nextFrames(page);
  await expectPositions(page, { main: { x: 0, y: 0 } });
});

test.describe("戻ったときの View の一覧の再取得の失敗", () => {
  test.use({ allowedConsoleErrors: [/status of 500/] });

  test("最終的に取得に失敗したら通常のエラー表示を保ち、復元を待ち続けない", async ({ page, nod }) => {
    await addIssues(nod, 40);
    await page.goto("/views/1");
    await expect(lastRow(page)).toHaveCount(1);
    await addBlogToFilter(page);
    await scrollRegion(page, "main", { y: 900 });
    await openDetailFrom(page, await visibleIssueLink(page));
    await page.route(ISSUE_LISTS, (route) => route.fulfill({ status: 500, json: { error: { code: "INTERNAL_ERROR", message: "一覧の取得に失敗" } } }));
    await page.goBack();
    const alert = page.getByRole("main").getByRole("alert");
    await expect(alert).toContainText("一覧の取得に失敗", { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "再試行" })).toBeVisible();
    // 保存前の条件は保ったまま（View には保存しない）
    await expect(dirty(page)).toHaveCount(1);
    const m = (await scrollRegions(page)).main!;
    expect(m.y).toBeLessThanOrEqual(Math.max(m.maxY, 0));
    await page.unroute(ISSUE_LISTS);
  });
});
