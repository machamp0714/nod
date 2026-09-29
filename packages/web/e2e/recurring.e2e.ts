import { expect, test } from "./fixtures";

test.use({ dataset: "issue-list" });

const section = (page: import("@playwright/test").Page) => page.getByRole("region", { name: "定期Issue" });

test("定期Issueを追加・確認・実行・停止・編集・削除でき、同じ発生日は二度作らない", async ({ page, nod }) => {
  await nod.me.saveTemplate({ name: "review", body: "## 振り返り" });
  await page.goto("/workspaces/API/settings");
  const sec = section(page);
  await expect(sec.getByText("周期ごとに Issue を起票します。起票は『今すぐ実行』か nod recurring run のときだけ行います。LLM は変更できません。")).toBeVisible();
  await expect(sec.getByText("定期Issue はまだありません")).toBeVisible();

  // 追加：テンプレート・Project・ラベル・優先度・担当・毎週月曜・開始日・TZ
  await sec.getByRole("button", { name: "定期Issue を追加" }).click();
  const form = sec.getByRole("form", { name: "定期Issue を追加" });
  await form.getByRole("button", { name: "保存" }).click();
  await expect(form.getByRole("alert")).toHaveText("タイトルを入力してください");
  await form.getByLabel("タイトル").fill("週次レビュー");
  await form.getByRole("radio", { name: "テンプレート" }).click();
  await form.getByLabel("テンプレート").selectOption("review");
  await form.getByLabel("Project").selectOption("nod Web UI");
  await form.getByLabel("ラベルを追加").fill("review");
  await form.getByLabel("ラベルを追加").press("Enter");
  await expect(form.getByRole("group", { name: "ラベル" }).getByText("review", { exact: true })).toBeVisible();
  await form.getByLabel("優先度").selectOption({ label: "Medium" });
  await form.getByLabel("担当").fill("me");
  await form.getByRole("radio", { name: "毎週" }).click();
  await form.getByRole("radio", { name: "月曜" }).click();
  await form.getByLabel("開始日").fill("2026-01-01");
  await form.getByLabel("TZ").selectOption("UTC");
  await form.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("status")).toHaveText("追加しました");
  await expect(form).toHaveCount(0);
  const row = sec.getByRole("row").filter({ hasText: "週次レビュー" });
  await expect(row).toContainText("毎週 月曜");
  const [saved] = await nod.me.listRecurringIssues("API");
  expect(saved).toMatchObject({
    title: "週次レビュー",
    template: "review",
    description: null,
    project: "nod Web UI",
    labels: ["review"],
    priority: 3,
    assignee: "me",
    cadence: "weekly",
    weekday: 1,
    startDate: "2026-01-01",
    timeZone: "UTC",
    enabled: true,
  });
  await expect(row).toContainText(`${saved!.nextOccurrence!.slice(5, 7)}/${saved!.nextOccurrence!.slice(8, 10)}`);

  // 対象を確認：起票せずに予定を見せる
  await sec.getByRole("button", { name: "対象を確認" }).click();
  const preview = sec.getByRole("region", { name: "対象の確認結果" });
  await expect(preview).toContainText("起票する · 1件");
  await expect(preview).toContainText("まだ起票していません");
  await expect(preview.getByRole("row").filter({ hasText: "週次レビュー" })).toBeVisible();
  expect((await nod.me.listRecurringIssues("API"))[0]).toMatchObject({ lastOccurrence: null, lastIssueId: null });

  // 今すぐ実行：1件だけ起票し、前回作成にリンクを出す。もう一度実行しても作らない
  await sec.getByRole("button", { name: "今すぐ実行" }).click();
  await expect(page.getByRole("status")).toHaveText(/^1件を起票しました（スキップ \d+件）$/);
  await expect(preview).toHaveCount(0);
  const ran = (await nod.me.listRecurringIssues("API"))[0]!;
  const issueId = ran.lastIssueId!;
  expect(issueId).toMatch(/^API-\d+$/);
  await expect(row.getByRole("link", { name: issueId })).toBeVisible();
  expect(await nod.me.getIssue(issueId)).toMatchObject({
    title: "週次レビュー",
    description: "## 振り返り",
    status: "todo",
    priority: 3,
    assignee: "me",
    labels: ["review"],
    project: { name: "nod Web UI" },
  });
  await sec.getByRole("button", { name: "今すぐ実行" }).click();
  await expect(page.getByRole("status")).toHaveText("起票する定期Issueはありませんでした");

  // 起票した Issue の Activity に作成元が出る
  await row.getByRole("link", { name: issueId }).click();
  await expect(page.getByText(`me が定期Issue #${ran.id}（${ran.lastOccurrence} 分）から起票した`)).toBeVisible();
  await page.goBack();

  await section(page).getByRole("button", { name: "週次レビュー を編集" }).click();
  const edit = section(page).getByRole("form", { name: "定期Issue「週次レビュー」を編集" });
  await expect(edit.getByLabel("テンプレート")).toHaveValue("review");
  // 毎月・末日・本文に変える
  await edit.getByRole("radio", { name: "毎月" }).click();
  await edit.getByLabel("毎月の日").selectOption({ label: "末日" });
  await edit.getByRole("radio", { name: "本文" }).click();
  await edit.getByLabel("起票する Issue の説明").fill("請求を確認する");
  await edit.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("status")).toHaveText("保存しました");
  await expect(section(page).getByRole("row").filter({ hasText: "週次レビュー" })).toContainText("毎月 末日");
  expect((await nod.me.listRecurringIssues("API"))[0]).toMatchObject({ cadence: "monthly", monthDay: 31, weekday: null, template: null, description: "請求を確認する" });

  // 停止すると次回が出ない
  const toggle = section(page).getByRole("switch", { name: "週次レビュー を有効にする" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  expect((await nod.me.listRecurringIssues("API"))[0]).toMatchObject({ enabled: false, nextOccurrence: null });
  await expect(section(page).getByRole("row").filter({ hasText: "週次レビュー" })).toContainText("—");

  // 削除は確認し、起票済みの Issue は残る
  await section(page).getByRole("button", { name: "週次レビュー を削除" }).click();
  const dialog = page.getByRole("alertdialog", { name: "定期Issue「週次レビュー」を削除しますか？" });
  await expect(dialog).toContainText("今後の起票が止まります。これまでに起票した Issue は残ります。");
  await dialog.getByRole("button", { name: "削除する" }).click();
  await expect(section(page).getByText("定期Issue はまだありません")).toBeVisible();
  expect(await nod.me.listRecurringIssues("API")).toEqual([]);
  expect((await nod.me.getIssue(issueId)).title).toBe("週次レビュー");
});

test("テンプレートが見つからない定期Issueは、確認でエラーを示して他は続ける", async ({ page, nod }) => {
  await nod.me.saveTemplate({ name: "review", body: "## 振り返り" });
  await nod.me.addRecurringIssue("API", { title: "週次レビュー", template: "review", cadence: "daily", startDate: "2026-01-01", timeZone: "UTC" });
  await nod.me.addRecurringIssue("API", { title: "日次チェック", cadence: "daily", startDate: "2026-01-01", timeZone: "UTC" });
  await nod.me.removeTemplate("review");
  await page.goto("/workspaces/API/settings");
  await section(page).getByRole("button", { name: "対象を確認" }).click();
  const alert = section(page).getByRole("alert").filter({ hasText: "テンプレート『review』が見つかりません" });
  await expect(alert).toContainText("この定期Issue の起票をスキップしました。テンプレートを登録するか、本文に切り替えてください。");
  const preview = section(page).getByRole("region", { name: "対象の確認結果" });
  await expect(preview).toContainText("起票する · 1件");
  await expect(preview).toContainText("日次チェック");
});
