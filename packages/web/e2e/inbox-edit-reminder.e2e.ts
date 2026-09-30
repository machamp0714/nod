import type { Page } from "@playwright/test";
import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";
import { chooseProperty, property, propertyMenu } from "./helpers";

const list = (page: Page) => page.getByRole("region", { name: "通知の一覧" });
const detail = (page: Page) => page.getByRole("region", { name: "詳細", exact: true });
const props = (page: Page) => detail(page).getByRole("region", { name: "プロパティ" });
const timeline = (page: Page) => detail(page).getByRole("region", { name: "通知" });

// 端末の日時で n 日後の YYYY-MM-DD
const dayAfter = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// 右カラムは幅 280 で、値の列（約 144）はメニュー（208）より狭い。メニューは値の列の右端に揃えて開く
test("通知の詳細のメニューは右カラムの内側に開き、横にはみ出さない（1440×960）", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const a = await api.startedIssue("検索 API の N+1 を解消");
  await nod.me.subscribeIssue(a.id);
  await nod.claude.commentIssue(a.id, "原因がわかりました");
  await page.goto(`/inbox?tab=notifications&selected=${a.id}`);
  await page.evaluate(() => document.fonts.ready);

  const measured: Record<string, unknown> = {};
  for (const name of ["Status", "Project", "Assignee"]) {
    await property(props(page), name).click();
    const layout = await propertyMenu(props(page), name).evaluate((menu) => {
      const popover = menu.parentElement!.getBoundingClientRect();
      const value = menu.closest("dd")!.getBoundingClientRect();
      const rail = menu.closest("aside")!.getBoundingClientRect();
      const main = document.querySelector("main")!;
      return {
        width: popover.width,
        rightGap: Math.abs(popover.right - value.right),
        insideRail: popover.left >= rail.left && popover.right <= rail.right,
        mainOverflow: main.scrollWidth - main.clientWidth,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(layout, name).toEqual({ width: 208, rightGap: 0, insideRail: true, mainOverflow: 0, pageOverflow: 0 });
    measured[name] = layout;
    await page.keyboard.press("Escape");
    await expect(propertyMenu(props(page), name)).toHaveCount(0);
  }
  console.log("Inbox の通知の詳細のメニュー", JSON.stringify(measured));
});

test.describe("通知からの編集（#46）", () => {
  // 失敗時の表示を確かめるため 409 を返す
  test.use({ allowedConsoleErrors: [/status of 409/] });

  test("Inbox の通知詳細から Issue のプロパティを直接変えられ、ほかで変わった値も反映される（#46）", async ({ page, nod }) => {
    const api = await seedApiWorkspace(nod);
    const a = await api.startedIssue("検索 API の N+1 を解消");
    await nod.me.createProject({ name: "検索の高速化" });
    await nod.me.subscribeIssue(a.id);
    await nod.claude.commentIssue(a.id, "原因がわかりました");

    await page.goto(`/inbox?tab=notifications&selected=${a.id}`);
    await expect(props(page).getByRole("heading", { name: "プロパティ" })).toBeVisible();
    // Inbox では変えられる行とリマインダーだけを出す
    for (const label of ["Status", "Priority", "Project", "Assignee"]) await expect(property(props(page), label)).toBeVisible();
    for (const label of ["Estimate を編集", "Due date を編集", "Reminder を編集"]) await expect(props(page).getByRole("button", { name: label })).toBeVisible();
    await expect(props(page).getByText("作業状況")).toHaveCount(0);
    await expect(props(page).getByText("Workspace")).toHaveCount(0);

    await chooseProperty(props(page), "Priority", "High");
    await expect.poll(async () => (await nod.me.getIssue(a.id)).priority).toBe(2);
    await chooseProperty(props(page), "Status", "In Review");
    await expect.poll(async () => (await nod.me.getIssue(a.id)).status).toBe("in_review");
    await expect(detail(page).getByText("In Review").first()).toBeVisible();
    await chooseProperty(props(page), "Project", "検索の高速化");
    await expect.poll(async () => (await nod.me.getIssue(a.id)).project?.name).toBe("検索の高速化");
    await props(page).getByRole("button", { name: "ラベルを追加", exact: true }).click();
    await props(page).getByRole("textbox", { name: "ラベルを追加" }).fill("perf");
    await props(page).getByRole("button", { name: "追加", exact: true }).click();
    await expect.poll(async () => (await nod.me.getIssue(a.id)).labels).toEqual(["perf"]);
    await props(page).getByRole("button", { name: "Estimate を編集" }).click();
    await props(page).getByRole("textbox", { name: "Estimate" }).fill("3");
    await props(page).getByRole("textbox", { name: "Estimate" }).press("Enter");
    await expect(props(page).getByRole("button", { name: "Estimate を編集" })).toContainText("3 pt");
    await props(page).getByRole("button", { name: "Due date を編集" }).click();
    await props(page).getByLabel("Due date", { exact: true }).fill(dayAfter(3));
    await props(page).getByLabel("Due date", { exact: true }).press("Enter");
    await expect.poll(async () => (await nod.me.getIssue(a.id)).dueDate).toBe(dayAfter(3));
    await chooseProperty(props(page), "Assignee", "なし");
    await expect.poll(async () => (await nod.me.getIssue(a.id)).assignee).toBeNull();

    // ほかの場所（CLI の LLM）での変更は後から読み直して表示する（Issue 詳細と同じく後勝ち）
    await nod.claude.updateIssue(a.id, { priority: 1 });
    await expect(property(props(page), "Priority")).toHaveAttribute("data-value", "1");

    // 失敗は Issue 詳細と同じくパネルの下に出し、値は server の最新に戻す
    await page.route(`**/api/issues/${a.id}/update`, (route) =>
      route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "ISSUE_CLOSED", message: "閉じた Issue です" } }) }),
    );
    await chooseProperty(props(page), "Priority", "Low");
    await expect(props(page).getByRole("alert")).toHaveText("変更できませんでした：閉じた Issue です");
    await expect(property(props(page), "Priority")).toHaveAttribute("data-value", "1");
    // 自分の操作は自分に通知しない
    await expect(timeline(page).getByText(/me が/)).toHaveCount(0);
  });
});

