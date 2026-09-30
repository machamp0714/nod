import { expect, test } from "./fixtures";
import { seedApiWorkspace } from "./decision-data";

test("Issueのメニューからアーカイブすると読み取り専用になり、アーカイブ絞り込みで確認して復元できる", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const keep = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "残す Issue" });
  const target = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "アーカイブする Issue" });
  await nod.me.commentIssue(target.id, "既存のスレッド");

  await page.goto(`/issues/${target.id}`);
  await page.getByRole("button", { name: "Issueのメニュー", exact: true }).click();
  await page.getByRole("menu", { name: "Issueの操作" }).getByRole("menuitem", { name: "アーカイブ" }).click();
  const banner = page.getByRole("region", { name: "アーカイブ済み" });
  await expect(banner).toContainText(/このIssueはアーカイブ済みです（\d{4}-\d{2}-\d{2} \d{2}:\d{2}）/);
  await expect(page.getByRole("combobox", { name: "Status" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Estimate を編集" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Due date を編集" })).toBeDisabled();
  await expect(page.getByText("アーカイブ済みのためコメントできません")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "コメント" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "返信" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "解決" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Documentを追加" })).toBeDisabled();
  await expect(page.getByText("me がアーカイブした")).toBeVisible();
  expect((await api.show(target.id)).archivedAt).not.toBeNull();

  // 既定の一覧からは消え、「アーカイブ済みのみ」で出る
  await page.goto("/issues");
  await expect(page.getByText(keep.title)).toBeVisible();
  await expect(page.getByText(target.title)).toHaveCount(0);
  await page.getByRole("combobox", { name: "アーカイブ" }).selectOption({ label: "アーカイブ済みのみ" });
  await expect(page).toHaveURL(/archived=true/);
  await expect(page.getByRole("group", { name: "絞り込み条件" })).toContainText("アーカイブisアーカイブ済みのみ");
  await expect(page.getByText(target.title)).toBeVisible();
  await expect(page.getByText(keep.title)).toHaveCount(0);

  // URL から同じ絞り込みを復元できる
  await page.reload();
  await expect(page.getByRole("combobox", { name: "アーカイブ" })).toHaveValue("only");
  await expect(page.getByText(target.title)).toBeVisible();

  // バナーの「復元」で戻す
  await page.getByText(target.title).click();
  await expect(page).toHaveURL(new RegExp(`/issues/${target.id}`));
  await page.getByRole("region", { name: "アーカイブ済み" }).getByRole("button", { name: "復元" }).click();
  await expect(page.getByRole("region", { name: "アーカイブ済み" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "コメント" })).toBeVisible();
  await expect(page.getByRole("button", { name: "返信" })).toBeEnabled();
  await expect(page.getByText("me がアーカイブから復元した")).toBeVisible();
  expect((await api.show(target.id)).archivedAt).toBeNull();

  await page.goto("/issues");
  await expect(page.getByText(target.title)).toBeVisible();
});

test("アーカイブ済みIssueのメニューは「復元」になり、選ぶと元に戻る", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "メニューから復元" });
  await nod.me.archiveIssue(issue.id);
  await page.goto(`/issues/${issue.id}`);
  await page.getByRole("button", { name: "Issueのメニュー", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Issueの操作" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Issue IDをコピー", "コマンドをコピー", "Issueを複製", "復元", "完全に削除"]);
  await menu.getByRole("menuitem", { name: "復元" }).click();
  await expect(page.getByRole("region", { name: "アーカイブ済み" })).toHaveCount(0);
  expect((await api.show(issue.id)).archivedAt).toBeNull();
});

test.describe("アーカイブに失敗したとき", () => {
  test.use({ allowedConsoleErrors: [/status of 500/] });

  test("メニューを開いたまま理由を出し、Issueは変わらない", async ({ page, nod }) => {
    const api = await seedApiWorkspace(nod);
    const issue = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "失敗するアーカイブ" });
    await page.route(`**/api/issues/${issue.id}/archive`, (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL", message: "書き込めません" } }) }));
    await page.goto(`/issues/${issue.id}`);
    await page.getByRole("button", { name: "Issueのメニュー", exact: true }).click();
    const menu = page.getByRole("menu", { name: "Issueの操作" });
    await menu.getByRole("menuitem", { name: "アーカイブ" }).click();
    await expect(menu.getByRole("alert")).toHaveText("アーカイブできませんでした：書き込めません");
    await expect(page.getByRole("region", { name: "アーカイブ済み" })).toHaveCount(0);
    expect((await api.show(issue.id)).archivedAt).toBeNull();
  });
});

test("Document の関連 Issue では、アーカイブ済みの Issue に印を付け、リンクを解除できない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const live = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "生きている Issue" });
  const gone = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "アーカイブした Issue" });
  const path = nod.writeFile("docs/archived-links.md", "# リンク先の確認");
  const doc = await nod.me.attachDocument({ issueRef: live.id }, { path });
  await nod.me.attachDocument({ issueRef: gone.id }, { path });
  await nod.me.archiveIssue(gone.id);

  await page.goto(`/documents/${doc.id}`);
  const links = page.getByRole("region", { name: "関連 Issue" });
  const goneRow = links.getByRole("listitem").filter({ hasText: gone.title });
  await expect(goneRow.getByText("アーカイブ済み")).toBeVisible();
  await expect(links.getByRole("button", { name: `${gone.id} のリンクを解除` })).toBeDisabled();
  const liveRow = links.getByRole("listitem").filter({ hasText: live.title });
  await expect(liveRow.getByText("アーカイブ済み")).toHaveCount(0);
  await expect(links.getByRole("button", { name: `${live.id} のリンクを解除` })).toBeEnabled();
});
