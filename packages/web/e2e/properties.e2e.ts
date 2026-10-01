import type { Locator } from "@playwright/test";
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

// #170：未回答の確認依頼が残っていても、手で移した状態のままにする（Needs Clarification に戻さない）
test("Needs Clarification の Issue を手で Todo に移すと、未決事項を残したまま Todo になる", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.clarify}`);
  const props = region(page, "プロパティ");
  await expect(property(props, "Status")).toHaveAttribute("data-value", "needs_clarification");

  await chooseProperty(props, "Status", "Todo");
  await expect(page.getByRole("group", { name: "状態" })).toContainText("Todo");
  await expect(page.getByRole("group", { name: "状態" })).not.toContainText("Needs Clarification");
  await expect(props.getByRole("alert")).toHaveCount(0);
  await expect(region(page, "未決事項")).toContainText("0 / 2 決定");

  await page.reload();
  const after = region(page, "プロパティ");
  await expect(property(after, "Status")).toHaveAttribute("data-value", "todo");
  await property(after, "Status").click();
  await expect(propertyMenu(after, "Status").getByRole("menuitemradio", { name: "Needs Clarification" })).toHaveCount(0);
  // Activity には手動の移動が1件だけ残り、Needs Clarification へ戻す記録は増えない（1件は未決事項を足したときのもの）
  const activity = region(page, "Activity");
  await expect(activity.getByText("ステータスを Needs Clarification から Todo に変えた")).toHaveCount(1);
  await expect(activity.getByText("ステータスを Todo から Needs Clarification に変えた")).toHaveCount(1);
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

// ネイティブの select と同じく、開いてすぐの Enter では値を変えない（先頭の Triage や「なし」を選ばない）
test("メニューを開いてすぐ Enter を押しても値は変わらず、保存もしない", async ({ page }) => {
  const updates: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && /\/api\/issues\/[^/]+\/update$/.test(request.url())) updates.push(request.url());
  });
  await page.goto(`/issues/${ISSUE.main}`);
  const props = region(page, "プロパティ");
  const before = [["Status", "in_progress"], ["Priority", "2"], ["Project", "1"], ["Assignee", "claude-code"]] as const;
  for (const [name, value] of before) {
    const pill = property(props, name);
    await expect(pill).toHaveAttribute("data-value", value);
    await pill.focus();
    await page.keyboard.press("Enter");
    await expect(props.getByRole("textbox", { name: `${name} を検索` })).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    // 何も選ばないので、メニューは開いたまま
    await expect(propertyMenu(props, name)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(pill).toBeFocused();
    await expect(pill).toHaveAttribute("data-value", value);
  }
  await page.reload();
  for (const [name, value] of before) await expect(property(region(page, "プロパティ"), name)).toHaveAttribute("data-value", value);
  expect(updates).toEqual([]);
});

test("ピルは今の値を説明として伝え、開いたメニューと aria-controls で結ばれる", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.properties}`);
  const props = region(page, "プロパティ");
  const status = property(props, "Status");
  await expect(status).toHaveAccessibleName("Status");
  await expect(status).toHaveAccessibleDescription("Backlog");
  await expect(property(props, "Project")).toHaveAccessibleDescription("なし");
  // 選べないときの案内文も、値のあとに続けて伝える
  await expect(property(props, "Milestone")).toHaveAccessibleDescription("なし Project を設定すると選べます");

  await expect(status).not.toHaveAttribute("aria-controls", /.+/);
  await status.click();
  const id = await status.getAttribute("aria-controls");
  expect(id).toBeTruthy();
  await expect(page.locator(`[id="${id}"]`).getByRole("menu", { name: "Status を変更" })).toBeVisible();
  await propertyMenu(props, "Status").getByRole("menuitemradio", { name: "Todo", exact: true }).click();
  await expect(status).toHaveAccessibleDescription("Todo");
});

