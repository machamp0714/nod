import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { chooseDisplay, columnChip, displaySelect, displaySwitch, openDisplay, searchBox } from "./support/issue-list";
import type { NodData } from "./support/nod";

// Issues 一覧（#182）とボード（#183）の寸法。design/nod.pen の「11 Issues」（O7KCp3）、「Display Popover」（EMZdB）、
// 「Issues｜ボード（Linear 準拠）」（Cjq7Z）、「コントロールの型」の Hidden columns（PR46C）に合わせる。
// 画面は playwright.config.ts の 1440×960 で開く
test.use({ dataset: "issue-list" });

const PILL = "9999px";

const overflow = (page: Page) =>
  page.evaluate(() => {
    const main = document.querySelector("main") as HTMLElement;
    return {
      page: document.documentElement.scrollWidth - window.innerWidth,
      pageY: document.documentElement.scrollHeight - window.innerHeight,
      main: main.scrollWidth - main.clientWidth,
    };
  });

// 同じ行の中で、子要素の中心が行の中心から何 px ずれているか（最大）
const rowMisalignment = (page: Page, rowSelector: string, itemSelector: string) =>
  page.evaluate(
    ([rows, items]) => {
      let max = 0;
      for (const row of document.querySelectorAll(rows as string)) {
        const r = row.getBoundingClientRect();
        for (const item of row.querySelectorAll(items as string)) {
          const b = item.getBoundingClientRect();
          if (b.width <= 1 || b.height <= 1) continue; // 視覚的に隠したプレビューボタン
          max = Math.max(max, Math.abs(b.y + b.height / 2 - (r.y + r.height / 2)));
        }
      }
      return Math.round(max * 100) / 100;
    },
    [rowSelector, itemSelector],
  );

async function cycleDetailPath(nod: NodData): Promise<string> {
  const [api] = (await nod.me.listWorkspaces()).filter((w) => w.key === "API");
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString("sv-SE");
  const cycle = await nod.me.createCycle({ workspaceId: api!.id, name: "Sprint 12", startDate: day(-3), endDate: day(3) });
  for (const id of ["API-12", "API-8", "API-4"]) await nod.me.updateIssue(id, { cycleRef: String(cycle.id) });
  return `/cycles/${cycle.id}`;
}

test("一覧は Header 44 の下に View Bar 43 を置き、件数カードと列見出しを出さず、行は 44、グループ見出しは 36", async ({ page }) => {
  await page.goto("/issues?groupBy=status&subGroupBy=priority");
  await expect(page.locator("main tbody tr[data-issue-row]")).toHaveCount(13);
  const m = await page.evaluate(() => {
    const main = document.querySelector("main") as HTMLElement;
    const box = (el: Element) => el.getBoundingClientRect();
    const tabs = main.querySelector('[role="tablist"][aria-label="絞り込み"]') as HTMLElement;
    const bar = tabs.parentElement as HTMLElement;
    const header = main.querySelector("header") as HTMLElement;
    const row = main.querySelector("tbody tr[data-issue-row]") as HTMLElement;
    const css = (el: Element) => getComputedStyle(el);
    const id = row.querySelector("td:nth-child(3)") as HTMLElement;
    const title = row.querySelector('a[href^="/issues/"]') as HTMLElement;
    const firstCell = row.querySelector("td") as HTMLElement;
    const lastCell = row.querySelector("td:last-child") as HTMLElement;
    const h2 = main.querySelector("h2") as HTMLElement;
    const h3 = main.querySelector("h3") as HTMLElement;
    const body = h2.closest("section")?.parentElement as HTMLElement;
    const filters = main.querySelector('[role="group"][aria-label="絞り込み条件"]')?.parentElement as HTMLElement;
    return {
      header: box(header).height,
      viewBar: { height: box(bar).height, top: box(bar).y - box(header).bottom, paddingLeft: css(bar).paddingLeft, paddingRight: css(bar).paddingRight, gap: css(bar).gap },
      iconButtons: [...bar.querySelectorAll(":scope > button, :scope > div:not([role]) > button")].map((b) => `${box(b).width}x${box(b).height} ${css(b).borderTopLeftRadius}`),
      filters: { height: box(filters).height, borderBottom: css(filters).borderBottomWidth },
      rowHeights: [...new Set([...main.querySelectorAll("tbody tr[data-issue-row]")].map((r) => box(r).height))],
      row: { radius: `${css(firstCell).borderTopLeftRadius} ${css(lastCell).borderTopRightRadius}`, borderBottom: css(firstCell).borderBottomWidth, left: box(row).x - box(main).x - 1 },
      id: `${css(id).fontSize} ${css(id).fontFamily.includes("Mono")}`,
      title: `${css(title).fontSize} ${css(title).fontWeight}`,
      groupHeadings: [...new Set([...main.querySelectorAll("h2")].map((h) => box(h).height))],
      group: { left: box(h2).x - box(main).x - 1, right: box(main).right - 1 - box(h2).right, radius: css(h2).borderTopLeftRadius, font: `${css(h2).fontSize} ${css(h2).fontWeight}`, paddingLeft: css(h2).paddingLeft },
      subgroupHeadings: [...new Set([...main.querySelectorAll("h3")].map((h) => box(h).height))],
      subgroupRadius: css(h3).borderTopLeftRadius,
      bodyPadding: css(body).padding,
      theadHeight: box(main.querySelector("thead") as HTMLElement).height,
    };
  });
  console.log(`[issues-layout] list ${JSON.stringify(m)}`);
  expect(m.header).toBe(44);
  expect(m.viewBar).toEqual({ height: 43, top: 0, paddingLeft: "8px", paddingRight: "12px", gap: "6px" });
  // 検索、Filter、Display は 28 の円形のアイコンボタン
  expect(m.iconButtons).toEqual([`28x28 ${PILL}`, `28x28 ${PILL}`, `28x28 ${PILL}`]);
  expect(m.filters).toEqual({ height: 46, borderBottom: "1px" });
  expect(m.rowHeights).toEqual([44]);
  expect(m.row).toEqual({ radius: "8px 8px", borderBottom: "0px", left: 8 });
  expect(m.id).toBe("13px true");
  expect(m.title).toBe("13px 500");
  expect(m.groupHeadings).toEqual([36]);
  expect(m.group).toEqual({ left: 8, right: 8, radius: "8px", font: "13px 500", paddingLeft: "12px" });
  expect(m.subgroupHeadings).toEqual([32]);
  expect(m.subgroupRadius).toBe("8px");
  expect(m.bodyPadding).toBe("8px");
  // 列見出しは支援技術にだけ残す
  expect(m.theadHeight).toBeLessThanOrEqual(1);
  await expect(page.getByRole("button", { name: /^Ready/ })).toHaveCount(0);
  // View Bar にネイティブの select は置かない（グループ化、並び順は Display のポップオーバーにある）
  await expect(page.getByRole("tablist", { name: "絞り込み" }).locator("xpath=..").locator("select")).toHaveCount(0);
  // 行の中のアイコン、文字、チップ、チェックボックスの中心は、行の中心から 2.5px 以内
  const drift = await rowMisalignment(page, "main tbody tr[data-issue-row]", "td > *, td > div > *");
  const headingDrift = await rowMisalignment(page, "main h2, main h3", ":scope > *");
  console.log(`[issues-layout] list misalignment ${JSON.stringify({ row: drift, heading: headingDrift })}`);
  expect(drift).toBeLessThanOrEqual(2.5);
  expect(headingDrift).toBeLessThanOrEqual(2.5);
  expect(await overflow(page)).toEqual({ page: 0, pageY: 0, main: 0 });
});

