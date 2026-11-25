import { expect, test } from "./fixtures";
import type { SprintPlanResult } from "@nod/core";
import { legacySprintClosure } from "./support/nod";
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
  await dialog.getByRole("textbox", { name: "終了理由", exact: true }).fill("予定期間が終了し、残件を確認したため");
  await dialog.getByRole("button", { name: "終了を記録する", exact: true }).click();
  await expect(dialog).toBeHidden();
  const record = page.getByRole("region", { name: "終了時の記録", exact: true });
  await expect(record).toContainText("予定期間が終了し、残件を確認したため");
  await expect(record).toContainText("記録者：利用者本人（me）");
  const overview = page.getByRole("region", { name: "Sprint の概要" });
  await overview.getByRole("link", { name: /Sprint 2「/ }).click();
  await expect(overview).toContainText("自動処理（nod-automation）");
  await page.goto(`/sprints/${planned.sprint.id}`);
  await expect(record.getByRole("link", { name: `${issue.id}の現在のIssue`, exact: true })).toBeVisible();
  await nod.me.updateIssue(issue.id, { status: "done" });
  await page.reload();
  await expect(record).toContainText("未完了Issue（1件）");
  await record.getByRole("link", { name: `${issue.id}の現在のIssue`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/issues/${issue.id}$`));
});

test("Webで中止し、旧版の中止記録も記録者付きで表示する", async ({ page, nod }) => {
  const ws = (await nod.me.initWorkspace({ key: "CAN", name: "中止記録", path: nod.repo("cancel") })).workspace;
  const { sprint } = await plannedSprint(page, ws.key, []);
  await page.goto(`/sprints/${sprint.id}`);
  await page.getByRole("button", { name: "Sprintを中止", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Sprintを中止", exact: true });
  await dialog.getByRole("textbox", { name: "中止理由" }).fill("優先順位の変更");
  await dialog.getByRole("button", { name: "中止する", exact: true }).click();
  await expect(dialog).toBeHidden();
  const record = page.getByRole("region", { name: "中止時の記録", exact: true });
  await expect(record).toContainText("記録者：利用者本人（me）");
  await legacySprintClosure(sprint.id);
  await page.reload();
  await expect(record).toContainText("記録者：記録なし");
});

for (const operation of ["終了", "中止"] as const) {
  test(`WebはLLMが${operation}したSprintの記録者を表示する`, async ({ page, nod }) => {
    const ws = (await nod.me.initWorkspace({ key: "AGT", name: "エージェントの記録", path: nod.repo("agent-closure") })).workspace;
    const planned = await plannedSprint(page, ws.key, [], { startDate: todayUtc(-2), endDate: todayUtc(-1) });
    const ready = await nod.me.acceptSprintPlan(planned.sprint.id, planned.plan.id, { expectedVersion: planned.sprint.version, requestKey: "合意", contentHash: planned.plan.contentHash });
    const sprint = await nod.me.activateSprint(ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, { now: new Date(`${todayUtc(-2)}T12:00:00.000Z`) });
    const input = { expectedVersion: sprint.version, requestKey: operation, reason: "作業を区切るため" };
    if (operation === "終了") await nod.codex.endSprint(sprint.id, input);
    else await nod.codex.cancelSprint(sprint.id, input);
    await page.goto(`/sprints/${sprint.id}`);
    await expect(page.getByRole("region", { name: `${operation}時の記録`, exact: true })).toContainText("記録者：エージェント（codex）");
  });
}

test("成果と評価に利用者本人とLLMが記録した感想を記録者付きで並べる", async ({ page, nod }) => {
  const ws = (await nod.me.initWorkspace({ key: "FDB", name: "感想の記録", path: nod.repo("feedback") })).workspace;
  const issue = await nod.me.createIssue({ workspaceId: ws.id, title: "感想を確認する成果" });
  const planned = await plannedSprint(page, ws.key, [issue.id]);
  const ready = await sprintApi<SprintPlanResult>(page, "POST", `/sprints/${planned.sprint.id}/plans/${planned.plan.id}/accept`, { expectedVersion: planned.sprint.version, requestKey: "感想用の合意", contentHash: planned.plan.contentHash });
  await nod.me.activateSprint(ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "感想用の開始" });
  await nod.codex.addSprintRecord(ready.sprint.id, { requestKey: "聞き取った感想", kind: "feedback", content: { helpful: "利用者から聞いた、試し方が分かりやすいという感想", difficulties: "記録を探しにくい", requests: "検索したい" } });
  await page.goto(`/sprints/${ready.sprint.id}?section=outcomes`);
  const agent = page.getByRole("region", { name: "利用者の感想の記録", exact: true }).filter({ hasText: "利用者から聞いた、試し方が分かりやすいという感想" });
  await expect(agent).toContainText("記録者：エージェント（codex）");
  await expect(agent).toContainText("記録を探しにくい");
  await expect(agent).toContainText("検索したい");
  const form = page.getByRole("form", { name: "感想を追記" });
  await form.getByRole("textbox", { name: "役立った点" }).fill("自分で試して再確認しやすかった");
  await form.getByRole("button", { name: "感想を記録する", exact: true }).click();
  await expect(form.getByRole("status")).toHaveText("感想を記録しました。");
  const records = page.getByRole("region", { name: "利用者の感想の記録", exact: true });
  await expect(records).toHaveCount(2);
  await expect(records.filter({ hasText: "自分で試して再確認しやすかった" })).toContainText("記録者：利用者本人（me）");
  await expect(agent).toBeVisible();
  await page.reload();
  await expect(records).toHaveCount(2);
  await expect(agent).toContainText("記録者：エージェント（codex）");
  await expect(records.filter({ hasText: "自分で試して再確認しやすかった" })).toContainText("記録者：利用者本人（me）");
  await page.screenshot({ path: test.info().outputPath("feedback-recorders.png"), fullPage: true });
});