test("IME の変換中のキーは、メニューとラベルの入力欄の操作にならない", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.properties}`);
  const props = region(page, "プロパティ");
  // 変換中の keydown（isComposing）を送る
  const composing = (target: Locator, key: string) =>
    target.evaluate((element, k) => { element.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, isComposing: true })); }, key);

  const status = property(props, "Status");
  await status.click();
  const search = props.getByRole("textbox", { name: "Status を検索" });
  await search.fill("to");
  await expect(propertyMenu(props, "Status").getByRole("menuitemradio")).toHaveText(["Todo"]);
  for (const key of ["Escape", "ArrowDown", "ArrowUp", "Tab", "Enter"]) await composing(search, key);
  await expect(propertyMenu(props, "Status")).toBeVisible();
  await expect(search).toBeFocused();
  await expect(status).toHaveAttribute("data-value", "backlog");
  // 変換が終わったあとの Escape では閉じる
  await page.keyboard.press("Escape");
  await expect(propertyMenu(props, "Status")).toHaveCount(0);

  await props.getByRole("button", { name: "ラベルを追加", exact: true }).click();
  const label = props.getByRole("textbox", { name: "ラベルを追加" });
  await label.fill("へんかん");
  await composing(label, "Escape");
  await composing(label, "Enter");
  await expect(props.getByRole("dialog", { name: "ラベルを追加" })).toBeVisible();
  await expect(label).toHaveValue("へんかん");
  await expect(props.getByRole("button", { name: "ラベル へんかん を外す" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(props.getByRole("dialog", { name: "ラベルを追加" })).toHaveCount(0);
});

test("Tab で抜けるとメニューとラベルの入力欄は閉じ、ほかの項目の保存のあとにフォーカスを奪わない", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.properties}`);
  const props = region(page, "プロパティ");
  const status = property(props, "Status");
  await status.click();
  await expect(props.getByRole("textbox", { name: "Status を検索" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(propertyMenu(props, "Status")).toHaveCount(0);
  await expect(status).toHaveAttribute("aria-expanded", "false");

  const add = props.getByRole("button", { name: "ラベルを追加", exact: true });
  const dialog = props.getByRole("dialog", { name: "ラベルを追加" });
  const label = props.getByRole("textbox", { name: "ラベルを追加" });
  await add.focus();
  await page.keyboard.press("Enter");
  await expect(label).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog).toHaveCount(0);
  await expect(add).toHaveAttribute("aria-expanded", "false");

  // 続けてほかの項目を保存すると、フォーカスはそのピルへ戻る（ラベルの入力欄は開かない）
  const assignee = property(props, "Assignee");
  await assignee.focus();
  await page.keyboard.press("Enter");
  await props.getByRole("textbox", { name: "Assignee を検索" }).fill("codex");
  await page.keyboard.press("Enter");
  await expect(assignee).toHaveAttribute("data-value", "codex");
  await expect(assignee).toBeFocused();
  await expect(dialog).toHaveCount(0);

  // ラベルを足したあとは、続けて足せるよう入力欄へ戻る
  await add.click();
  await label.fill("api");
  await page.keyboard.press("Enter");
  await expect(props.getByRole("button", { name: "ラベル api を外す" })).toBeVisible();
  await expect(label).toHaveValue("");
  await expect(label).toBeFocused();
  // Shift+Tab で追加ボタンへ戻っても（枠の内側）閉じない
  await page.keyboard.press("Shift+Tab");
  await expect(add).toBeFocused();
  await expect(dialog).toBeVisible();
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
  // 値が1行の行はすべて高さ 28。Labels（折り返す）と PR（状態の段）は複数行になる。実行場所も1行（#194）
  const multiline = new Set(["Labels", "PR"]);
  const single = layout.rows.filter((row) => !multiline.has(row.label ?? ""));
  expect(single.map((row) => row.label)).toEqual(["Status", "Priority", "Estimate", "Due date", "Workspace", "Project", "Milestone", "Cycle", "Assignee", "作業状況", "実行場所", "Reminder", "Created"]);
  for (const row of single) expect(row, row.label ?? "").toMatchObject({ height: 28, pillHeight: 28, overflow: 0 });
  for (const row of layout.rows) expect(row.spread, `${row.label} の中心の差`).toBeLessThanOrEqual(2.5);
  expect(layout).toMatchObject({ gaps: [4], keyWidth: 88, pill: ["6px", "10px", "9999px", "13px", "500"], icon: 14, mainOverflow: 0, pageOverflow: 0 });

  // 長い値は値の列の幅で切り、末尾を「…」にする
  const clip = await property(props, "Project").evaluate((pill) => {
    const text = pill.querySelector("span:last-child")!;
    return { clipped: text.scrollWidth > text.clientWidth, overflow: getComputedStyle(text).textOverflow };
  });
  expect(clip).toEqual({ clipped: true, overflow: "ellipsis" });

  // 実行場所は「ブランチ · worktree」を1行に出し、長い worktree は値の列の幅で切って「…」にする。ブランチと worktree の全文は title。
  // 「Orca で開く」は同じ行の中の 28 の円形ボタン
  const location = await props.locator("dl > div").filter({ has: page.locator("dt", { hasText: "実行場所" }) }).evaluate((row) => {
    const pill = row.querySelector('[class*="_propStatic_"]') as HTMLElement;
    const text = pill.querySelector('[class*="_propText_"]') as HTMLElement;
    const button = row.querySelector('button[aria-label="Orca で開く"]') as HTMLElement;
    const center = (r: DOMRect) => r.top + r.height / 2;
    return {
      height: row.getBoundingClientRect().height,
      text: text.textContent,
      title: pill.title,
      clipped: text.scrollWidth > text.clientWidth,
      overflow: getComputedStyle(text).textOverflow,
      button: [button.getBoundingClientRect().width, button.getBoundingClientRect().height, getComputedStyle(button).borderTopLeftRadius],
      buttonInside: button.getBoundingClientRect().right <= row.getBoundingClientRect().right,
      buttonCenterDiff: Math.abs(center(button.getBoundingClientRect()) - center(pill.getBoundingClientRect())),
    };
  });
  expect(location.title).toMatch(/^feat-search-n1 · \/.+\/feat-search-n1$/);
  expect(location).toMatchObject({ height: 28, text: location.title, clipped: true, overflow: "ellipsis",
    button: [28, 28, "9999px"], buttonInside: true });
  expect(location.buttonCenterDiff).toBeLessThanOrEqual(2.5);

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
  console.log("プロパティ欄の実測", JSON.stringify({ ...layout, location, menu }));
});