test("ラベル、完了候補、ブロック元、プレビューのボタンがあっても行は 44 のまま", async ({ page, nod }) => {
  await nod.me.updateIssue("API-13", { addLabels: ["bug", "perf", "とても長いラベルの名前"] });
  await page.goto("/issues?tab=delegated");
  await expect(page.locator("main tbody tr[data-issue-row]")).toHaveCount(4);
  await page.goto("/issues");
  const rows = page.locator("main tbody tr[data-issue-row]");
  await expect(rows).toHaveCount(13);
  const blocked = page.locator('tr[data-issue-row="API-13"]');
  await expect(blocked).toContainText("ブロック元:");
  await blocked.hover();
  await expect(blocked.getByRole("button", { name: "API-13 をプレビュー" })).toBeVisible();
  const heights = await rows.evaluateAll((list) => [...new Set(list.map((row) => row.getBoundingClientRect().height))]);
  console.log(`[issues-layout] rows with chips ${JSON.stringify(heights)}`);
  expect(heights).toEqual([44]);
  expect(await rowMisalignment(page, "main tbody tr[data-issue-row]", "td > *, td > div > *")).toBeLessThanOrEqual(2.5);
  expect(await overflow(page)).toEqual({ page: 0, pageY: 0, main: 0 });
});

test("Display のポップオーバーは幅 302 で、コンボボックス、スイッチ、表示列のチップをまとめる", async ({ page }) => {
  await page.goto("/issues");
  await expect(page.locator("main tbody tr[data-issue-row]")).toHaveCount(13);
  const popover = await openDisplay(page);
  const trigger = page.getByRole("button", { name: "表示設定", exact: true });
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(popover).toHaveCSS("border-radius", "12px");
  await expect(popover.locator("select")).toHaveCount(0);
  const grouping = await displaySelect(page, "グループ化");
  const m = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="表示設定"]') as HTMLElement;
    const box = (el: Element) => el.getBoundingClientRect();
    const css = (el: Element) => getComputedStyle(el);
    const size = (el: Element) => `${box(el).width}x${box(el).height}`;
    const trigger = document.querySelector('button[aria-label="表示設定"]') as HTMLElement;
    const tablist = dialog.querySelector('[role="tablist"]') as HTMLElement;
    const select = dialog.querySelector('button[aria-label="グループ化"]') as HTMLElement;
    const direction = dialog.querySelector('button[aria-label="並び順の方向"]') as HTMLElement;
    const toggle = dialog.querySelector('[role="switch"]') as HTMLElement;
    const chip = dialog.querySelector("fieldset button") as HTMLElement;
    const row = select.parentElement?.parentElement as HTMLElement;
    const label = row.querySelector("span") as HTMLElement;
    const main = document.querySelector("main") as HTMLElement;
    return {
      width: box(dialog).width,
      right: box(trigger).right - box(dialog).right,
      below: box(dialog).y - box(trigger).bottom,
      insideMain: box(dialog).right <= box(main).right && box(dialog).bottom <= box(main).bottom,
      layoutTabs: `${size(tablist)} ${css(tablist).borderTopLeftRadius}`,
      layoutTab: [...tablist.querySelectorAll('[role="tab"]')].map((tab) => size(tab)),
      row: box(row).height,
      label: `${css(label).fontSize} ${css(label).fontWeight}`,
      select: `${size(select)} ${css(select).borderTopLeftRadius}`,
      direction: `${size(direction)} ${css(direction).borderTopLeftRadius}`,
      switch: size(toggle),
      chip: `${box(chip).height} ${css(chip).borderTopLeftRadius}`,
      sectionPadding: css(toggle.closest("div") as HTMLElement).padding,
    };
  });
  console.log(`[issues-layout] display popover ${JSON.stringify(m)}`);
  expect(m).toEqual({
    width: 302,
    right: 0,
    below: 5,
    insideMain: true,
    layoutTabs: `270x32 ${PILL}`,
    layoutTab: ["132x28", "132x28"],
    row: 32,
    label: "12px 500",
    select: "100x24 8px",
    direction: `24x24 ${PILL}`,
    switch: "22x14",
    chip: `24 ${PILL}`,
    sectionPadding: "8px 15px", // 枠線 1 と合わせて、内側の左右は 16
  });
  // コンボボックスは共通の Menu（角丸 12）と MenuItem（高さ 32、角丸 8）で開く
  await grouping.click();
  const menu = page.getByRole("menu", { name: "グループ化", exact: true });
  await expect(menu).toHaveCSS("border-radius", "12px");
  const item = menu.getByRole("menuitemradio", { name: "なし", exact: true });
  await expect(item).toHaveAttribute("aria-checked", "true");
  await expect(item).toBeFocused();
  await expect(item).toHaveCSS("height", "32px");
  await expect(item).toHaveCSS("border-radius", "8px");
  // 上下キー、Home、End で移り、Escape はメニューだけを閉じてコンボボックスへ戻る
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitemradio", { name: "ラベル", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(item).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(menu.getByRole("menuitemradio", { name: "ラベル", exact: true })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(item).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(popover).toBeVisible();
  await expect(grouping).toBeFocused();
  await expect(grouping).toHaveAttribute("aria-expanded", "false");
  // 外側を押すとメニューだけが閉じ、ポップオーバーの外側を押すとポップオーバーが閉じる
  await grouping.click();
  await expect(menu).toBeVisible();
  await popover.getByText("グループ化", { exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(popover).toBeVisible();
  // スイッチとチップは押すたびに切り替わり、URL に残る
  const completed = await displaySwitch(page, "完了済み Issue を表示");
  await expect(completed).toHaveAttribute("aria-checked", "true");
  await page.getByText("完了済み Issue を表示", { exact: true }).click();
  await expect(completed).toHaveAttribute("aria-checked", "false");
  await expect(page).toHaveURL(/showCompleted=false/);
  const pr = await columnChip(page, "PR");
  await expect(pr).toHaveAttribute("aria-pressed", "false");
  await pr.click();
  await expect(pr).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/columns=/);
  await page.getByRole("heading", { level: 1, name: "Issues" }).click();
  await expect(popover).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(await overflow(page)).toEqual({ page: 0, pageY: 0, main: 0 });
});

