import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import type { NodData } from "./support/nod";

const nav = (page: Page) => page.getByRole("navigation", { name: "メイン" });
const list = (page: Page) => page.getByRole("region", { name: "未決事項の一覧" });
const detail = (page: Page) => page.getByRole("region", { name: "詳細", exact: true });
const cards = (page: Page) => detail(page).getByRole("region", { name: "未決事項", exact: true });
const items = (page: Page) => list(page).getByRole("link");
const group = (page: Page, name: string) => list(page).getByRole("group", { name });

// API: 設問（Project 調査票・me の未決事項 3 件のうち 1 件は決定済み）、期限（Project 調査票・1 件）、保管（Project なし・1 件）
//      検索（LLM の質問 1 件だけ）
// WEB: 配色（Project 配信管理・1 件）
async function seed(nod: NodData) {
  const api = (await nod.me.initWorkspace({ path: nod.repo("api-server"), key: "API", name: "api-server" })).workspace;
  const web = (await nod.me.initWorkspace({ path: nod.repo("web-app"), key: "WEB", name: "web-app" })).workspace;
  await nod.me.createProject({ name: "調査票" });
  await nod.me.createProject({ name: "配信管理" });
  const survey = await nod.me.createIssue({ workspaceId: api.id, title: "設問の必須設定を追加", projectRef: "調査票", priority: 1 });
  const due = await nod.me.createIssue({ workspaceId: api.id, title: "回答期限の設定", projectRef: "調査票", priority: 2 });
  const keep = await nod.me.createIssue({ workspaceId: api.id, title: "回答データの保管期間", priority: 3 });
  const search = await nod.me.createIssue({ workspaceId: api.id, title: "検索を速くする" });
  const color = await nod.me.createIssue({ workspaceId: web.id, title: "画面の配色", projectRef: "配信管理", priority: 3 });
  const mail = (await nod.me.askQuestion(survey.id, "回答者に確認メールを送るか")).question;
  await nod.me.answerQuestion(survey.id, "送る", { questionId: mail.id });
  const required = (await nod.me.askQuestion(survey.id, "設問 Q3 は必須にするか")).question;
  const error = (await nod.me.askQuestion(survey.id, "未回答のまま送信したときのエラー表示")).question;
  await nod.me.askQuestion(due.id, "回答期限をいつにするか");
  await nod.me.askQuestion(keep.id, "回答データを何日間保管するか");
  await nod.claude.startIssue(search.id);
  await nod.claude.askQuestion(search.id, "インデックスを足してよいか");
  await nod.me.askQuestion(color.id, "ボタンの色");
  return { survey, due, keep, search, color, required, error };
}

test("人が付けた未回答の未決事項を Project ごとに Issue 単位で並べ、LLM の質問は出さず、Inbox の件数は変えない", async ({ page, nod }) => {
  const s = await seed(nod);
  await page.goto("/inbox");
  // Inbox は LLM の質問だけ（1件）。Open questions は人が付けた未回答の質問の数（5件）を通常色で出す
  await expect(nav(page).getByRole("link", { name: /^Inbox/ })).toContainText("1");
  const link = nav(page).getByRole("link", { name: /^Open questions/ });
  await expect(link).toContainText("5");
  await link.click();
  await expect(page).toHaveURL(/\/open-questions$/);
  await expect(link).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 1, name: "Open questions" })).toBeVisible();
  await expect(list(page).getByTestId("open-question-count")).toHaveText("5");

  // Project は名前順、Project なしは最後。見出しの件数は未回答の質問の数
  await expect(list(page).getByRole("group")).toHaveCount(3);
  await expect(group(page, "調査票").getByRole("heading")).toHaveText("調査票3");
  await expect(group(page, "配信管理").getByRole("heading")).toHaveText("配信管理1");
  await expect(group(page, "Project なし").getByRole("heading")).toHaveText("Project なし1");
  await expect(items(page)).toHaveCount(4);
  await expect(items(page)).toContainText(["設問の必須設定を追加", "回答期限の設定", "画面の配色", "回答データの保管期間"]);
  await expect(list(page).getByText("検索を速くする")).toHaveCount(0);

  // 項目は最古の未回答の質問文・Workspace・ID・決定数 / 総数を出す
  const first = items(page).first();
  await expect(first).toContainText("設問 Q3 は必須にするか");
  await expect(first).toContainText(s.survey.id);
  await expect(first).toContainText("未決 1/3");
  await expect(first).toHaveAttribute("data-selected", "true");

  // 詳細は先頭の Issue。未回答の質問ごとにカード、決定済みは折りたたみ
  await expect(detail(page).getByRole("heading", { level: 2, name: "設問の必須設定を追加" })).toBeVisible();
  await expect(detail(page).getByText("1 / 3 決定")).toBeVisible();
  await expect(detail(page).getByText("Needs Clarification")).toBeVisible();
  await expect(cards(page)).toHaveCount(2);
  await expect(cards(page).first()).toContainText("me が残した未決事項");
  await expect(cards(page).first()).toContainText("設問 Q3 は必須にするか");
  await expect(cards(page).first().getByRole("button", { name: "はい、進めて" })).toHaveCount(0);
  const decided = detail(page).getByRole("button", { name: "決定済み 1 件" });
  await expect(decided).toHaveAttribute("aria-expanded", "false");
  await decided.click();
  await expect(decided).toHaveAttribute("aria-expanded", "true");
  await expect(detail(page).getByText("回答者に確認メールを送るか")).toBeVisible();
  await expect(detail(page).getByText("回答：送る")).toBeVisible();
  await expect(detail(page).getByText("回答は Issue に記録されます。すべて決まると Issue は元のステータス（Todo / Backlog）に戻ります。")).toBeVisible();
  await expect(detail(page).getByRole("link", { name: "Issue を開く" })).toHaveAttribute("href", `/issues/${s.survey.id}`);
});

