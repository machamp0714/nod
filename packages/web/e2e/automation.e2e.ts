import { expect, test } from "./fixtures";

test.use({ dataset: "automation" });

const section = (page: import("@playwright/test").Page) => page.getByRole("region", { name: "自動化" });
const result = (page: import("@playwright/test").Page) => page.getByRole("region", { name: "対象の確認結果" });

test("未設定から自動クローズ・自動アーカイブを有効にし、日数の誤りを示して保存できる", async ({ page, nod }) => {
  await page.goto("/workspaces/API/settings");
  const auto = section(page);
  const close = auto.getByRole("switch", { name: "自動クローズ" });
  const archive = auto.getByRole("switch", { name: "自動アーカイブ" });
  await expect(close).toHaveAttribute("aria-checked", "false");
  await expect(archive).toHaveAttribute("aria-checked", "false");
  await expect(auto.getByRole("textbox", { name: "自動クローズの日数" })).toBeDisabled();
  await expect(auto.getByRole("textbox", { name: "自動クローズの日数" })).toHaveValue("30");
  await expect(auto.getByRole("textbox", { name: "自動アーカイブの日数" })).toHaveValue("14");
  await expect(auto.getByRole("button", { name: "対象を確認" })).toBeDisabled();
  await expect(auto.getByRole("button", { name: "今すぐ実行" })).toBeDisabled();
  await expect(auto.getByRole("button", { name: "保存" })).toBeDisabled();
  await expect(auto.getByText("対象外: triage・in_review・LLM に委任中の Issue、未完了の子を持つ親 Issue")).toBeVisible();

  await close.click();
  await expect(close).toHaveAttribute("aria-checked", "true");
  const days = auto.getByRole("textbox", { name: "自動クローズの日数" });
  await expect(days).toBeEnabled();
  await days.fill("0");
  await expect(auto.getByRole("alert")).toHaveText("1〜3650 の日数を入力してください");
  await expect(days).toHaveAttribute("aria-invalid", "true");
  await expect(auto.getByRole("button", { name: "保存" })).toBeDisabled();
  await days.fill("30");
  await expect(auto.getByRole("alert")).toHaveCount(0);
  await archive.click();
  // 未保存の変更があるうちは確認・実行できない
  await expect(auto.getByRole("button", { name: "対象を確認" })).toBeDisabled();
  await auto.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("status")).toHaveText("保存しました");
  expect(await nod.me.getAutomationSettings("API")).toMatchObject({ closeAfterDays: 30, archiveAfterDays: 14, updatedBy: "me" });
  expect(await nod.me.getAutomationSettings("NOD")).toMatchObject({ closeAfterDays: null, archiveAfterDays: null });
  await expect(auto.getByRole("button", { name: "保存" })).toBeDisabled();
  await expect(auto.getByRole("button", { name: "対象を確認" })).toBeEnabled();

  await page.reload();
  await expect(section(page).getByRole("switch", { name: "自動クローズ" })).toHaveAttribute("aria-checked", "true");
  await section(page).getByRole("switch", { name: "自動アーカイブ" }).click();
  await section(page).getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("status")).toHaveText("保存しました");
  expect(await nod.me.getAutomationSettings("API")).toMatchObject({ closeAfterDays: 30, archiveAfterDays: null });
});

test("対象を確認すると候補を古い順に示し、何も変えない", async ({ page, nod }) => {
  await nod.me.setAutomationSettings("API", { closeAfterDays: 30, archiveAfterDays: 14 });
  await page.goto("/workspaces/API/settings");
  await section(page).getByRole("button", { name: "対象を確認" }).click();
  const r = result(page);
  await expect(r).toContainText("対象の確認結果（まだ実行していません）");
  await expect(r).toContainText(/\d{2}-\d{2} \d{2}:\d{2} 時点/);
  const close = r.getByRole("table", { name: "canceled にする · 2 件" });
  await expect(close.getByRole("row")).toHaveText([/ID\s*タイトル\s*最終更新\s*経過日数/, /API-1\s*放置された調査.*45 日/, /API-2\s*古い下書き.*40 日/]);
  const archive = r.getByRole("table", { name: "アーカイブする · 1 件" });
  await expect(archive.getByRole("row").nth(1)).toHaveText(/API-4\s*リリース済みの修正.*20 日/);
  // Triage・最近の Issue・別 Workspace は出さない
  await expect(r).not.toContainText("API-5");
  await expect(r).not.toContainText("API-3");
  await expect(r).not.toContainText("NOD-1");
  expect((await nod.me.getIssue("API-1")).status).toBe("todo");
  expect((await nod.me.getIssue("API-4")).archivedAt).toBeNull();
});

