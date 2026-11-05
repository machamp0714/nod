import type { Page } from "@playwright/test";
import type { Sprint, SprintPlanResult } from "@nod/core";
import { expect, test } from "./fixtures";
import type { NodClient } from "./support/nod";
import { plannedSprint, sprintApi, todayUtc } from "./support/sprint-planning";

// 期限を過ぎた実行中Sprint。固定時計で期間内に人が合意・開始する。
async function expiredActive(page: Page, nod: NodClient, key: string, refs: string[]): Promise<Sprint> {
  const planned = await plannedSprint(page, key, refs, { startDate: todayUtc(-3), endDate: todayUtc(-2) });
  const ready = await sprintApi<SprintPlanResult>(page, "POST", `/sprints/${planned.sprint.id}/plans/${planned.plan.id}/accept`, { expectedVersion: planned.sprint.version, requestKey: crypto.randomUUID(), contentHash: planned.plan.contentHash });
  return nod.activateSprint(ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: crypto.randomUUID() }, { now: new Date(`${todayUtc(-3)}T12:00:00.000Z`) });
}

test("Scrum設定で自動引継ぎを切り替え、状態に次に処理する時刻・後継の予定・止まっている理由を出す", async ({ page, nod }) => {
  const ws = (await nod.me.initWorkspace({ key: "ROL", name: "引継ぎ", path: nod.repo("rollover") })).workspace;
  const issue = await nod.me.createIssue({ workspaceId: ws.id, title: "残る要求" });
  await expiredActive(page, nod.me, ws.key, [issue.id]);
  await page.goto("/workspaces/ROL/settings");
  const section = page.getByRole("region", { name: "期限到来時の自動引継ぎ", exact: true });
  const toggle = section.getByLabel("期限到来時に自動で引き継ぐ");
  const state = section.getByRole("definition");
  await expect(toggle).toBeChecked();
  await expect(state.nth(0)).toHaveText("有効");
  await expect(state.nth(1)).toContainText("次の契機");
  await expect(state.nth(2)).toHaveText(`新しいSprintを作成する（${todayUtc(-1)}〜${todayUtc(0)}、UTC）`);
  await expect(state.nth(3)).toHaveText("なし");
  await toggle.uncheck();
  await expect(state.nth(0)).toHaveText("無効");
  await expect(toggle).not.toBeChecked();
  await expect(state.nth(3)).toHaveText("期限到来時の自動引継ぎは無効に設定されています");
  await page.reload();
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(state.nth(0)).toHaveText("有効");
  // 方向設定のフォームは自動引継ぎとは別のまま
  await expect(page.getByRole("region", { name: "Sprintの方向設定", exact: true }).getByLabel("Sprint運用を有効にする")).toBeChecked();
});

test.describe("自動引継ぎの設定の保存に失敗したとき", () => {
  test.use({ allowedConsoleErrors: [/status of 409/] });
  test("理由を出して保存済みの値に戻し、再試行で保存できる", async ({ page, nod }) => {
    await nod.me.initWorkspace({ key: "RLE", name: "引継ぎ失敗", path: nod.repo("rollover-error") });
    const config = await sprintApi<{ version: number }>(page, "GET", "/workspaces/RLE/scrum");
    await sprintApi(page, "PUT", "/workspaces/RLE/scrum", { expectedVersion: config.version, requestKey: crypto.randomUUID(), enabled: true, problem: "停滞", productGoal: "進める", priorityRationale: "判断" });
    await page.route("**/api/workspaces/RLE/scrum/rollover", route => route.request().method() === "PUT"
      ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "INVALID_STATE", message: "保存の失敗を確かめる" } }) })
      : route.continue());
    await page.goto("/workspaces/RLE/settings");
    const section = page.getByRole("region", { name: "期限到来時の自動引継ぎ", exact: true });
    const toggle = section.getByLabel("期限到来時に自動で引き継ぐ");
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(section.getByRole("alert")).toContainText("自動引継ぎの設定を保存できませんでした：保存の失敗を確かめる");
    await expect(toggle).toBeChecked();
    await page.unroute("**/api/workspaces/RLE/scrum/rollover");
    await toggle.uncheck();
    await expect(section.getByRole("definition").nth(0)).toHaveText("無効");
    await expect(section.getByRole("alert")).toHaveCount(0);
  });
});

test("自動引継ぎの結果をSprint詳細の前後のつながり・自動終了・自動開始・引継ぎで入ったIssueとして出す", async ({ page, nod }) => {
  const ws = (await nod.me.initWorkspace({ key: "RLD", name: "引継ぎ詳細", path: nod.repo("rollover-detail") })).workspace;
  const open = await nod.me.createIssue({ workspaceId: ws.id, title: "引き継ぐ要求" });
  const done = await nod.me.createIssue({ workspaceId: ws.id, title: "完了した要求" });
  const previous = await expiredActive(page, nod.me, ws.key, [open.id, done.id]);
  await nod.me.updateIssue(done.id, { status: "done" });
  await page.goto(`/sprints/${previous.id}`);
  await expect(page.getByRole("status").filter({ hasText: "期限超過、終了の記録待ち" })).toBeVisible();
  // サーバーとは別の接続で自動処理を行い、SSE の change で画面へ反映させる
  const [result] = await nod.me.syncSprintRollover();
  const successor = result!.successors[0]!.sprint;
  const overview = page.getByRole("region", { name: "Sprint の概要" });
  await expect(overview.getByRole("link", { name: `Sprint ${successor.number}「${successor.name}」`, exact: true })).toBeVisible();
  const record = page.getByRole("region", { name: "終了時の記録", exact: true });
  await expect(record).toContainText("終了時の記録（自動終了）");
  await expect(record).toContainText("期間の終了時刻");
  await expect(record).toContainText("記録日時（自動処理の実行時刻）");
  await overview.getByRole("link", { name: `Sprint ${successor.number}「${successor.name}」`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sprints/${successor.id}$`));
  await expect(overview.getByRole("link", { name: `Sprint ${previous.number}「${previous.name}」`, exact: true })).toBeVisible();
  await expect(overview).toContainText("自動開始");
  const evidence = page.getByRole("region", { name: "Sprint の記録" });
  await expect(evidence).toContainText("合意: なし（自動開始。計画は後から提案・合意できます）");
  await evidence.getByText(`Sprint ${previous.number}「${previous.name}」から引き継いだIssue（1件）`).click();
  await evidence.getByRole("link", { name: open.id, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/issues/${open.id}$`));
  const properties = page.getByRole("region", { name: "プロパティ" });
  await expect(properties.getByRole("link", { name: `${previous.name}（追加）`, exact: true })).toBeVisible();
  await expect(properties.getByRole("link", { name: `${successor.name}（追加）`, exact: true })).toBeVisible();
  await page.goto(`/issues?sprint=current&columns=["status","sprint"]`);
  await expect(page.locator(`tr[data-issue-row="${open.id}"]`).locator(`[title="${successor.name}（追加）"]`)).toBeVisible();
});