test("回答を記録すると件数が進み、すべて決めると Issue が一覧から消えて次の Issue を選ぶ", async ({ page, nod }) => {
  const s = await seed(nod);
  await page.goto("/open-questions");
  await expect(cards(page)).toHaveCount(2);
  const first = cards(page).first();
  await expect(first.getByRole("button", { name: "回答を記録" })).toBeDisabled();
  await first.getByRole("textbox", { name: "回答" }).fill("必須にする");
  // もう1つのカードの下書きは、回答しても残る
  await cards(page).nth(1).getByRole("textbox", { name: "回答" }).fill("赤字で出す");
  await first.getByRole("button", { name: "回答を記録" }).click();

  await expect(cards(page)).toHaveCount(1);
  await expect(detail(page).getByText("2 / 3 決定")).toBeVisible();
  await expect(items(page).first()).toContainText("未決 2/3");
  await expect(list(page).getByTestId("open-question-count")).toHaveText("4");
  await expect(nav(page).getByRole("link", { name: /^Open questions/ })).toContainText("4");
  await expect(cards(page).first().getByRole("textbox", { name: "回答" })).toHaveValue("赤字で出す");
  let shown = await nod.me.getIssue(s.survey.id);
  expect(shown.questions.find((q) => q.id === s.required.id)).toMatchObject({ answer: "必須にする", answeredBy: "me" });
  expect(shown.status).toBe("needs_clarification");

  // ⌘ Enter でも記録できる。最後の1つを決めると Issue は元のステータスに戻り、一覧から消えて次の Issue が選ばれる
  await cards(page).first().getByRole("textbox", { name: "回答" }).press("ControlOrMeta+Enter");
  await expect(items(page)).toHaveCount(3);
  await expect(list(page).getByText("設問の必須設定を追加")).toHaveCount(0);
  await expect(detail(page).getByRole("heading", { level: 2, name: "回答期限の設定" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`selected=${s.due.id}`));
  shown = await nod.me.getIssue(s.survey.id);
  expect(shown.questions.find((q) => q.id === s.error.id)).toMatchObject({ answer: "赤字で出す", answeredBy: "me" });
  expect(shown.status).toBe("todo");
});

test("検索欄に IME で日本語を入力できる（変換中に URL の更新で入力が崩れない）", async ({ page, nod }) => {
  await seed(nod);
  await page.goto("/open-questions");
  const search = list(page).getByRole("searchbox", { name: "未決事項を絞り込む" });
  await search.focus();
  const cdp = await page.context().newCDPSession(page);
  for (const text of ["h", "ほ", "ほk", "ほか", "ほかn", "ほかん"]) {
    await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
  }
  await cdp.send("Input.insertText", { text: "保管" });
  await expect(search).toHaveValue("保管");
  await expect(items(page)).toHaveCount(1);
});

test("Workspace・Project・検索で絞り込み、グループ化を外せる。URL から復元する", async ({ page, nod }) => {
  const s = await seed(nod);
  await page.goto("/open-questions");
  await expect(items(page)).toHaveCount(4);

  await list(page).getByLabel("Workspace", { exact: true }).selectOption("WEB");
  await expect(page).toHaveURL(/workspace=WEB/);
  await expect(items(page)).toHaveCount(1);
  await expect(items(page)).toContainText(["画面の配色"]);
  await expect(list(page).getByTestId("open-question-count")).toHaveText("1");
  // Sidebar は絞り込みに左右されない全体の件数
  await expect(nav(page).getByRole("link", { name: /^Open questions/ })).toContainText("5");
  await list(page).getByLabel("Workspace", { exact: true }).selectOption("");

  await list(page).getByLabel("Project", { exact: true }).selectOption({ label: "調査票" });
  await expect(page).toHaveURL(/project=\d+/);
  await expect(items(page)).toHaveCount(2);
  await list(page).getByLabel("Project", { exact: true }).selectOption("");

  await list(page).getByRole("searchbox", { name: "未決事項を絞り込む" }).fill("保管");
  await expect(items(page)).toHaveCount(1);
  await expect(detail(page).getByRole("heading", { level: 2, name: "回答データの保管期間" })).toBeVisible();
  await list(page).getByRole("searchbox", { name: "未決事項を絞り込む" }).fill("どれにも合わない");
  await expect(list(page).getByText("条件に合う未決事項はありません")).toBeVisible();
  await expect(list(page).getByTestId("open-question-count")).toHaveText("0");
  await expect(detail(page).getByRole("heading", { level: 2 })).toHaveCount(0);
  await list(page).getByRole("searchbox", { name: "未決事項を絞り込む" }).fill("");

  await list(page).getByRole("tab", { name: "なし" }).click();
  await expect(page).toHaveURL(/group=none/);
  await expect(list(page).getByRole("group")).toHaveCount(0);
  await expect(items(page)).toContainText(["設問の必須設定を追加", "回答期限の設定", "回答データの保管期間", "画面の配色"]);

  await page.goto(`/open-questions?selected=${s.color.id}&workspace=WEB&group=none`);
  await expect(list(page).getByLabel("Workspace", { exact: true })).toHaveValue("WEB");
  await expect(list(page).getByRole("tab", { name: "なし" })).toHaveAttribute("aria-selected", "true");
  await expect(items(page)).toHaveCount(1);
  await expect(detail(page).getByRole("heading", { level: 2, name: "画面の配色" })).toBeVisible();
});

test("未回答の未決事項がなければ空状態を出し、Sidebar に件数を出さない", async ({ page, nod }) => {
  const api = (await nod.me.initWorkspace({ path: nod.repo("api-server"), key: "API", name: "api-server" })).workspace;
  const issue = await nod.me.createIssue({ workspaceId: api.id, title: "検索を速くする" });
  await nod.claude.startIssue(issue.id);
  await nod.claude.askQuestion(issue.id, "インデックスを足してよいか");

  await page.goto("/open-questions");
  await expect(list(page).getByText("未回答の未決事項はありません")).toBeVisible();
  await expect(list(page).getByTestId("open-question-count")).toHaveText("0");
  await expect(nav(page).getByRole("link", { name: /^Open questions/ })).toHaveText("Open questions");
  await expect(detail(page).getByRole("heading", { level: 2 })).toHaveCount(0);
});

test("URL の selected が一覧に無ければ先頭を選んで URL を書き換え、注記のステータスの文は needs_clarification のときだけ出す", async ({ page, nod }) => {
  const s = await seed(nod);
  // 作業中（in_progress）の Issue に人が足した未決事項。すべて決めてもステータスは変わらない
  await nod.me.askQuestion(s.search.id, "対象のテーブルはどれか");

  await page.goto("/open-questions?selected=API-999&group=none");
  await expect(detail(page).getByRole("heading", { level: 2, name: "設問の必須設定を追加" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`selected=${s.survey.id}&group=none$`));
  await expect(detail(page).getByText("すべて決まると Issue は元のステータス（Todo / Backlog）に戻ります。")).toBeVisible();

  await items(page).filter({ hasText: "検索を速くする" }).click();
  await expect(detail(page).getByText("In Progress")).toBeVisible();
  // 人が付けたものだけを出す（LLM の質問のカードは出さない）
  await expect(cards(page)).toHaveCount(1);
  await expect(detail(page).getByText("回答は Issue に記録されます。", { exact: true })).toBeVisible();
  await expect(detail(page).getByText("元のステータス")).toHaveCount(0);
});

test("絞り込みのフォーカスは枠の外に 2px の線で示し、選択中の名前と項目のタイトルを title で読める", async ({ page, nod }) => {
  await seed(nod);
  await page.goto("/open-questions");
  await expect(items(page)).toHaveCount(4);
  const outline = (el: Element) => {
    const style = getComputedStyle(el);
    return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineOffset}`;
  };

  const workspace = list(page).getByLabel("Workspace", { exact: true });
  const chip = workspace.locator("xpath=..");
  await expect(chip).toHaveAttribute("title", "All workspaces");
  await workspace.focus();
  expect(await chip.evaluate(outline)).toBe("solid 2px 1px");
  await workspace.selectOption("WEB");
  await expect(chip).toHaveAttribute("title", "web-app");

  const search = list(page).getByRole("searchbox", { name: "未決事項を絞り込む" });
  await search.focus();
  expect(await search.locator("xpath=..").evaluate(outline)).toBe("solid 2px 1px");
  await expect(items(page).first().getByText("画面の配色")).toHaveAttribute("title", "画面の配色");
});
