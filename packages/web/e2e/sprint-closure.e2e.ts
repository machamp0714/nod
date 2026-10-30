import { expect, test } from "./fixtures";
import type { SprintPlanResult } from "@nod/core";
import { plannedSprint, sprintApi, todayUtc } from "./support/sprint-planning";

test("期限超過のSprintを理由付きで終了し、終了時の記録と現在のIssueを確認する", async ({ page, nod }) => {
  const ws = (await nod.me.initWorkspace({ key: "END", name: "終了記録", path: nod.repo("closure") })).workspace;
  const issue = await nod.me.createIssue({ workspaceId: ws.id, title: "終了時に残った要求" });
  const planned = await plannedSprint(page, ws.key, [issue.id], { startDate: todayUtc(-2), endDate: todayUtc(-1) });
  const ready = await sprintApi<SprintPlanResult>(page, "POST", `/sprints/${planned.sprint.id}/plans/${planned.plan.id}/accept`, { expectedVersion: planned.sprint.version, requestKey: "画面用の合意", contentHash: planned.plan.contentHash });
  // 固定時計で期間内に開始し、画面は実時計で期限後の操作を確かめる。
  await nod.me.activateSprint(ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "画面用の開始" }, { now: new Date(`${todayUtc(-2)}T12:00:00.000Z`) });
  await page.goto(`/sprints/${planned.sprint.id}`);
  await expect(page.getByRole("status").filter({ hasText: "期限超過、終了の記録待ち" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Sprint の概要" })).toContainText("UTC");
  await page.getByRole("button", { name: "Sprintを終了", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Sprintを終了", exact: true });
  await dialog.getByLabel("終了理由", { exact: true }).fill("予定期間の終了");
  await dialog.getByRole("button", { name: "終了を記録する", exact: true }).click();
  await expect(dialog).toBeHidden();
  const record = page.getByRole("region", { name: "終了時の記録", exact: true });
  await expect(record).toContainText("予定期間の終了");
  await expect(record.getByRole("link", { name: `${issue.id}の現在のIssue`, exact: true })).toBeVisible();
  await nod.me.updateIssue(issue.id, { status: "done" });
  await page.reload();
  await expect(record).toContainText("未完了Issue（1件）");
  await record.getByRole("link", { name: `${issue.id}の現在のIssue`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/issues/${issue.id}$`));
});