test("Issue 詳細でリマインダーを設定・変更・解除でき、過去の日時は拒む（#47）", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const a = await api.startedIssue("検索 API の N+1 を解消");
  await page.goto(`/issues/${a.id}`);
  const panel = page.getByRole("region", { name: "プロパティ" });

  await panel.getByRole("button", { name: "Reminder を編集" }).click();
  await panel.getByLabel("リマインダーの日付").fill(dayAfter(-2));
  await panel.getByLabel("リマインダーのメモ").fill("定例で確認");
  await panel.getByRole("button", { name: "設定" }).click();
  await expect(panel.getByRole("alert")).toHaveText("過去の日時は指定できません");
  expect(await nod.me.listReminders()).toEqual([]);

  await panel.getByLabel("リマインダーの日付").fill(dayAfter(2));
  await panel.getByLabel("リマインダーの時刻").fill("09:00");
  await panel.getByRole("button", { name: "設定" }).click();
  const [mm, dd] = dayAfter(2).slice(5).split("-");
  await expect(panel.getByRole("button", { name: "Reminder を編集" })).toContainText(`${mm}/${dd} 09:00`);
  await expect(panel.getByRole("button", { name: "Reminder を編集" })).toContainText("定例で確認");
  const [saved] = await nod.me.listReminders();
  const [y, m, d] = dayAfter(2).split("-").map(Number);
  expect(saved).toMatchObject({ issueId: a.id, note: "定例で確認", remindAt: new Date(y!, m! - 1, d!, 9).toISOString() });

  await page.reload();
  await panel.getByRole("button", { name: "Reminder を編集" }).click();
  await expect(panel.getByLabel("リマインダーのメモ")).toHaveValue("定例で確認");
  await panel.getByRole("button", { name: "解除" }).click();
  await expect(panel.getByRole("button", { name: "Reminder を編集" })).toHaveText("なし");
  expect(await nod.me.listReminders()).toEqual([]);
});

test("期限が来たリマインダーは、開いたままの Inbox に kind=reminder の通知として届く（#47）", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const a = await api.startedIssue("検索 API の N+1 を解消");
  const b = await api.startedIssue("決済 Webhook の再送処理");
  await nod.me.subscribeIssue(b.id);
  await nod.claude.commentIssue(b.id, "b1");
  await nod.me.setReminder(a.id, { at: new Date(Date.now() + 4000).toISOString(), note: "来週の定例で確認" });

  await page.goto("/inbox?tab=notifications");
  await expect(list(page).getByRole("link")).toHaveCount(1);
  // 購読していない Issue でも、期限が来ると読み直して一覧の先頭に出る
  const row = list(page).getByRole("link", { name: /検索 API の N\+1 を解消（未読 1）/ });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText("リマインダー：来週の定例で確認");
  await row.click();
  await expect(timeline(page).getByText("リマインダー：来週の定例で確認")).toBeVisible();
  expect(await nod.me.listReminders()).toEqual([]);

  // Inbox のプロパティからも設定し直せる
  await props(page).getByRole("button", { name: "Reminder を編集" }).click();
  await props(page).getByLabel("リマインダーの日付").fill(dayAfter(1));
  await props(page).getByRole("button", { name: "設定" }).click();
  await expect(props(page).getByRole("button", { name: "Reminder を編集" })).toContainText("09:00");
  expect((await nod.me.listReminders()).map((r) => r.issueId)).toEqual([a.id]);
});

test("Inbox 以外の画面でも、期限が来たら開いている Issue 詳細のリマインダーが消え、通知が届く（#47）", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const a = await api.startedIssue("検索 API の N+1 を解消");
  await nod.me.setReminder(a.id, { at: new Date(Date.now() + 4000).toISOString(), note: "来週の定例で確認" });

  await page.goto(`/issues/${a.id}`);
  const reminder = page.getByRole("region", { name: "プロパティ" }).getByRole("button", { name: "Reminder を編集" });
  await expect(reminder).toContainText("来週の定例で確認");
  await expect(reminder).toHaveText("なし", { timeout: 15_000 });
  expect((await nod.me.listNotifications()).map((n) => n.kind)).toEqual(["reminder"]);
});

test("アーカイブ済みの Issue ではリマインダーを設定・変更できず、解除だけできる（#47・#30）", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const a = await api.startedIssue("検索 API の N+1 を解消");
  await nod.me.setReminder(a.id, { at: new Date(Date.now() + 86_400_000).toISOString(), note: "定例で確認" });
  await nod.me.archiveIssue(a.id);

  await page.goto(`/issues/${a.id}`);
  const panel = page.getByRole("region", { name: "プロパティ" });
  await expect(panel.getByRole("button", { name: "Reminder を編集" })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Reminder を編集" })).toContainText("定例で確認");
  const clear = panel.getByRole("button", { name: "解除" });
  await expect(clear).toBeEnabled();
  await expect(clear).toHaveCSS("opacity", "1");
  await clear.click();
  await expect(panel.getByRole("button", { name: "Reminder を編集" })).toHaveText("なし");
  await expect(panel.getByRole("button", { name: "解除" })).toHaveCount(0);
  expect((await nod.me.getIssue(a.id)).reminder).toBeNull();
});
