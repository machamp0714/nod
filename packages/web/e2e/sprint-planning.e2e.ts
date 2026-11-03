import { expect, test } from "./fixtures";

test("方向設定とSprint作成の公開フォームから、公開HTTPで提案した計画の版に合意して開始する", async ({ page, nod }, info) => {
  const ws = await nod.me.initWorkspace({ key: "AAA", name: "製品A", path: nod.repo("a") });
  const issue = await nod.me.createIssue({ workspaceId: ws.workspace.id, title: "判断を一か所で確認" });
  await page.goto("/workspaces/AAA/settings");
  const direction = page.getByRole("region", { name: "Sprintの方向設定", exact: true });
  await expect(direction).toBeVisible();
  await direction.getByLabel("解決したい問題").fill("判断が散在する");
  await direction.getByLabel("プロダクトの目標").fill("判断を一か所で確認できる");
  await direction.getByLabel("優先順位の根拠").fill("待ち時間を減らす");
  await direction.getByLabel("Sprint運用を有効にする").check();
  await direction.getByRole("button", { name: "方向設定を保存" }).click();
  await expect(direction.getByRole("status")).toContainText("保存しました");
  await captureSprint(page, "workspace-direction-saved", info);
  await page.goto("/sprints");
  await page.getByRole("button", { name: "Sprintを作成", exact: true }).click();
  const create = page.getByRole("dialog", { name: "Sprintを作成" });
  await create.getByLabel("Workspace", { exact: true }).selectOption("AAA");
  const today = new Date().toISOString().slice(0, 10);
  await create.getByLabel("開始日", { exact: true }).fill(today);
  await create.getByLabel("終了日", { exact: true }).fill(today);
  await create.getByLabel("タイムゾーン", { exact: true }).fill("UTC");
  await captureSprint(page, "sprint-create-period-timezone", info);
  await create.getByRole("button", { name: "作成", exact: true }).click();
  await expect(page).toHaveURL(/\/sprints\/[^/]+$/);
  const sprintId = new URL(page.url()).pathname.split("/").at(-1)!;
  const created = await sprintDetail(page, sprintId);
  const candidate = await sprintApi<{ sprint: Sprint; item: { id: string } }>(page, "POST", `/sprints/${sprintId}/candidates`, { expectedVersion: created.version, requestKey: crypto.randomUUID(), issueRef: issue.id });
  await sprintApi<SprintPlanResult>(page, "POST", `/sprints/${sprintId}/plans`, { expectedVersion: candidate.sprint.version, requestKey: crypto.randomUUID(),
    goal: "判断の確認を完結できる", verificationMethod: "判断の発見から回答まで操作する", items: [{ itemId: candidate.item.id, contribution: "判断を発見できる", executionPlan: "一覧を実装して操作を確認" }],
    definitionOfDone: [{ id: "確認", text: "判断から回答まで確認できる" }], constraints: { executionScope: "製品A", maxParallel: 1, notes: "公開は既存の権限に従う" }, changeReason: "初回の計画" });
  await page.goto(`/sprints/${sprintId}?section=plan`);
  await expect(page.getByRole("region", { name: "表示中の計画" })).toContainText("計画 第1版");
  await captureSprint(page, "plan-before-start-list", info);
  await page.getByRole("button", { name: "この計画に合意する", exact: true }).click();
  await expect(page.getByRole("region", { name: "表示中の計画" }).getByText("第1版に合意済み", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Sprintを開始する", exact: true }).click();
  await expect(page.getByText("Sprintを開始しました。監督・workerの状態は保存された実行記録で確認してください。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "タスク一覧", exact: true }).click();
  await expect(page.locator(`tr[data-issue-row="${issue.id}"]`)).toBeVisible();
  await expect(page.getByRole("region", { name: "Sprint の記録" })).toContainText("判断できない");
  await captureSprint(page, "sprint-home-overview", info);
});

import type { Sprint, SprintPlanResult } from "@nod/core";
import { acceptAndActivate, captureSprint, plannedSprint, sprintApi, sprintDetail, todayUtc } from "./support/sprint-planning";

test("開始条件はserverの期間と版に従い、開始前・期限外の合意済み計画を開始できない", async ({ page, nod }, info) => {
  const ws = (await nod.me.initWorkspace({ key: "AA", name: "期間確認", path: nod.repo("period") })).workspace;
  const issue = await nod.me.createIssue({ workspaceId: ws.id, title: "期間を確認" });
  for (const [offset, message] of [[2, "Sprintの開始期間前です"], [-2, "Sprintの期間は終了しています"]] as const) {
    const planned = await plannedSprint(page, ws.key, [issue.id], { startDate: todayUtc(offset), endDate: todayUtc(offset), name: `期間${offset}` });
    await sprintApi<SprintPlanResult>(page, "POST", `/sprints/${planned.sprint.id}/plans/${planned.plan.id}/accept`, { expectedVersion: planned.sprint.version, requestKey: crypto.randomUUID(), contentHash: planned.plan.contentHash });
    await page.goto(`/sprints/${planned.sprint.id}?section=plan`);
    await expect(page.getByRole("region", { name: "開始条件", exact: true })).toContainText(message);
    await expect(page.getByRole("button", { name: "Sprintを開始する", exact: true })).toBeDisabled();
    await captureSprint(page, offset > 0 ? "start-too-early" : "start-expired", info);
  }
});

test("開始後の計画画面は採択集合の説明と貢献・実行計画の一覧を出さず、計画の要約とタスク一覧を保つ", async ({ page, nod }, info) => {
  const ws = (await nod.me.initWorkspace({ key: "RM", name: "撤去確認", path: nod.repo("removed") })).workspace;
  const issue = await nod.me.createIssue({ workspaceId: ws.id, title: "採択の仕事" });
  const planned = await plannedSprint(page, ws.key, [issue.id]);
  await acceptAndActivate(page, planned);
  await page.goto(`/sprints/${planned.sprint.id}?section=plan`);
  await expect(page.getByRole("region", { name: "表示中の計画", exact: true })).toContainText(planned.input.goal);
  await expect(page.getByText("有効な合意済み計画の採択集合を表示します。未合意の追加案は含みません。", { exact: true })).toHaveCount(0);
  await expect(page.getByText(`${issue.id}の貢献と実行計画`, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "計画案を編集", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("候補に追加するIssue", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "候補に追加", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "表示中の計画", exact: true })).toContainText(planned.input.goal);
  await expect(page.getByRole("heading", { name: "開始後の状態", exact: true })).toBeVisible();
  expect(await page.locator("main section").evaluateAll(sections => sections.filter(section => !section.textContent?.trim()).length)).toBe(0);
  await expect(page.locator(`tr[data-issue-row="${issue.id}"]`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "計画の版と合意の記録", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: /^過去の計画/ })).toHaveCount(0);
  await captureSprint(page, "plan-active-without-removed-sections", info);
});

test("開始前の計画画面は計画案の編集と候補の追加を出さず、期間の編集と合意・開始を保つ", async ({ page, nod }, info) => {
  const ws = (await nod.me.initWorkspace({ key: "RB", name: "開始前の撤去確認", path: nod.repo("removed-before") })).workspace;
  const issue = await nod.me.createIssue({ workspaceId: ws.id, title: "採択予定の仕事" });
  const planned = await plannedSprint(page, ws.key, [issue.id]);
  await page.goto(`/sprints/${planned.sprint.id}?section=plan`);
  await expect(page.getByRole("region", { name: "表示中の計画", exact: true })).toContainText(planned.input.goal);
  await expect(page.getByText("採択予定・開始前。合意して開始するまでは実行されません。", { exact: true })).toHaveCount(0);
  await expect(page.getByText(`${issue.id}の貢献と実行計画`, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "計画案を編集", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("候補に追加するIssue", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "候補に追加", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "期間を編集", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "この計画に合意する", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "開始条件", exact: true })).toBeVisible();
  expect(await page.locator("main section").evaluateAll(sections => sections.filter(section => !section.textContent?.trim()).length)).toBe(0);
  await expect(page.locator(`tr[data-issue-row="${issue.id}"]`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "計画の版と合意の記録", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: /^過去の計画/ })).toHaveCount(0);
  await captureSprint(page, "plan-before-start-without-removed-sections", info);
});

test("同じ内容の合意を再利用し、変更案へ旧合意を適用せず、開始後の期間は固定して人が中止理由を残す", async ({ page, nod }, info) => {
  const ws = (await nod.me.initWorkspace({ key: "AA", name: "合意確認", path: nod.repo("agreement") })).workspace;
  const issue = await nod.me.createIssue({ workspaceId: ws.id, title: "採択" });
  const planned = await plannedSprint(page, ws.key, [issue.id]);
  const ready = await sprintApi<SprintPlanResult>(page, "POST", `/sprints/${planned.sprint.id}/plans/${planned.plan.id}/accept`, { expectedVersion: planned.sprint.version, requestKey: crypto.randomUUID(), contentHash: planned.plan.contentHash });
  const same = await sprintApi<SprintPlanResult>(page, "POST", `/sprints/${ready.sprint.id}/plans`, { expectedVersion: ready.sprint.version, requestKey: crypto.randomUUID(), ...planned.input, changeReason: "同じ条件を再提案" });
  expect(same.plan.agreedAt).toBe(ready.plan.agreedAt);
  await page.goto(`/sprints/${planned.sprint.id}?section=plan`);
  await expect(page.getByRole("region", { name: "表示中の計画", exact: true })).toContainText("第2版に合意済み");
  await expect(page.getByRole("button", { name: "この計画に合意する", exact: true })).toHaveCount(0);
  const changed = await sprintApi<SprintPlanResult>(page, "POST", `/sprints/${ready.sprint.id}/plans`, { expectedVersion: same.sprint.version, requestKey: crypto.randomUUID(), ...planned.input, goal: "変更したゴール", changeReason: "ゴールを変更" });
  expect(changed.plan.agreedAt).toBeNull();
  await page.reload();
  await expect(page.getByRole("region", { name: "表示中の計画", exact: true })).toContainText("未合意");
  await expect(page.getByRole("button", { name: "Sprintを開始する", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "この計画に合意する", exact: true }).click();
  await page.getByRole("button", { name: "Sprintを開始する", exact: true }).click();
  await page.getByRole("button", { name: "タスク一覧", exact: true }).click();
  await page.getByRole("button", { name: "計画", exact: true }).click();
  await expect(page.getByRole("button", { name: "期間を編集", exact: true })).toHaveCount(0);
  await captureSprint(page, "plan-agreed-active", info);
  await page.getByRole("button", { name: "タスク一覧", exact: true }).click();
  await page.getByRole("button", { name: "Sprintを中止", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Sprintを中止" });
  await dialog.getByLabel("中止理由", { exact: true }).fill("優先順位を変える");
  await dialog.getByRole("button", { name: "中止する", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("region", { name: "Sprint の記録" })).toContainText("優先順位を変える");
  expect((await sprintDetail(page, planned.sprint.id)).phase).toBe("canceled");
});

test.describe("共通IssueList", () => {
  test.use({ allowedConsoleErrors: [/status of 409/] });
  test("Sprintの44px行・検索・Filter・Display・プレビュー・一括操作を維持し、管理中Issueへの一括着手を拒否する", async ({ page, nod }, info) => {
    const ws = (await nod.me.initWorkspace({ key: "LI", name: "一覧確認", path: nod.repo("list") })).workspace;
    const first = await nod.me.createIssue({ workspaceId: ws.id, title: "一覧の対象その一" });
    const second = await nod.me.createIssue({ workspaceId: ws.id, title: "一覧の対象その二" });
    const planned = await plannedSprint(page, ws.key, [first.id, second.id]);
    await sprintApi(page, "POST", `/sprints/${planned.sprint.id}/plans/${planned.plan.id}/accept`, { expectedVersion: planned.sprint.version, requestKey: crypto.randomUUID(), contentHash: planned.plan.contentHash });
    await page.goto(`/sprints/${planned.sprint.id}`);
    await expect(page.locator("tr[data-issue-row]")).toHaveCount(2);
    const row = page.locator(`tr[data-issue-row="${first.id}"]`);
    expect((await row.boundingBox())!.height).toBe(44);
    await page.getByRole("button", { name: "検索を開く", exact: true }).click();
    await page.getByRole("textbox", { name: "検索", exact: true }).fill("その一");
    await expect(page.locator("tr[data-issue-row]")).toHaveCount(1);
    await page.getByRole("textbox", { name: "検索", exact: true }).fill("");
    await page.getByRole("combobox", { name: "ブロック", exact: true }).selectOption("false");
    await expect(page.locator("tr[data-issue-row]")).toHaveCount(2);
    await page.getByRole("button", { name: "表示設定", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "表示設定", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "表示設定", exact: true }).click();
    await row.hover();
    await row.getByRole("button", { name: `${first.id} をプレビュー`, exact: true }).click();
    await expect(page.getByRole("button", { name: "プレビューを閉じる", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "プレビューを閉じる", exact: true }).click();
    await row.getByRole("checkbox", { name: `${first.id} を選択`, exact: true }).check();
    await page.locator(`tr[data-issue-row="${second.id}"]`).getByRole("checkbox", { name: `${second.id} を選択`, exact: true }).check();
    const bulk = page.getByRole("toolbar", { name: "一括操作", exact: true });
    await bulk.getByRole("button", { name: "Status", exact: true }).click();
    await page.getByRole("menu", { name: "Status を変更", exact: true }).getByRole("menuitem", { name: "In Progress", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("何も変更していません");
    expect((await nod.me.getIssue(first.id)).status).toBe("todo"); expect((await nod.me.getIssue(second.id)).status).toBe("todo");
    await captureSprint(page, "issue-list-bulk-start-protected", info);
  });
});

test.describe("方向設定の版競合", () => {
  test.use({ allowedConsoleErrors: [/status of 409/] });
  test("編集中に他の保存が入ると版競合を示し、入力を保持して最新の保存内容を確認して再試行する", async ({ page, nod }) => {
    const ws = (await nod.me.initWorkspace({ key: "VE", name: "版の確認", path: nod.repo("version") })).workspace;
    await page.goto(`/workspaces/${ws.key}/settings`);
    const direction = page.getByRole("region", { name: "Sprintの方向設定", exact: true });
    await direction.getByLabel("解決したい問題").fill("編集中の問題");
    await direction.getByLabel("プロダクトの目標").fill("編集中の目標");
    await direction.getByLabel("優先順位の根拠").fill("編集中の優先順位");
    await sprintApi(page, "PUT", `/workspaces/${ws.key}/scrum`, { expectedVersion: 0, requestKey: crypto.randomUUID(), enabled: true, problem: "別の保存", productGoal: "別の目標", priorityRationale: "別の根拠" });
    await direction.getByRole("button", { name: "方向設定を保存", exact: true }).click();
    await expect(direction.getByRole("alert")).toContainText("版が更新されています");
    await expect(direction.getByText("最新の保存内容", { exact: true })).toBeVisible();
    await expect(direction.getByLabel("解決したい問題")).toHaveValue("編集中の問題");
    await direction.getByRole("button", { name: "最新の版を確認して入力を維持", exact: true }).click();
    await direction.getByRole("button", { name: "方向設定を保存", exact: true }).click();
    await expect(direction.getByRole("status")).toContainText("保存しました");
    expect(await sprintApi(page, "GET", `/workspaces/${ws.key}/scrum`)).toMatchObject({ problem: "編集中の問題", version: 2 });
  });
});
