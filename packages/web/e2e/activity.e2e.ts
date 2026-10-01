import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures";
import { region } from "./helpers";
import { ISSUE, MAIN_COMMENT } from "./issue-detail-data";

test.use({ dataset: "issue-detail" });

test("コメントを書くと Activity に書き手つきで出る。空白だけのコメントは送れない", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.comment}`);
  const activity = region(page, "Activity");
  const box = activity.getByRole("textbox", { name: "コメント" });
  const submit = activity.getByRole("button", { name: "コメントする" });
  await expect(submit).toBeDisabled();
  await box.fill("   ");
  await expect(submit).toBeDisabled();
  await box.fill("計測の結果を共有した");
  await submit.click();
  await expect(activity.getByRole("article", { name: "コメント記録" }).filter({ hasText: "計測の結果を共有した" })).toContainText("me");
  // 返信のないカードには最終返信の時刻を出さない
  await expect(activity.getByRole("article", { name: "コメント記録" }).filter({ hasText: "計測の結果を共有した" })).not.toContainText("最終返信");
  await expect(box).toHaveValue("");
});

test("コメントの本文は Markdown で描き、改行1つは改行のまま出す", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.comment}`);
  const activity = region(page, "Activity");
  await activity.getByRole("textbox", { name: "コメント" }).fill("### 見出しの行\n**太字** と `code`\n2行目\n\n- 箇条書き\n- [記事](https://example.com)");
  await activity.getByRole("button", { name: "コメントする" }).click();
  const thread = activity.getByRole("article", { name: "コメント記録" }).filter({ hasText: "見出しの行" });
  await expect(thread.getByRole("heading", { name: "見出しの行" })).toBeVisible();
  await expect(thread.locator("strong", { hasText: "太字" })).toBeVisible();
  await expect(thread.locator("code", { hasText: "code" })).toBeVisible();
  await expect(thread.locator("br")).toHaveCount(1);
  await expect(thread.getByRole("listitem")).toHaveCount(2);
  await expect(thread.getByRole("link", { name: "記事" })).toHaveAttribute("href", "https://example.com");
  await expect(thread).not.toContainText("**");
});

