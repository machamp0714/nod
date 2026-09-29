import { expect, test } from "./fixtures";
import { seedApiWorkspace } from "./decision-data";

test("Issueのメニューから複製すると新しいIssueへ移り、元のIssueは変わらない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const source = await nod.me.createIssue({
    workspaceId: api.workspace.id, title: "複製元の Issue", description: "複製する説明", priority: 2, labels: ["backend"],
  });
  await nod.me.commentIssue(source.id, "複製しないコメント");
  const before = await api.show(source.id);
  await page.goto(`/issues/${source.id}`);
  await page.getByRole("button", { name: "Issueのメニュー", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Issueの操作" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Issue IDをコピー", "コマンドをコピー", "Issueを複製"]);
  await menu.getByRole("menuitem", { name: "Issueを複製" }).click();
  await expect(page).toHaveURL(/\/issues\/API-2$/);
  await expect(page.getByRole("navigation", { name: "パンくず" })).toContainText("API-2");
  await expect(page.getByText("複製する説明")).toBeVisible();
  await expect(page.getByText(`me が ${source.id} から複製した`)).toBeVisible();
  await expect(page.getByText("複製しないコメント")).toHaveCount(0);
  const copied = await api.show("API-2");
  expect(copied).toMatchObject({ title: "複製元の Issue", priority: 2, labels: ["backend"], status: "todo" });
  expect(await api.show(source.id)).toEqual(before);
});

test.describe("複製に失敗したとき", () => {
  test.use({ allowedConsoleErrors: [/status of 500/] });

  test("メニューを開いたまま理由を出し、元のIssueに留まる", async ({ page, nod }) => {
    const api = await seedApiWorkspace(nod);
    const source = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "失敗する複製" });
    await page.route(`**/api/issues/${source.id}/copy`, (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL", message: "書き込めません" } }) }));
    await page.goto(`/issues/${source.id}`);
    await page.getByRole("button", { name: "Issueのメニュー", exact: true }).click();
    const menu = page.getByRole("menu", { name: "Issueの操作" });
    await menu.getByRole("menuitem", { name: "Issueを複製" }).click();
    await expect(menu.getByRole("alert")).toHaveText("複製できませんでした：書き込めません");
    await expect(page).toHaveURL(new RegExp(`/issues/${source.id}$`));
    const list = await (await page.request.get("/api/issues")).json() as { issues: { id: string }[] };
    expect(list.issues.map((i) => i.id)).toEqual([source.id]);
  });
});
