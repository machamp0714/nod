import { seedApiWorkspace } from "./decision-data";
import { expect, test, waitForServerEvents } from "./fixtures";

async function seedParent(nod: Parameters<typeof seedApiWorkspace>[0], title: string) {
  const api = await seedApiWorkspace(nod);
  const parent = await nod.me.createIssue({ workspaceId: api.workspace.id, title });
  const done = await nod.me.createIssue({ workspaceId: api.workspace.id, title: `${title}の子（完了）`, parentRef: parent.id });
  await nod.me.updateIssue(done.id, { status: "done" });
  const canceled = await nod.me.createIssue({ workspaceId: api.workspace.id, title: `${title}の子（中止）`, parentRef: parent.id });
  await nod.me.updateIssue(canceled.id, { status: "canceled" });
  return { api, parent, done, canceled };
}

test("子がすべて完了した親は一覧に完了候補ピル、詳細にバナーを出し、1操作で完了にできる", async ({ page, nod }) => {
  const { api, parent } = await seedParent(nod, "候補の親");
  const open = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "候補でない親" });
  await nod.me.createIssue({ workspaceId: api.workspace.id, title: "未完了の子", parentRef: open.id });

  await page.goto("/issues");
  const row = page.getByRole("row").filter({ hasText: "候補の親" }).filter({ hasNotText: "の子" });
  await expect(row.getByText("完了候補", { exact: true })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "候補でない親" }).getByText("完了候補", { exact: true })).toHaveCount(0);

  await page.goto(`/issues/${parent.id}`);
  await waitForServerEvents(page);
  const banner = page.getByRole("region", { name: "親の完了候補", exact: true });
  await expect(banner).toContainText("Sub-issue がすべて完了しました（完了 1・キャンセル 1）。この Issue も完了にできます");
  await expect(page.getByRole("heading", { name: "Sub-issues 1/1 · キャンセル 1" })).toBeVisible();
  await expect(banner).toHaveCSS("background-color", "rgb(226, 243, 234)");
  const description = await page.getByRole("region", { name: "説明", exact: true }).boundingBox();
  const bounds = await banner.boundingBox();
  const subIssues = await page.getByRole("region", { name: "Sub-issue", exact: true }).boundingBox();
  expect(bounds!.y).toBeGreaterThan(description!.y);
  expect(subIssues!.y).toBeGreaterThan(bounds!.y);

  await banner.getByRole("button", { name: "完了にする" }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByRole("group", { name: "状態" })).toContainText("Done");
  expect((await nod.me.getIssue(parent.id)).status).toBe("done");

  await page.goto(`/issues/${open.id}`);
  await expect(page.getByRole("heading", { level: 1, name: "候補でない親" })).toBeVisible();
  await expect(page.getByRole("region", { name: "親の完了候補", exact: true })).toHaveCount(0);
});

test.describe("失敗時", () => {
  test.use({ allowedConsoleErrors: [/status of 500/] });

  test("In Review の親は承認して完了にし、失敗時はバナーに理由を出して状態を変えない", async ({ page, nod }) => {
    const { parent } = await seedParent(nod, "レビュー中の親");
    await nod.me.updateIssue(parent.id, { status: "in_review" });
    await page.goto(`/issues/${parent.id}`);
    await waitForServerEvents(page);
    const banner = page.getByRole("region", { name: "親の完了候補", exact: true });
    const button = banner.getByRole("button", { name: "承認して完了" });

    await page.route(`**/api/issues/${parent.id}/approve`, (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "DB_BUSY", message: "書き込めません" } }) }),
    );
    await button.click();
    await expect(banner.getByRole("alert")).toContainText("完了にできませんでした：");
    await expect(banner.getByRole("alert")).toContainText("書き込めません");
    expect((await nod.me.getIssue(parent.id)).status).toBe("in_review");

    await page.unroute(`**/api/issues/${parent.id}/approve`);
    await button.click();
    await expect(banner).toHaveCount(0);
    const detail = await nod.me.getIssue(parent.id);
    expect(detail.status).toBe("done");
    expect(detail.activity.some((a: { kind: string; type?: string }) => a.kind === "event" && a.type === "review_approved")).toBe(true);
  });
});