test("検索のアイコンボタンは入力欄を開き、空のまま Escape で閉じてボタンへ戻る。Filter のボタンは条件のパネルを開く", async ({ page }) => {
  await page.goto("/issues");
  await expect(page.locator("main tbody tr[data-issue-row]")).toHaveCount(13);
  await expect(page.getByRole("textbox", { name: "検索", exact: true })).toHaveCount(0);
  const box = await searchBox(page);
  await expect(box.locator("xpath=..")).toHaveCSS("height", "28px");
  await expect(box.locator("xpath=..")).toHaveCSS("border-radius", PILL);
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
  await expect(page.getByRole("button", { name: "検索を開く", exact: true })).toBeFocused();
  // 検索語があるあいだは開いたままで、再読み込みしても開いている
  await (await searchBox(page)).fill("N+1");
  await expect(page.locator("main tbody tr[data-issue-row]")).toHaveCount(1);
  await page.getByRole("heading", { level: 1, name: "Issues" }).click();
  await expect(box).toBeVisible();
  await page.reload();
  await expect(box).toHaveValue("N+1");
  expect(await overflow(page)).toEqual({ page: 0, pageY: 0, main: 0 });

  const filter = page.getByRole("button", { name: "絞り込み条件を開く", exact: true });
  await expect(page.getByRole("group", { name: "Status", exact: true })).toBeHidden();
  await expect(filter).toHaveAttribute("aria-expanded", "false");
  await filter.click();
  await expect(page.getByRole("group", { name: "Status", exact: true })).toBeVisible();
  await expect(filter).toHaveAttribute("aria-expanded", "true");
  await filter.click();
  await expect(page.getByRole("group", { name: "Status", exact: true })).toBeHidden();
  // 閉じたときはフォーカスをボタンに残す
  await expect(filter).toHaveAttribute("aria-expanded", "false");
  await expect(filter).toBeFocused();
  // Filters の行の「Filter」から開閉しても、ボタンの状態が合う
  await page.getByText("Filter", { exact: true }).click();
  await expect(filter).toHaveAttribute("aria-expanded", "true");
  await page.getByText("Filter", { exact: true }).click();
  await expect(filter).toHaveAttribute("aria-expanded", "false");
  // 条件のパネルを渡さない画面（Project 詳細）には Filter のボタンを出さない
  await page.goto("/projects/1");
  await expect(page.locator("main tbody tr[data-issue-row]")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "表示設定", exact: true })).toBeVisible();
  await expect(filter).toHaveCount(0);
});