test("変更の種類ごとに書き手つきの文を出し、質問の event は重ねない", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.comment}`);
  const activity = region(page, "Activity");
  await expect(activity).toContainText("me が起票した");
  await expect(activity).toContainText("me が優先度を No priority から Urgent に変えた");
  await expect(activity).toContainText("me がラベルを変えた（+docs）");
  await expect(activity).toContainText("me が説明を変えた");

  await page.goto(`/issues/${ISSUE.main}`);
  const main = region(page, "Activity");
  await expect(main.getByRole("article", { name: "コメント記録" }).filter({ hasText: MAIN_COMMENT })).toContainText("claude-code");
  await expect(main).toContainText("me が関連 Issue を足した：blocks API-13");
  await expect(main).not.toContainText("question_asked");
  await expect(main).not.toContainText("question_answered");
});

test("コメントに返信してスレッドにし、解決済みは折りたたみ、開いて未解決に戻せる", async ({ page, nod }) => {
  const root = await nod.claude.commentIssue(ISSUE.comment, "N+1 の原因は workspace 取得だった");
  await nod.claude.commentIssue(ISSUE.comment, "LLM の返信", { replyTo: root.id });
  await page.goto(`/issues/${ISSUE.comment}`);
  const activity = region(page, "Activity");
  const thread = activity.getByRole("article", { name: "コメント記録" }).filter({ hasText: "N+1 の原因は" });
  await expect(thread.getByRole("group", { name: "返信記録" }).filter({ hasText: "LLM の返信" })).toContainText("claude-code");

  await thread.getByRole("button", { name: "返信", exact: true }).click();
  const replyBox = thread.getByRole("textbox", { name: "返信" });
  const send = thread.getByRole("button", { name: "返信する" });
  await expect(send).toBeDisabled();
  await replyBox.fill("IN 句で一括取得して");
  await send.click();
  await expect(thread.getByRole("group", { name: "返信記録" }).filter({ hasText: "IN 句で一括取得して" })).toContainText("me");
  await expect(replyBox).toBeHidden();

  await thread.getByRole("button", { name: "解決", exact: true }).click();
  const collapsed = thread.getByRole("button", { name: /解決済み/ });
  await expect(collapsed).toHaveAttribute("aria-expanded", "false");
  await expect(collapsed).toContainText("claude-code: N+1 の原因は");
  await expect(collapsed).toContainText("2件の返信");
  // 古いスレッドへの新しい返信に気づけるよう、最後の返信の時刻を出す（design/nod.pen「Issue詳細｜最終返信時刻（#97）」）
  await expect(collapsed).toContainText(/· 最終返信 \S+/);
  await expect(thread.getByText("IN 句で一括取得して")).toBeHidden();
  await expect(activity).toContainText("me がコメントのスレッドを解決済みにした");

  await collapsed.click();
  await expect(thread).toContainText("me が解決");
  await expect(thread.getByText("IN 句で一括取得して")).toBeVisible();
  // 解決済みのスレッドにも、開けば返信できる。解決ボタンは出さない（#97）
  await expect(thread.getByRole("button", { name: "解決", exact: true })).toHaveCount(0);
  await thread.getByRole("button", { name: "返信", exact: true }).click();
  await thread.getByRole("textbox", { name: "返信" }).fill("解決後の補足");
  await thread.getByRole("button", { name: "返信する" }).click();
  await expect(thread.getByRole("group", { name: "返信記録" }).filter({ hasText: "解決後の補足" })).toContainText("me");
  await expect(thread).toContainText("me が解決");
  await thread.getByRole("button", { name: "未解決に戻す" }).click();
  await expect(thread.getByRole("button", { name: "解決", exact: true })).toBeVisible();
  // 返信のある未解決カードは見出しに最終返信の時刻を出す
  await expect(thread.getByText(/最終返信/)).toBeVisible();
  await expect(activity).toContainText("me がコメントのスレッドを未解決に戻した");
  const detail = await nod.me.getIssue(ISSUE.comment);
  const saved = detail.activity.find((a) => a.kind === "comment" && a.id === root.id);
  expect(saved).toMatchObject({ resolvedAt: null, replies: [{ body: "LLM の返信" }, { body: "IN 句で一括取得して", actor: "me" }, { body: "解決後の補足", actor: "me" }] });
});

// #181：アイコン、本文の1行目、時刻の中心を揃える。Inbox の「直近の経過」も同じ部品を使う
const measureLines = (lines: Locator) => lines.evaluateAll((items) => items.map((item) => {
  const center = (rect: DOMRect) => rect.top + rect.height / 2;
  const [icon, text, time] = [...item.children] as [HTMLElement, HTMLElement, HTMLElement];
  const range = document.createRange();
  range.selectNodeContents(text);
  const first = range.getClientRects()[0]!;
  const centers = [center(icon.querySelector("svg")!.getBoundingClientRect()), center(first), center(time.getBoundingClientRect())];
  return { wrapped: text.getBoundingClientRect().height > first.height * 1.5, spread: Math.max(...centers) - Math.min(...centers) };
}));

test("Activity の行はアイコン、本文の1行目、時刻の中心が揃う", async ({ page }) => {
  await page.goto(`/issues/${ISSUE.main}`);
  const lines = region(page, "Activity").locator("ul > li");
  await expect(lines.first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const wide = await measureLines(lines);
  expect(wide.length).toBeGreaterThan(0);
  for (const line of wide) expect(line.spread).toBeLessThanOrEqual(2.5);

  // 本文が折り返す幅でも、アイコンと時刻は1行目に揃う
  await region(page, "Activity").locator("ul").first().evaluate((list) => {
    for (const item of list.ownerDocument.querySelectorAll<HTMLElement>('section[aria-label="Activity"] ul')) item.style.width = "120px";
  });
  const narrow = await measureLines(lines);
  expect(narrow.some((line) => line.wrapped)).toBe(true);
  for (const line of narrow) expect(line.spread).toBeLessThanOrEqual(2.5);
  console.log("Activity の行の中心の差", JSON.stringify({ wide: wide.map((line) => line.spread), narrow: narrow.map((line) => line.spread) }));
});

test("Inbox の直近の経過も、アイコン、本文の1行目、時刻の中心が揃う", async ({ page }) => {
  await page.goto("/inbox");
  const lines = region(page, "直近の経過").locator("ul > li");
  await expect(lines.first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const measured = await measureLines(lines);
  // 1440×960 では、確認依頼の行が2行に折り返す
  expect(measured.some((line) => line.wrapped)).toBe(true);
  expect(measured.some((line) => !line.wrapped)).toBe(true);
  for (const line of measured) expect(line.spread).toBeLessThanOrEqual(2.5);
  console.log("Inbox の直近の経過の中心の差", JSON.stringify(measured));
});
