import { expect, test } from "./fixtures";
import { legacySprintActivation } from "./support/nod";
import { plannedSprint } from "./support/sprint-planning";

test("Sprintの概要は開始してから開始日時と開始者を表示する", async ({ page, nod }) => {
  const { workspace } = await nod.me.initWorkspace({ key: "ACT", name: "開始の記録", path: nod.repo("activation") });
  const issue = await nod.me.createIssue({ workspaceId: workspace.id, title: "開始者を確認" });
  const planned = await plannedSprint(page, workspace.key, [issue.id]);
  const ready = await nod.me.acceptSprintPlan(planned.sprint.id, planned.plan.id, {
    expectedVersion: planned.sprint.version, requestKey: crypto.randomUUID(), contentHash: planned.plan.contentHash,
  });
  const detailUrl = `/sprints/${ready.sprint.id}`;
  await page.goto(detailUrl);
  const overview = page.getByRole("region", { name: "Sprint の概要" });
  await expect(overview).toBeVisible();
  await expect(overview.getByText("開始", { exact: true })).toHaveCount(0);
  await expect(overview.getByText("開始者", { exact: true })).toHaveCount(0);

  const active = await nod.codex.activateSprint(ready.sprint.id, {
    expectedVersion: ready.sprint.version, requestKey: crypto.randomUUID(),
  });
  await page.reload();
  const time = overview.locator(`time[datetime="${active.activatedAt}"]`);
  await expect(time).toBeVisible();
  await expect(overview.getByText("エージェント（codex）", { exact: true })).toBeVisible();
  await expect(overview).not.toContainText("自動開始");

  await legacySprintActivation(active.id);
  await page.reload();
  await expect(time).toBeVisible();
  await expect(overview.getByText("記録なし", { exact: true })).toBeVisible();
  await expect(overview).not.toContainText("自動開始");
});