test("ボードは列の幅 340 と間隔 8 で、あふれた分は Board の中で横にスクロールし、列見出しは全列同じ高さ", async ({ page }) => {
  await page.goto("/issues?layout=board");
  await expect(page.locator("main article")).toHaveCount(10);
  const m = await page.evaluate(() => {
    const main = document.querySelector("main") as HTMLElement;
    const box = (el: Element) => el.getBoundingClientRect();
    const css = (el: Element) => getComputedStyle(el);
    const columns = [...main.querySelectorAll("section[aria-label]")].filter((section) => section.querySelector(":scope > header"));
    const board = columns[0]?.parentElement as HTMLElement;
    const card = main.querySelector("article") as HTMLElement;
    const cards = [...(columns.find((column) => column.querySelectorAll("article").length > 1) as HTMLElement).querySelectorAll("article")];
    const head = columns[0]?.querySelector("header") as HTMLElement;
    const name = head.querySelector("h2") as HTMLElement;
    const description = head.querySelector("p") as HTMLElement;
    const title = card.querySelector('a[href^="/issues/"]') as HTMLElement;
    const meta = card.firstElementChild?.firstElementChild as HTMLElement;
    const id = meta.children[1] as HTMLElement;
    const avatar = meta.lastElementChild as HTMLElement;
    const chip = main.querySelector("article > div:last-child > span") as HTMLElement;
    return {
      columns: columns.length,
      widths: [...new Set(columns.map((column) => box(column).width))],
      gaps: [...new Set(columns.slice(1).map((column, i) => box(column).x - box(columns[i] as Element).right))],
      column: { background: css(columns[0] as Element).backgroundColor, radius: css(columns[0] as Element).borderTopLeftRadius, padding: css(columns[0] as Element).padding },
      headHeights: [...new Set(columns.map((column) => box(column.querySelector("header") as Element).height))],
      titleRows: [...new Set(columns.map((column) => box(column.querySelector("header > div") as Element).height))],
      descriptions: [...new Set(columns.map((column) => box(column.querySelector("header > p") as Element).height))],
      firstCardTops: [...new Set(columns.map((column) => Math.round(box(column.querySelector("article") as Element).y - box(column).y)))],
      name: `${css(name).fontSize} ${css(name).fontWeight}`,
      description: `${css(description).fontSize} ${css(description).whiteSpace}`,
      card: { width: box(card).width, padding: css(card).padding, radius: css(card).borderTopLeftRadius, gap: box(cards[1] as Element).y - box(cards[0] as Element).bottom },
      id: `${css(id).fontSize} ${css(id).fontFamily.includes("Mono")}`,
      title: `${css(title).fontSize} ${css(title).fontWeight} ${css(title).lineHeight}`,
      avatar: { size: `${box(avatar).width}x${box(avatar).height}`, right: Math.round(box(card).right - box(avatar).right), top: Math.round(box(avatar).y - box(card).y) },
      chip: `${box(chip).height} ${css(chip).borderTopLeftRadius}`,
      boardScroll: board.scrollWidth - board.clientWidth,
      boardInsideMain: box(board).right <= box(main).right,
      bodyPadding: css(board.parentElement as Element).padding,
    };
  });
  console.log(`[issues-layout] board ${JSON.stringify(m)}`);
  expect(m.columns).toBe(6);
  expect(m.widths).toEqual([340]);
  expect(m.gaps).toEqual([8]);
  expect(m.column).toEqual({ background: "rgb(245, 246, 248)", radius: "8px", padding: "0px 8px 8px" });
  expect(m.headHeights).toEqual([68]);
  expect(m.titleRows).toEqual([46]);
  expect(m.descriptions).toEqual([18]);
  // カードの開始位置は全列で同じ（見出し 68 と間隔 8）
  expect(m.firstCardTops).toEqual([76]);
  expect(m.name).toBe("13px 500");
  expect(m.description).toBe("12px nowrap");
  expect(m.card).toEqual({ width: 324, padding: "12px", radius: "8px", gap: 8 });
  expect(m.id).toBe("12px true");
  expect(m.title).toBe("13px 500 16px");
  // 担当は 18 の円で、カードの右上（枠線 1 と余白 12 の内側）
  expect(m.avatar).toEqual({ size: "18x18", right: 13, top: 13 });
  expect(m.chip).toBe(`24 ${PILL}`);
  // 6列（2080 と間隔）は Main（幅 1188）に収まらないので、Board の中だけで横にスクロールする
  expect(m.boardScroll).toBeGreaterThan(0);
  expect(m.boardInsideMain).toBe(true);
  expect(m.bodyPadding).toBe("8px");
  expect(await overflow(page)).toEqual({ page: 0, pageY: 0, main: 0 });
  // 右端の列まで Board の中のスクロールで届く
  const done = page.getByRole("region", { name: "Done", exact: true });
  await done.scrollIntoViewIfNeeded();
  await expect(done).toBeInViewport({ ratio: 1 });
  expect(await overflow(page)).toEqual({ page: 0, pageY: 0, main: 0 });
  // 列見出しの題名の行の中で、アイコン、題名、件数の中心が揃う
  expect(await rowMisalignment(page, "main section > header > div", ":scope > *")).toBeLessThanOrEqual(2.5);
  expect(await rowMisalignment(page, "main article > div:first-child > div:first-child", ":scope > *")).toBeLessThanOrEqual(2.5);
});

