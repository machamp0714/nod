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
  await expect(pr).toHaveAttribute("aria-pressed", "true");
  await pr.click();
  await expect(pr).toHaveAttribute("aria-pressed", "false");
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
  await filter.click();
  await expect(page.getByRole("group", { name: "Status", exact: true })).toBeVisible();
  await filter.click();
  await expect(page.getByRole("group", { name: "Status", exact: true })).toBeHidden();
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
