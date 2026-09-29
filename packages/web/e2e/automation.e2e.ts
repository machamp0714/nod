import { expect, test } from "./fixtures";
import { stubGh } from "./support/nod";

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
  await expect(auto.getByText("対象外: triage・in_review・LLM に委任中の Issue、未完了の子を持つ親 Issue、ブロック関係のある Issue")).toBeVisible();

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
  await expect(dialog).toContainText("確認した一覧のうち、実行時にも条件に合う Issue だけを処理します。アーカイブした Issue は復元できます。");
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

test("実行は確認した一覧だけを送り、確認のあとで対象から外れた Issue はスキップとして示す", async ({ page, nod }) => {
  await nod.me.setAutomationSettings("API", { closeAfterDays: 30, archiveAfterDays: 14 });
  await page.goto("/workspaces/API/settings");
  const auto = section(page);
  await auto.getByRole("button", { name: "今すぐ実行" }).click();
  const dialog = page.getByRole("alertdialog", { name: "クローズ 2件・アーカイブ 1件を実行しますか？" });
  await expect(dialog).toBeVisible();
  // 確認ダイアログを開いたあとで API-2 に手が入る（更新されたので自動クローズの条件から外れる）
  await nod.me.updateIssue("API-2", { status: "todo" });
  const request = page.waitForRequest((req) => req.url().endsWith("/automation/run") && req.postDataJSON()?.dryRun === false);
  await dialog.getByRole("button", { name: "実行する" }).click();
  expect((await request).postDataJSON()).toEqual({
    dryRun: false,
    targets: { auto_close: ["API-1", "API-2"], auto_archive: ["API-4"], pr_review: [] },
  });
  await expect(page.getByRole("status")).toHaveText("クローズ 1件・アーカイブ 1件・スキップ 1件・失敗 0件");
  expect((await nod.me.getIssue("API-1")).status).toBe("canceled");
  expect((await nod.me.getIssue("API-2")).status).toBe("todo");
  expect((await nod.me.getIssue("API-4")).archivedAt).not.toBeNull();
});

// PR 連動（#66）。e2e の server は実際の gh の代わりに stubGh の結果を返す（GitHub には触れない）
const PR_URL = "https://github.com/example/api-server/pull/214";
const ghOpen = JSON.stringify({ number: 214, title: "検索 API の N+1 を解消", url: PR_URL, state: "OPEN", isDraft: false, reviewDecision: null, mergedAt: null, statusCheckRollup: [] });

test("PR 連動を有効にして保存し、対象の PR と状態を確かめてから実行すると in_review にする", async ({ page, nod }) => {
  const api = (await nod.me.listWorkspaces()).find((w) => w.key === "API")!;
  const issue = await nod.me.createIssue({ workspaceId: api.id, title: "検索 API の N+1 を解消" }); // API-6
  await nod.claude.startIssue(issue.id);
  await nod.claude.linkPr(issue.id, PR_URL);
  await stubGh({ kind: "exited", exitCode: 0, stdout: ghOpen, stderr: "" });
  // 無効のうちに PR 状態を取得しておく（このときは進めない）
  expect((await page.request.post(`/api/issues/${issue.id}/pr-status/refresh`)).ok()).toBe(true);
  expect((await nod.me.getIssue(issue.id)).status).toBe("in_progress");

  await page.goto("/workspaces/API/settings");
  const auto = section(page);
  const pr = auto.getByRole("switch", { name: "PR 連動" });
  await expect(pr).toHaveAttribute("aria-checked", "false");
  await expect(auto.getByText("PR が open（draft 以外）かマージ済みになったら in_progress の Issue を in_review にする")).toBeVisible();
  await expect(auto.getByText("done にはしません。取消は nod automation undo")).toBeVisible();
  await pr.click();
  await auto.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("status")).toHaveText("保存しました");
  expect(await nod.me.getAutomationSettings("API")).toMatchObject({ prReview: true, closeAfterDays: null, archiveAfterDays: null });

  await auto.getByRole("button", { name: "対象を確認" }).click();
  const table = result(page).getByRole("table", { name: "in_review にする（PR）· 1 件" });
  await expect(table.getByRole("row")).toHaveText([/ID\s*タイトル\s*PR\s*PR の状態/, /API-6\s*検索 API の N\+1 を解消\s*#214\s*Open/]);
  await expect(table.getByRole("link", { name: "#214" })).toHaveAttribute("href", PR_URL);
  if (process.env.NOD_E2E_SHOTS) await auto.screenshot({ path: `${process.env.NOD_E2E_SHOTS}/automation-pr-review.png` });
  expect((await nod.me.getIssue(issue.id)).status).toBe("in_progress");

  await auto.getByRole("button", { name: "今すぐ実行" }).click();
  const dialog = page.getByRole("alertdialog", { name: "クローズ 0件・アーカイブ 0件・in_review 1件を実行しますか？" });
  await dialog.getByRole("button", { name: "実行する" }).click();
  await expect(page.getByRole("status")).toHaveText("クローズ 0件・アーカイブ 0件・in_review 1件・失敗 0件");
  expect((await nod.me.getIssue(issue.id)).status).toBe("in_review");
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