test("Issue が 0 件の列は Hidden columns（幅 338、行の高さ 38、間隔 10）にまとまる", async ({ page }) => {
  await page.goto("/issues?layout=board&workspace=NOD");
  const hidden = page.getByRole("region", { name: "Hidden columns", exact: true });
  await expect(hidden.getByRole("listitem").first()).toBeVisible();
  const m = await page.evaluate(() => {
    const section = document.querySelector('section[aria-label="Hidden columns"]') as HTMLElement;
    const box = (el: Element) => el.getBoundingClientRect();
    const css = (el: Element) => getComputedStyle(el);
    const rows = [...section.querySelectorAll("li")];
    const toggle = section.querySelector("button") as HTMLElement;
    const columns = [...document.querySelectorAll("main section[aria-label]")].filter((el) => el.querySelector(":scope > header"));
    const last = columns[columns.length - 1] as HTMLElement;
    const titleRow = last.querySelector("header > div") as HTMLElement;
    return {
      width: box(section).width,
      left: box(section).x - box(last).right,
      rows: rows.length,
      rowHeights: [...new Set(rows.map((row) => box(row).height))],
      rowGaps: [...new Set(rows.slice(1).map((row, i) => box(row).y - box(rows[i] as Element).bottom))],
      row: { radius: css(rows[0] as Element).borderTopLeftRadius, padding: css(rows[0] as Element).padding, font: `${css(rows[0]?.children[1] as Element).fontSize} ${css(rows[0]?.children[1] as Element).fontWeight}` },
      toggle: `${box(toggle).height} ${css(toggle).borderTopLeftRadius} ${css(toggle).fontSize} ${css(toggle).fontWeight}`,
      toggleCenter: Math.abs(box(toggle).y + box(toggle).height / 2 - (box(titleRow).y + box(titleRow).height / 2)),
      columns: columns.length,
    };
  });
  console.log(`[issues-layout] hidden columns ${JSON.stringify(m)}`);
  expect(m.columns + m.rows).toBe(6);
  expect(m.rows).toBeGreaterThan(1);
  expect(m.width).toBe(338);
  expect(m.left).toBe(8);
  expect(m.rowHeights).toEqual([38]);
  expect(m.rowGaps).toEqual([10]);
  expect(m.row).toEqual({ radius: "8px", padding: "0px 12px", font: "13px 500" });
  expect(m.toggle).toBe(`24 ${PILL} 12px 500`);
  // トグルは、隣の列見出しの題名の行と中心が揃う
  expect(m.toggleCenter).toBeLessThanOrEqual(2.5);
  expect(await rowMisalignment(page, 'section[aria-label="Hidden columns"] li', ":scope > *")).toBeLessThanOrEqual(2.5);
  expect(await overflow(page)).toEqual({ page: 0, pageY: 0, main: 0 });
});

// API の Workspace に Issue を n 件足す（すべて同じ Status の列に入る）
async function addIssues(nod: NodData, n: number, extra: { projectRef?: string; cycleRef?: string } = {}): Promise<string[]> {
  const [api] = (await nod.me.listWorkspaces()).filter((w) => w.key === "API");
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    const issue = await nod.me.createIssue({ workspaceId: api!.id, title: `縦に積む Issue ${String(i).padStart(2, "0")}` });
    if (extra.projectRef || extra.cycleRef) await nod.me.updateIssue(issue.id, extra);
    ids.push(issue.id);
  }
  return ids;
}

