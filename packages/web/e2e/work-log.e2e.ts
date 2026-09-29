import { expect, test } from "./fixtures";
import { region } from "./helpers";
import { ISSUE } from "./issue-detail-data";

test.use({ dataset: "issue-detail" });

const LONG = Array.from({ length: 10 }, (_, i) => `判断の根拠 ${i + 1} 行目`).join("\n");

test("作業ログを種類バッジつきで出し、種類ごとに絞り込み、0件なら空の状態を出す", async ({ page, nod }) => {
  await nod.claude.logWork(ISSUE.comment, "検索 API の N+1 を調べ始めた");
  await nod.claude.logWork(ISSUE.comment, "$ bun test\n12 pass\n0 fail", { kind: "test" });
  await nod.claude.logWork(ISSUE.comment, "staging の読み取り権限がない", { kind: "blocker" });
  await nod.me.commentIssue(ISSUE.comment, "ふつうのコメント");
  await page.goto(`/issues/${ISSUE.comment}`);
  const activity = region(page, "Activity");
  const logs = activity.getByRole("article", { name: "作業ログ" });
  const chips = activity.getByRole("group", { name: "作業ログの種類" });

  await expect(chips.getByRole("button", { name: "すべて" })).toHaveAttribute("aria-pressed", "true");
  await expect(logs.filter({ hasText: "N+1 を調べ始めた" })).toContainText("経過");
  await expect(logs.filter({ hasText: "12 pass" }).locator("p")).toHaveCSS("font-family", /Mono|monospace/);
  await expect(logs.filter({ hasText: "staging" })).toContainText("ブロッカー");
  await expect(activity.getByRole("article", { name: "コメント記録" }).filter({ hasText: "ふつうのコメント" })).toBeVisible();
  await expect(activity).toContainText("me が起票した");

  await chips.getByRole("button", { name: "作業ログ" }).click();
  await expect(chips.getByRole("button", { name: "作業ログ" })).toHaveAttribute("aria-pressed", "true");
  await expect(logs).toHaveCount(3);
  await expect(activity.getByRole("article", { name: "コメント記録" })).toHaveCount(0);
  await expect(activity).not.toContainText("me が起票した");

  await chips.getByRole("button", { name: "テスト結果" }).click();
  await expect(logs).toHaveCount(1);
  await expect(logs).toContainText("12 pass");

  await chips.getByRole("button", { name: "判断根拠" }).click();
  await expect(logs).toHaveCount(0);
  await expect(activity.getByRole("status")).toHaveText("この種類の作業ログはありません");
  // 絞り込みは URL に載せない
  expect(new URL(page.url()).search).toBe("");

  await chips.getByRole("button", { name: "すべて" }).click();
  await expect(activity.getByRole("article", { name: "コメント記録" }).filter({ hasText: "ふつうのコメント" })).toBeVisible();
});

test("6行を超える作業ログは折りたたみ、続きを表示で開いて折りたたむで戻せる", async ({ page, nod }) => {
  await nod.claude.logWork(ISSUE.comment, LONG, { kind: "rationale" });
  await nod.claude.logWork(ISSUE.comment, "短い経過");
  await page.goto(`/issues/${ISSUE.comment}`);
  const activity = region(page, "Activity");
  const long = activity.getByRole("article", { name: "作業ログ" }).filter({ hasText: "判断の根拠 1 行目" });
  const body = long.locator("p");
  await expect(long).toContainText("判断根拠");
  const clamped = await body.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  expect(clamped).toBe(true);

  const toggle = long.getByRole("button", { name: "続きを表示" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(long.getByRole("button", { name: "折りたたむ" })).toHaveAttribute("aria-expanded", "true");
  expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(false);
  await long.getByRole("button", { name: "折りたたむ" }).click();
  await expect(long.getByRole("button", { name: "続きを表示" })).toBeVisible();

  const short = activity.getByRole("article", { name: "作業ログ" }).filter({ hasText: "短い経過" });
  await expect(short.getByRole("button", { name: /続きを表示|折りたたむ/ })).toHaveCount(0);
});

test("絞り込みを入れた Activity でも、ステータスの変更はその Workspace の表示名で出す", async ({ page, nod }) => {
  await nod.me.setStatusNames("API", { in_review: "レビュー待ち", in_progress: "作業中" });
  await nod.me.updateIssue(ISSUE.comment, { status: "in_review" });
  await nod.me.updateIssue(ISSUE.comment, { status: "in_progress" });
  await nod.claude.logWork(ISSUE.comment, "再開した");
  await page.goto(`/issues/${ISSUE.comment}`);
  const activity = region(page, "Activity");
  const chips = activity.getByRole("group", { name: "作業ログの種類" });

  await expect(activity).toContainText("me がステータスを レビュー待ち から 作業中 に変えた");
  await chips.getByRole("button", { name: "作業ログ" }).click();
  await expect(activity).not.toContainText("ステータスを");
  await chips.getByRole("button", { name: "すべて" }).click();
  await expect(activity).toContainText("me がステータスを レビュー待ち から 作業中 に変えた");
});
