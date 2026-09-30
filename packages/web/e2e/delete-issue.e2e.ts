import { expect, test } from "./fixtures";
import { seedApiWorkspace } from "./decision-data";

test("アーカイブ済みIssueはメニューの「完全に削除」から、Issue ID を入力して削除でき、アーカイブ済みの一覧へ移る", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const keep = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "残すアーカイブ" });
  const target = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "完全に削除する Issue" });
  await nod.me.archiveIssue(keep.id);
  await nod.me.archiveIssue(target.id);

  await page.goto(`/issues/${target.id}`);
  const trigger = page.getByRole("button", { name: "Issueのメニュー", exact: true });
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Issueの操作" });
  await menu.getByRole("menuitem", { name: "完全に削除" }).click();
  await expect(menu).toHaveCount(0);

  const dialog = page.getByRole("alertdialog", { name: `${target.id} を完全に削除しますか？` });
  await expect(dialog).toContainText("コメント・添付・履歴も消え、元に戻せません。子Issueは残り、親が外れます");
  const input = dialog.getByRole("textbox", { name: "確認のため Issue ID を入力" });
  const confirm = dialog.getByRole("button", { name: "削除する" });
  await expect(input).toBeFocused();
  await expect(confirm).toBeDisabled();
  await input.fill("API-0");
  await expect(confirm).toBeDisabled();

  // キャンセルでは何も消えず、メニューのボタンへ戻る
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect((await api.show(target.id)).archivedAt).not.toBeNull();

  await trigger.click();
  await menu.getByRole("menuitem", { name: "完全に削除" }).click();
  await input.fill(target.id.toLowerCase());
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(page).toHaveURL(/\/issues\?archived=true$/);
  await expect(page.getByRole("status").filter({ hasText: `${target.id} を完全に削除しました` })).toBeVisible();
  await expect(page.getByText(keep.title)).toBeVisible();
  await expect(page.getByText(target.title)).toHaveCount(0);
  expect((await page.request.get(`/api/issues/${target.id}`)).status()).toBe(404);
  const audit = await (await page.request.get(`/api/workspaces/${api.workspace.key}/issue-deletions`)).json();
  expect(audit).toMatchObject([{ issueId: target.id, title: target.title, deletedBy: "me" }]);

  // 再読み込みではトーストを出し直さない
  await page.reload();
  await expect(page.getByText(keep.title)).toBeVisible();
  await expect(page.getByText(`${target.id} を完全に削除しました`)).toHaveCount(0);
});

test("アーカイブしていない Issue のメニューには「完全に削除」が出ない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "アーカイブ前" });
  await page.goto(`/issues/${issue.id}`);
  await page.getByRole("button", { name: "Issueのメニュー", exact: true }).click();
  await expect(page.getByRole("menu", { name: "Issueの操作" }).getByRole("menuitem", { name: "完全に削除" })).toHaveCount(0);
});

test.describe("削除に失敗したとき", () => {
  test.use({ allowedConsoleErrors: [/status of 409/] });

  test("ダイアログを開いたまま理由を出し、Issue は残る", async ({ page, nod }) => {
    const api = await seedApiWorkspace(nod);
    const issue = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "失敗する削除" });
    await nod.me.archiveIssue(issue.id);
    await page.goto(`/issues/${issue.id}`);
    await page.getByRole("button", { name: "Issueのメニュー", exact: true }).click();
    await page.getByRole("menu", { name: "Issueの操作" }).getByRole("menuitem", { name: "完全に削除" }).click();
    const dialog = page.getByRole("alertdialog");
    // 別の場所で復元された（アーカイブ済みでなくなった）
    await nod.me.unarchiveIssue(issue.id);
    await dialog.getByRole("textbox", { name: "確認のため Issue ID を入力" }).fill(issue.id);
    await dialog.getByRole("button", { name: "削除する" }).click();
    await expect(dialog.getByRole("alert")).toContainText("削除できませんでした：");
    await expect(dialog.getByRole("alert")).toContainText("先にアーカイブしてください");
    await expect(page).toHaveURL(new RegExp(`/issues/${issue.id}$`));
    expect((await api.show(issue.id)).title).toBe("失敗する削除");
  });
});