// Board と、カードがいちばん多い列の寸法
const boardHeights = (page: Page) =>
  page.evaluate(() => {
    const main = document.querySelector("main") as HTMLElement;
    const box = (el: Element) => el.getBoundingClientRect();
    const columns = [...main.querySelectorAll("section[aria-label]")].filter((section) => section.querySelector(":scope > header")) as HTMLElement[];
    const tall = columns.reduce((a, b) => (b.querySelectorAll("article").length > a.querySelectorAll("article").length ? b : a));
    const short = columns.reduce((a, b) => (b.querySelectorAll("article").length < a.querySelectorAll("article").length ? b : a));
    const board = tall.parentElement as HTMLElement;
    const cards = [...tall.querySelectorAll("article")];
    const last = cards[cards.length - 1] as HTMLElement;
    // Main の中で縦にスクロールできる入れ物（Main 自身を含む）
    const scrollers = [main, ...main.querySelectorAll("*")].filter((el) => {
      const overflowY = getComputedStyle(el).overflowY;
      return (overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight;
    });
    return {
      cards: cards.length,
      board: Math.round(box(board).height),
      boardScrollY: board.scrollHeight - board.clientHeight,
      column: Math.round(box(tall).height),
      shortColumn: Math.round(box(short).height),
      // 列の箱の下端から最後のカードの下端まで（列の下の余白 8）。負ならカードが列の外に出ている
      belowLastCard: Math.round(box(tall).bottom - box(last).bottom),
      outside: cards.filter((card) => box(card).bottom > box(tall).bottom).length,
      mainScrollY: main.scrollHeight - main.clientHeight,
      scrollers: scrollers.map((el) => (el === main ? "main" : el === board ? "board" : el.tagName.toLowerCase())),
      overflowX: { page: document.documentElement.scrollWidth - window.innerWidth, pageY: document.documentElement.scrollHeight - window.innerHeight, main: main.scrollWidth - main.clientWidth },
    };
  });

test("グループのない Board で1列に 15 枚を超えるカードがあっても、カードは列の背景の中に収まり、Board の中で縦にスクロールする", async ({ page, nod }) => {
  await addIssues(nod, 15);
  await page.goto("/issues?layout=board");
  await expect(page.locator("main article")).toHaveCount(25);
  const m = await boardHeights(page);
  console.log(`[issues-layout] tall column ${JSON.stringify(m)}`);
  expect(m.cards).toBeGreaterThanOrEqual(15);
  // 列の箱はカードの分まで伸び、最後のカードの下に列の余白 8 が残る
  expect(m.outside).toBe(0);
  expect(m.belowLastCard).toBe(8);
  expect(m.column).toBeGreaterThan(m.board);
  // カードの少ない列は Board の高さいっぱいのまま
  expect(m.shortColumn).toBe(m.board);
  // 縦のスクロールは Board の中だけで、Main とページは動かない
  expect(m.boardScrollY).toBeGreaterThan(0);
  expect(m.scrollers).toEqual(["board"]);
  expect(m.mainScrollY).toBe(0);
  expect(m.overflowX).toEqual({ page: 0, pageY: 0, main: 0 });
  // 最後のカードまで Board の中のスクロールで届き、列の背景の上にある
  const last = page.locator("main article").filter({ hasText: "縦に積む Issue 15" });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport({ ratio: 1 });
});

test("Project 詳細と Cycle 詳細の Board は内容の高さまで伸び、縦のスクロールは Main だけで二重にならない", async ({ page, nod }) => {
  const cycle = await cycleDetailPath(nod);
  await addIssues(nod, 15, { projectRef: "1", cycleRef: cycle.split("/").pop() });
  for (const path of ["/projects/1", cycle]) {
    await page.goto(`${path}?layout=board`);
    await expect(page.locator("main article").filter({ hasText: "縦に積む Issue 15" })).toBeVisible();
    const m = await boardHeights(page);
    console.log(`[issues-layout] ${path.replace(/\d+$/, "<id>")} board ${JSON.stringify(m)}`);
    expect(m.cards).toBeGreaterThanOrEqual(15);
    // Board は小さいスクロール枠にならず、列の高さまで伸びる
    expect(m.boardScrollY).toBe(0);
    expect(m.board).toBe(m.column);
    // カードの少ない列も同じ高さまで伸びる
    expect(m.shortColumn).toBe(m.column);
    expect(m.outside).toBe(0);
    expect(m.belowLastCard).toBe(8);
    // 縦にスクロールする入れ物は Main だけ
    expect(m.scrollers).toEqual(["main"]);
    expect(m.mainScrollY).toBeGreaterThan(0);
    expect(m.overflowX).toEqual({ page: 0, pageY: 0, main: 0 });
  }
});

test("視覚的に隠した列見出しは、ブラウザのアクセシビリティツリーで表の columnheader として残る", async ({ page }) => {
  await page.goto("/issues");
  await expect(page.locator("main tbody tr[data-issue-row]")).toHaveCount(13);
  // Playwright の getByRole は DOM から役割を計算するので、Chromium のアクセシビリティツリーそのものを読む
  const cdp = await page.context().newCDPSession(page);
  interface AXNode { nodeId: string; parentId?: string; ignored: boolean; role?: { value: string }; name?: { value: string }; childIds?: string[] }
  const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: AXNode[] };
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const role = (node: AXNode | undefined) => node?.role?.value;
  const ancestor = (node: AXNode, wanted: string) => {
    for (let at = byId.get(node.parentId ?? ""); at; at = byId.get(at.parentId ?? "")) if (role(at) === wanted) return at;
    return undefined;
  };
  const table = nodes.find((node) => role(node) === "table" && !node.ignored);
  expect(table).toBeDefined();
  const inTable = (node: AXNode) => ancestor(node, "table") === table;
  const headers = nodes.filter((node) => role(node) === "columnheader" && !node.ignored && inTable(node));
  const rows = nodes.filter((node) => role(node) === "row" && !node.ignored && inTable(node));
  const headerRow = byId.get(headers[0]?.parentId ?? "");
  const m = {
    headers: headers.map((node) => node.name?.value),
    headerParents: [...new Set(headers.map((node) => role(byId.get(node.parentId ?? ""))))],
    headerRowParent: role(byId.get(headerRow?.parentId ?? "")),
    rows: rows.length,
    // 列見出しの行のセルの数は、本体の行のセルの数と同じ（選択の列を含めて 9）
    headerRowCells: headerRow?.childIds?.map((id) => role(byId.get(id))),
    bodyRowCells: [...new Set(rows.filter((row) => row !== headerRow).map((row) => row.childIds?.length))],
  };
  console.log(`[issues-layout] accessibility tree ${JSON.stringify(m)}`);
  expect(m).toEqual({
    headers: ["優先度", "ID", "Status", "Title", "Project", "Workspace", "担当", "更新日時"],
    headerParents: ["row"],
    headerRowParent: "rowgroup",
    rows: 14,
    headerRowCells: ["cell", ...Array.from({ length: 8 }, () => "columnheader")],
    bodyRowCells: [9],
  });
  // 画面では列見出しを隠したまま
  expect((await page.locator("main thead").boundingBox())?.height ?? 0).toBeLessThanOrEqual(1);
  await expect(page.getByRole("table")).toMatchAriaSnapshot(`
    - table:
      - rowgroup:
        - row "優先度 ID Status Title Project Workspace 担当 更新日時":
          - cell
          - columnheader "優先度"
          - columnheader "ID"
          - columnheader "Status"
          - columnheader "Title"
          - columnheader "Project"
          - columnheader "Workspace"
          - columnheader "担当"
          - columnheader "更新日時"
      - rowgroup
  `);
});

