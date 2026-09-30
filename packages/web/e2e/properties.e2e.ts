import { expect, test } from "./fixtures";
import { chooseProperty, property, propertyMenu, region } from "./helpers";
import { ISSUE, PROJECT_NAME } from "./issue-detail-data";

test.use({ dataset: "issue-detail" });

test("プロパティを変えると保存され、再読み込みしても残る", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.properties}`);
  const props = region(page, "プロパティ");
  const status = property(props, "Status");
  await expect(status).toHaveAttribute("data-value", "backlog");
  await expect(status).toHaveText("Backlog");
  await status.click();
  await expect(propertyMenu(props, "Status").getByRole("menuitemradio", { name: "Backlog", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(propertyMenu(props, "Status").getByRole("menuitemradio", { name: "Needs Clarification" })).toHaveCount(0);

  await propertyMenu(props, "Status").getByRole("menuitemradio", { name: "Todo", exact: true }).click();
  await expect(propertyMenu(props, "Status")).toHaveCount(0);
  await expect(page.getByRole("group", { name: "状態" })).toContainText("Todo");
  await chooseProperty(props, "Priority", "Urgent");
  await chooseProperty(props, "Project", PROJECT_NAME);
  await expect(page.getByRole("navigation", { name: "パンくず" }).getByRole("link", { name: PROJECT_NAME })).toBeVisible();
  await chooseProperty(props, "Assignee", "codex");

  await props.getByRole("button", { name: "ラベルを追加", exact: true }).click();
  await props.getByRole("textbox", { name: "ラベルを追加" }).fill("api, docs");
  await props.getByRole("button", { name: "追加", exact: true }).click();
  await expect(props.getByRole("button", { name: "ラベル api を外す" })).toBeVisible();
  await expect(props.getByRole("textbox", { name: "ラベルを追加" })).toHaveValue("");
  await props.getByRole("button", { name: "ラベル api を外す" }).click();
  await expect(props.getByRole("button", { name: "ラベル api を外す" })).toHaveCount(0);

  await page.reload();
  const after = region(page, "プロパティ");
  await expect(property(after, "Status")).toHaveAttribute("data-value", "todo");
  await expect(property(after, "Priority")).toHaveAttribute("data-value", "1");
  await expect(property(after, "Priority")).toHaveText("Urgent");
  await expect(property(after, "Project")).toHaveAttribute("data-value", "1");
  await expect(property(after, "Project")).toHaveText(PROJECT_NAME);
  await expect(property(after, "Assignee")).toHaveAttribute("data-value", "codex");
  await expect(after.getByRole("button", { name: "ラベル docs を外す" })).toBeVisible();
});

test("Needs Clarification の Issue は、今の値として表示するが選べない", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.clarify}`);
  const props = region(page, "プロパティ");
  const status = property(props, "Status");
  await expect(status).toHaveAttribute("data-value", "needs_clarification");
  await expect(status).toHaveText("Needs Clarification");
  await status.click();
  await expect(propertyMenu(props, "Status").getByRole("menuitemradio", { name: "Needs Clarification" })).toBeDisabled();
});

for (const width of [1280, 1440]) {
  test(`幅 ${width}px で Labels の追加ボタンを1行で表示する`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    await page.goto(`/issues/${ISSUE.properties}`);
    const props = region(page, "プロパティ");
    // 追加ボタン（24 の円形）を押すと、入力欄と「追加」が直下に開く
    const add = props.getByRole("button", { name: "ラベルを追加", exact: true });
    expect(await add.evaluate((element) => { const r = element.getBoundingClientRect(); return [r.width, r.height]; })).toEqual([24, 24]);
    await add.click();
    const button = props.getByRole("button", { name: "追加", exact: true });
    await expect(button).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const layout = await button.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const lines = Array.from(range.getClientRects()).filter((rect) => rect.width > 0);
      const form = element.parentElement!;
      return {
        lines: new Set(lines.map((rect) => Math.round(rect.top))).size,
        overflow: form.scrollWidth - form.clientWidth,
      };
    });
    expect(layout).toEqual({ lines: 1, overflow: 0 });
    await props.getByRole("textbox", { name: "ラベルを追加" }).fill("表示確認");
    await button.click();
    await expect(props.getByRole("button", { name: "ラベル 表示確認 を外す" })).toBeVisible();
  });
}