test("今すぐ実行は件数を確かめてから実行し、完了をトーストで示し、2回目は対象がない", async ({ page, nod }) => {
  await nod.me.setAutomationSettings("API", { closeAfterDays: 30, archiveAfterDays: 14 });
  await page.goto("/workspaces/API/settings");
  const auto = section(page);
  await auto.getByRole("button", { name: "今すぐ実行" }).click();
  const dialog = page.getByRole("alertdialog", { name: "クローズ 2件・アーカイブ 1件を実行しますか？" });
  await expect(dialog).toContainText("対象は実行時点の条件で決まります。アーカイブした Issue は復元できます。");
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  await expect(dialog).toHaveCount(0);
  expect((await nod.me.getIssue("API-1")).status).toBe("todo");

  await auto.getByRole("button", { name: "今すぐ実行" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "実行する" }).click();
  await expect(page.getByRole("status")).toHaveText("クローズ 2件・アーカイブ 1件・失敗 0件");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  const closed = await nod.me.getIssue("API-1");
  expect(closed).toMatchObject({ status: "canceled", closeReason: "自動クローズ（30日間更新なし）" });
  expect((await nod.me.getIssue("API-2")).status).toBe("canceled");
  expect((await nod.me.getIssue("API-4")).archivedAt).not.toBeNull();
  expect((await nod.me.getIssue("API-5")).status).toBe("triage");
  expect((await nod.me.getIssue("NOD-1")).status).toBe("todo");

  await auto.getByRole("button", { name: "対象を確認" }).click();
  await expect(result(page)).toHaveText("対象の Issue はありません");
  // 対象がなければ確認ダイアログを出さない
  await auto.getByRole("button", { name: "今すぐ実行" }).click();
  await expect(result(page)).toHaveText("対象の Issue はありません");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test.describe("保存の失敗", () => {
  test.use({ allowedConsoleErrors: [/status of 500/] });
  test("失敗すると理由を示し、入力を保つ", async ({ page, nod }) => {
    await page.route("**/api/workspaces/API/automation", (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "UNEXPECTED", message: "保存に失敗しました" } }) })
        : route.fallback(),
    );
    await page.goto("/workspaces/API/settings");
    const auto = section(page);
    await auto.getByRole("switch", { name: "自動クローズ" }).click();
    await auto.getByRole("textbox", { name: "自動クローズの日数" }).fill("60");
    await auto.getByRole("button", { name: "保存" }).click();
    await expect(auto.getByRole("alert")).toHaveText("保存に失敗しました");
    await expect(auto.getByRole("textbox", { name: "自動クローズの日数" })).toHaveValue("60");
    expect((await nod.me.getAutomationSettings("API")).closeAfterDays).toBeNull();
  });
});

test.describe("実行の失敗", () => {
  test.use({ allowedConsoleErrors: [/status of 500/] });
  test("実行が失敗すると理由を示し、Issue は変わらない", async ({ page, nod }) => {
    await nod.me.setAutomationSettings("API", { closeAfterDays: 30, archiveAfterDays: null });
    await page.route("**/api/workspaces/API/automation/run", (route) =>
      route.request().postDataJSON()?.dryRun === false
        ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "UNEXPECTED", message: "実行に失敗しました" } }) })
        : route.fallback(),
    );
    await page.goto("/workspaces/API/settings");
    const auto = section(page);
    await auto.getByRole("button", { name: "今すぐ実行" }).click();
    await page.getByRole("alertdialog", { name: "クローズ 2件・アーカイブ 0件を実行しますか？" }).getByRole("button", { name: "実行する" }).click();
    await expect(auto.getByRole("alert")).toHaveText("実行に失敗しました");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect((await nod.me.getIssue("API-1")).status).toBe("todo");
  });
});