test("コンボボックスは今の値を説明として伝え、Enter の押しっぱなしや、選択中の項目が無効なときの Enter で値を変えない", async ({ page }) => {
  await page.goto("/issues");
  await expect(page.locator("main tbody tr[data-issue-row]")).toHaveCount(13);
  const grouping = await displaySelect(page, "グループ化");
  // 名前は「グループ化」のまま、今の値は説明（aria-describedby）で読まれる
  await expect(grouping).toHaveAccessibleName("グループ化");
  await expect(grouping).toHaveAccessibleDescription("なし");
  const direction = page.getByRole("button", { name: "並び順の方向", exact: true });
  await expect(direction).toHaveAccessibleDescription("昇順");
  const menu = page.getByRole("menu", { name: "グループ化", exact: true });
  // Enter を押したまま（キーリピート）でも、開いた直後の項目を選ばず、開閉も繰り返さない
  await grouping.focus();
  await page.keyboard.down("Enter");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitemradio", { name: "なし", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitemradio", { name: "Workspace", exact: true })).toBeFocused();
  for (let i = 0; i < 3; i++) await page.keyboard.down("Enter"); // 押したままの Enter は repeat になる
  await expect(menu).toBeVisible();
  await expect(page).not.toHaveURL(/groupBy=/);
  await page.keyboard.up("Enter");
  // 離してから押し直した Enter で選ぶ。押したままにしても、閉じたコンボボックスは開き直さない
  await page.keyboard.down("Enter");
  await expect(menu).toHaveCount(0);
  await expect(page).toHaveURL(/groupBy=workspace/);
  await expect(grouping).toBeFocused();
  for (let i = 0; i < 3; i++) await page.keyboard.down("Enter");
  await page.keyboard.up("Enter");
  await expect(menu).toHaveCount(0);
  await expect(grouping).toHaveAccessibleDescription("Workspace");
  await expect(page).toHaveURL(/groupBy=workspace/);

  // Board で URL に groupBy=status があるとき、選択中の「Status」は無効。開いてもフォーカスはコンボボックスに残り、続けて Enter を押しても「なし」は選ばれない
  await page.goto("/issues?layout=board&groupBy=status");
  await expect(page.locator("main article")).toHaveCount(10);
  const onBoard = await displaySelect(page, "グループ化");
  await expect(onBoard).toHaveAccessibleDescription("Status");
  await onBoard.focus();
  await page.keyboard.press("Enter");
  await expect(menu.getByRole("menuitemradio", { name: "Status", exact: true })).toBeDisabled();
  await expect(onBoard).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(page).toHaveURL(/groupBy=status/);
  await expect(onBoard).toHaveAttribute("data-value", "status");
  // 上下キーでメニューへ入れば選べる。ボタンにフォーカスがあるときの Escape はメニューだけを閉じる
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "表示設定", exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitemradio", { name: "なし", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).not.toHaveURL(/groupBy=/);
});