test("メニューは検索で絞り込め、上下キーで選べ、Escape で閉じてピルへ戻る", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.properties}`);
  const props = region(page, "プロパティ");
  const status = property(props, "Status");
  await status.click();
  await expect(status).toHaveAttribute("aria-expanded", "true");
  const search = props.getByRole("textbox", { name: "Status を検索" });
  await expect(search).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(propertyMenu(props, "Status")).toHaveCount(0);
  await expect(status).toBeFocused();

  // キーボードだけで開き、上下キーで項目へ移って Enter で選ぶ。選んだあとはピルへ戻る
  await page.keyboard.press("Enter");
  await expect(search).toBeFocused();
  const items = propertyMenu(props, "Status").getByRole("menuitemradio");
  await page.keyboard.press("ArrowDown");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(propertyMenu(props, "Status").getByRole("menuitemradio", { name: "Todo", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(status).toHaveAttribute("data-value", "todo");
  await expect(status).toBeFocused();

  // 検索欄で絞り込み、Enter で先頭の項目を選ぶ
  const priority = property(props, "Priority");
  await priority.click();
  await props.getByRole("textbox", { name: "Priority を検索" }).fill("ur");
  await expect(propertyMenu(props, "Priority").getByRole("menuitemradio")).toHaveText(["Urgent"]);
  await props.getByRole("textbox", { name: "Priority を検索" }).fill("該当しない");
  await expect(propertyMenu(props, "Priority")).toHaveCount(0);
  await expect(props.getByText("該当する項目はありません")).toBeVisible();
  await props.getByRole("textbox", { name: "Priority を検索" }).fill("ur");
  await page.keyboard.press("Enter");
  await expect(priority).toHaveAttribute("data-value", "1");

  // 外側を押すと閉じる
  await priority.click();
  await expect(propertyMenu(props, "Priority")).toBeVisible();
  await page.getByRole("heading", { level: 1 }).click();
  await expect(propertyMenu(props, "Priority")).toHaveCount(0);
});

// nod.pen「コントロールの型」（PR46C）と「Property Menu」（J0qDy）の値。1440×960 で測る
test("プロパティの行は高さ 28 で中心が揃い、長い Project 名でも横にはみ出さない", async ({ page, nod }) => {
  const long = "[目的] インフラ、CI、デプロイ、監視、アラートの整備をまとめて進めるとても長い名前の Project";
  const project = await nod.me.createProject({ name: long });
  await nod.me.updateIssue(ISSUE.main, { projectRef: String(project.id) });
  await page.goto(`/issues/${ISSUE.main}`);
  const props = region(page, "プロパティ");
  await expect(property(props, "Project")).toHaveText(long);
  await page.evaluate(() => document.fonts.ready);

  const measure = () => page.evaluate(() => {
    const main = document.querySelector("main")!;
    const panel = document.querySelector('section[aria-label="プロパティ"]')!;
    const center = (rect: DOMRect) => rect.top + rect.height / 2;
    const rows = [...panel.querySelectorAll("dl > div")].map((row) => {
      const key = row.querySelector("dt")!;
      const value = row.querySelector("dd")!;
      // 値の先頭の要素：ピル、変えられない値、Labels は先頭のチップ
      const pill = value.querySelector('[data-label], [class*="_propButton_"], [class*="_propStatic_"]')!;
      const icon = pill.querySelector("svg");
      const walker = document.createTreeWalker(pill, NodeFilter.SHOW_TEXT);
      let text = walker.nextNode();
      while (text && text.textContent!.trim() === "") text = walker.nextNode();
      // 文字は1行目の箱で比べる（値が複数行でも、ラベルとアイコンは1行目に揃える）
      const firstLine = (node: Node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getClientRects()[0]!;
      };
      const centers = [center(firstLine(key))];
      if (pill.getBoundingClientRect().height <= 28) centers.push(center(pill.getBoundingClientRect()));
      if (icon) centers.push(center(icon.getBoundingClientRect()));
      if (text) centers.push(center(firstLine(text)));
      return {
        label: key.textContent,
        height: row.getBoundingClientRect().height,
        pillHeight: pill.getBoundingClientRect().height,
        spread: Math.max(...centers) - Math.min(...centers),
        overflow: Math.max(0, pill.getBoundingClientRect().right - value.getBoundingClientRect().right),
      };
    });
    const tops = [...panel.querySelectorAll("dl > div")].map((row) => row.getBoundingClientRect());
    const pill = panel.querySelector('button[aria-label="Status"]')!;
    const style = getComputedStyle(pill);
    return {
      rows,
      gaps: [...new Set(tops.slice(1).map((rect, i) => rect.top - tops[i]!.bottom))],
      keyWidth: panel.querySelector("dt")!.getBoundingClientRect().width,
      pill: [style.paddingLeft, style.paddingRight, style.borderTopLeftRadius, style.fontSize, style.fontWeight],
      icon: pill.querySelector("svg")!.getBoundingClientRect().width,
      mainOverflow: main.scrollWidth - main.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  const layout = await measure();
  // 値が1行の行はすべて高さ 28。Labels（折り返す）、実行場所（worktree と「Orca で開く」の段）、PR（状態の段）は複数行になる
  const multiline = new Set(["Labels", "実行場所", "PR"]);
  const single = layout.rows.filter((row) => !multiline.has(row.label ?? ""));
  expect(single.map((row) => row.label)).toEqual(["Status", "Priority", "Estimate", "Due date", "Workspace", "Project", "Milestone", "Cycle", "Assignee", "作業状況", "Reminder", "Created"]);
  for (const row of single) expect(row, row.label ?? "").toMatchObject({ height: 28, pillHeight: 28, overflow: 0 });
  for (const row of layout.rows) expect(row.spread, `${row.label} の中心の差`).toBeLessThanOrEqual(2.5);
  expect(layout).toMatchObject({ gaps: [4], keyWidth: 88, pill: ["6px", "10px", "9999px", "13px", "500"], icon: 14, mainOverflow: 0, pageOverflow: 0 });

  // 長い値は値の列の幅で切り、末尾を「…」にする
  const clip = await property(props, "Project").evaluate((pill) => {
    const text = pill.querySelector("span:last-child")!;
    return { clipped: text.scrollWidth > text.clientWidth, overflow: getComputedStyle(text).textOverflow };
  });
  expect(clip).toEqual({ clipped: true, overflow: "ellipsis" });

  // メニューは幅 208、角丸 12、検索欄 36、項目 32。開いても横にはみ出さない
  await property(props, "Project").click();
  const menu = await propertyMenu(props, "Project").evaluate((list) => {
    const main = document.querySelector("main")!;
    const popover = list.parentElement!;
    const item = list.querySelector("[role=menuitemradio]")!;
    return {
      width: popover.getBoundingClientRect().width,
      radius: getComputedStyle(popover).borderTopLeftRadius,
      search: popover.querySelector("input")!.getBoundingClientRect().height,
      item: item.getBoundingClientRect().height,
      itemRadius: getComputedStyle(item).borderTopLeftRadius,
      mainOverflow: main.scrollWidth - main.clientWidth,
    };
  });
  expect(menu).toEqual({ width: 208, radius: "12px", search: 36, item: 32, itemRadius: "8px", mainOverflow: 0 });
  console.log("プロパティ欄の実測", JSON.stringify({ ...layout, menu }));
});
