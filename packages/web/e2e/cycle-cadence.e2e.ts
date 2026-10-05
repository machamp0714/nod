import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";

// ブラウザと同じローカルの暦日（e2e のブラウザは Node と同じマシンで動く）
function localDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 今日を含む Cycle。周期のテストとは分ける（DB はテストごとに空に戻る）
const around = () => ({ startDate: localDate(-3), endDate: localDate(3) });

test.describe("Cycle の周期・編集・削除・分析（NOD-2）", () => {
  test("周期を設定すると今日を含む Cycle と次ができ、外すと要約が未設定に戻る", async ({ page }) => {
    await page.goto("/cycles");
    await page.getByRole("button", { name: "周期の設定" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("周期").selectOption("2");
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(page.getByRole("link", { name: "Cycle 1", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Cycle 2", exact: true })).toBeVisible();
    await expect(page.getByText(/2週間ごと · 自動持ち越し ON · 次は Cycle 2/)).toBeVisible();

    await page.getByRole("button", { name: "周期の設定" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "周期を外す" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "外す" }).click();
    await expect(page.getByText("周期は未設定です")).toBeVisible();
  });

  test.describe("周期を外せないとき", () => {
    test.use({ allowedConsoleErrors: [/status of 400/] });

    test("周期を外せなかったときの文言は、確認を開き直すと元に戻る", async ({ page }) => {
      await page.goto("/cycles");
      await page.getByRole("button", { name: "周期の設定" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "保存" }).click();
      await expect(page.getByText(/2週間ごと/)).toBeVisible();
      await page.route("**/api/cycle-cadence", (route) =>
        route.request().method() === "DELETE"
          ? route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { code: "INVALID_ARGS", message: "失敗" } }) })
          : route.continue(),
      );
      await page.getByRole("button", { name: "周期の設定" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "周期を外す" }).click();
      const confirm = page.getByRole("alertdialog");
      await confirm.getByRole("button", { name: "外す" }).click();
      await expect(confirm).toContainText("外せませんでした");
      await confirm.getByRole("button", { name: "キャンセル" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "周期を外す" }).click();
      await expect(page.getByRole("alertdialog")).toContainText("以後、Cycle は自動で作られず");
    });
  });

  test("サイドバーの Current で今の Cycle の詳細を開き、なければ一覧を開く", async ({ page, nod }) => {
    await page.goto("/issues");
    const nav = page.getByRole("navigation");
    await expect(nav.getByRole("link", { name: /Current/ })).toContainText("なし");
    await nav.getByRole("link", { name: /Current/ }).click();
    await expect(page).toHaveURL(/\/cycles$/);
    const c = await nod.me.createCycle({ name: "今", ...around() });
    await page.reload();
    await nav.getByRole("link", { name: /Current/ }).click();
    await expect(page).toHaveURL(new RegExp(`/cycles/${c.id}$`));
    await expect(nav.getByRole("link", { name: /Current/ })).toHaveAttribute("aria-current", "page");
  });

  test("Cycle を編集し、削除すると一覧へ戻り所属 Issue は Cycle なしになる", async ({ page, nod }) => {
    const api = await seedApiWorkspace(nod);
    const c = await nod.me.createCycle({ name: "編集前", startDate: "2999-01-01", endDate: "2999-01-14" });
    const issue = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "所属" });
    await nod.me.updateIssue(issue.id, { cycleRef: String(c.id) });
    // アーカイブ済みの所属も削除で Cycle なしに戻るので、確認の件数に含める
    const archived = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "アーカイブ済み" });
    await nod.me.updateIssue(archived.id, { cycleRef: String(c.id) });
    await nod.me.archiveIssue(archived.id);
    await page.goto(`/cycles/${c.id}`);
    await page.getByRole("button", { name: "Cycle の操作" }).click();
    await page.getByRole("menuitem", { name: "編集" }).click();
    await page.getByRole("dialog").getByLabel("名前").fill("編集後");
    await page.getByRole("dialog").getByRole("button", { name: "保存" }).click();
    await expect(page.getByRole("heading", { name: "編集後" })).toBeVisible();
    await page.getByRole("button", { name: "Cycle の操作" }).click();
    await page.getByRole("menuitem", { name: "削除" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("所属する 2 件（アーカイブ済みを含む）は Cycle なしに戻ります");
    await confirm.getByRole("button", { name: "削除" }).click();
    await expect(page).toHaveURL(/\/cycles$/);
    expect((await nod.me.getIssue(issue.id)).cycle).toBeNull();
    expect((await nod.me.getIssue(archived.id)).cycle).toBeNull();
  });

  test("分析ボタンで右に分析パネルが開き、進捗・Cycle graph・内訳が出る", async ({ page, nod }) => {
    const api = await seedApiWorkspace(nod);
    // 今日を含む Cycle に Issue を2件入れて1件を done にする
    const c = await nod.me.createCycle({ name: "今", ...around() });
    const a = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "a" });
    const b = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "b" });
    for (const i of [a, b]) await nod.me.updateIssue(i.id, { cycleRef: String(c.id) });
    await nod.me.updateIssue(a.id, { status: "done" });
    await page.goto(`/cycles/${c.id}`);
    await expect(page.getByRole("complementary", { name: "Cycle の分析" })).toHaveCount(0);
    await page.getByRole("button", { name: "分析" }).click();
    const section = page.getByRole("complementary", { name: "Cycle の分析" });
    await expect(section.getByRole("region", { name: "進捗" })).toContainText("50%");
    await expect(section.getByRole("region", { name: "Cycle graph" })).toBeVisible();
    const breakdown = section.getByRole("region", { name: "内訳" });
    await breakdown.getByRole("tab", { name: "Workspaces" }).click();
    await expect(breakdown).toContainText("50% of 2");
    await breakdown.getByRole("tab", { name: "Status" }).click();
    const rows = breakdown.getByRole("tabpanel").getByRole("listitem");
    await expect(rows.filter({ hasText: "Done" })).toHaveText(/^\s*Done\s*1\s*$/);
    await expect(rows.filter({ hasText: "Canceled" })).toHaveText(/^\s*Canceled\s*0\s*$/);
    await page.keyboard.press("Escape");
    await expect(section).toHaveCount(0);
    await expect(page.getByRole("button", { name: "分析" })).toBeFocused();
  });

  test("期間が非常に長い Cycle でも分析パネルの Cycle graph が出る", async ({ page, nod }) => {
    const c = await nod.me.createCycle({ name: "長期", startDate: "2000-01-01", endDate: "2999-12-31" });
    await page.goto(`/cycles/${c.id}`);
    await page.getByRole("button", { name: "分析" }).click();
    const section = page.getByRole("complementary", { name: "Cycle の分析" });
    await expect(section.getByRole("region", { name: "Cycle graph" })).toBeVisible();
    await expect(section.getByRole("img", { name: "Cycle graph" })).toBeVisible();
  });
});