test("Display のボタンにフォーカスがあるときの Escape はポップオーバーだけを閉じ、一括編集の選択とプレビューを残す", async ({ page }) => {
  await page.goto("/issues?preview=API-12");
  await expect(page.locator("main tbody tr[data-issue-row]")).toHaveCount(13);
  const pane = page.getByRole("complementary", { name: "API-12 のプレビュー", exact: true });
  await expect(pane).toBeVisible();
  await page.getByRole("checkbox", { name: "API-8 を選択", exact: true }).check();
  const bar = page.getByRole("toolbar", { name: "一括操作" });
  await expect(bar).toContainText("1 件選択");
  const popover = await openDisplay(page);
  const trigger = page.getByRole("button", { name: "表示設定", exact: true });
  // ポップオーバーの先頭（List のタブ）から Shift+Tab で Display のボタンへ戻る
  await expect(popover.getByRole("tab", { name: "List", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(trigger).toBeFocused();
  await expect(popover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(bar).toContainText("1 件選択");
  await expect(pane).toBeVisible();
});

test("一括編集のメニューで、長い Project 名は枠からはみ出さず、省略記号で切れて title で読める", async ({ page, nod }) => {
  const name = "とても長い名前の Project：検索と決済と通知にかかわる作業を四半期の終わりまでにまとめて片づける";
  await nod.me.createProject({ name });
  await page.goto("/issues");
  await expect(page.locator("main tbody tr[data-issue-row]")).toHaveCount(13);
  await page.getByRole("checkbox", { name: "API-8 を選択", exact: true }).check();
  await page.getByRole("toolbar", { name: "一括操作" }).getByRole("button", { name: "Project" }).click();
  const menu = page.getByRole("menu", { name: "Project を変更" });
  const item = menu.getByRole("menuitem", { name });
  await expect(item).toBeVisible();
  await expect(item.locator("span")).toHaveAttribute("title", name);
  const m = await item.evaluate((el) => {
    const box = (node: Element) => node.getBoundingClientRect();
    const popover = el.closest('[role="menu"]')?.parentElement as HTMLElement;
    const text = el.querySelector("span") as HTMLElement;
    return {
      popover: box(popover).width,
      popoverOverflow: popover.scrollWidth - popover.clientWidth,
      item: `${Math.round(box(el).width)}x${box(el).height}`,
      itemInside: box(el).right <= box(popover).right,
      textClipped: text.scrollWidth > text.clientWidth,
      textOverflow: getComputedStyle(text).textOverflow,
    };
  });
  console.log(`[issues-layout] bulk menu long name ${JSON.stringify(m)}`);
  expect(m).toEqual({ popover: 240, popoverOverflow: 0, item: "226x32", itemInside: true, textClipped: true, textOverflow: "ellipsis" });
  expect(await overflow(page)).toEqual({ page: 0, pageY: 0, main: 0 });
});

test("My issues、View、Project 詳細、Cycle 詳細も同じ型で、List と Board のどちらでも横スクロールが出ない", async ({ page, nod }) => {
  await nod.me.updateIssue("API-4", { assignee: "me" });
  await nod.me.updateIssue("NOD-5", { assignee: "me" });
  const cycle = await cycleDetailPath(nod);
  for (const path of ["/my-issues", "/views/1", "/projects/1", cycle]) {
    await page.goto(path);
    const rows = page.locator("main tbody tr[data-issue-row]");
    await expect(rows.first()).toBeVisible();
    const list = await page.evaluate(() => {
      const main = document.querySelector("main") as HTMLElement;
      const box = (el: Element) => el.getBoundingClientRect();
      const bar = (main.querySelector('[role="tablist"][aria-label="絞り込み"]') as HTMLElement).parentElement as HTMLElement;
      return {
        header: box(main.querySelector("header") as Element).height,
        viewBar: box(bar).height,
        rowHeights: [...new Set([...main.querySelectorAll("tbody tr[data-issue-row]")].map((row) => box(row).height))],
        groupHeadings: [...new Set([...main.querySelectorAll("h2")].filter((h) => h.closest("section")?.querySelector("table")).map((h) => box(h).height))],
        selects: main.querySelectorAll('[role="tablist"][aria-label="絞り込み"] ~ * select').length,
      };
    });
    const listOverflow = await overflow(page);
    await page.goto(`${path}?layout=board`);
    await expect(page.locator("main article").first()).toBeVisible();
    const board = await page.evaluate(() => {
      const main = document.querySelector("main") as HTMLElement;
      const box = (el: Element) => el.getBoundingClientRect();
      const columns = [...main.querySelectorAll("section[aria-label]")].filter((section) => section.querySelector(":scope > header"));
      return {
        widths: [...new Set(columns.map((column) => box(column).width))],
        headHeights: [...new Set(columns.map((column) => box(column.querySelector("header") as Element).height))],
      };
    });
    const boardOverflow = await overflow(page);
    console.log(`[issues-layout] ${path.replace(/\d+$/, "<id>")} ${JSON.stringify({ list, listOverflow, board, boardOverflow })}`);
    expect(list.header).toBe(44);
    expect(list.viewBar).toBe(43);
    expect(list.rowHeights).toEqual([44]);
    // My issues の担当タブは Status でまとめるのが既定
    if (path === "/my-issues") expect(list.groupHeadings).toEqual([36]);
    expect(list.selects).toBe(0);
    expect(board.widths).toEqual([340]);
    expect(board.headHeights).toEqual([68]);
    // ページ全体は縦にも横にも動かず、Main にも横スクロールが出ない
    expect({ page: listOverflow.page, pageY: listOverflow.pageY, main: listOverflow.main }).toEqual({ page: 0, pageY: 0, main: 0 });
    expect({ page: boardOverflow.page, pageY: boardOverflow.pageY, main: boardOverflow.main }).toEqual({ page: 0, pageY: 0, main: 0 });
  }
});

test("グループ化した Board も列の幅 340 のまま、グループごとに Board の中で横にスクロールする", async ({ page }) => {
  await page.goto("/issues?layout=board");
  await expect(page.locator("main article")).toHaveCount(10);
  await chooseDisplay(page, "グループ化", "Workspace");
  const group = page.getByRole("region", { name: "Workspace API", exact: true });
  await expect(group).toBeVisible();
  const m = await group.evaluate((section) => {
    const box = (el: Element) => el.getBoundingClientRect();
    const columns = [...section.querySelectorAll("section[aria-label]")].filter((el) => el.querySelector(":scope > header"));
    const heading = section.querySelector("h2") as HTMLElement;
    return {
      heading: box(heading).height,
      widths: [...new Set(columns.map((column) => box(column).width))],
      headHeights: [...new Set(columns.map((column) => box(column.querySelector("header") as Element).height))],
    };
  });
  console.log(`[issues-layout] grouped board ${JSON.stringify(m)}`);
  expect(m).toEqual({ heading: 36, widths: [340], headHeights: [68] });
  expect(await overflow(page)).toEqual({ page: 0, pageY: 0, main: 0 });
});
