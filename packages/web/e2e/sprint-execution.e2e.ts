import type { SprintNotificationState, SprintPlanResult } from "@nod/core";
import { expect, test, waitForServerEvents } from "./fixtures";
import { acceptAndActivate, captureSprint, plannedSprint, sprintApi } from "./support/sprint-planning";
import { CONTROL_PORT } from "./support/ports";
import type { Page } from "@playwright/test";

async function execute(page: Page, sprintId: string, action: "stale" | "unknown" | "unavailable" | "complete") {
  const response = await page.request.post(`http://127.0.0.1:${CONTROL_PORT}/sprint-execution`, { data: { sprintId, action } });
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as SprintNotificationState;
}

test("保存した監督・予約と古い観測を保ち、三種の設定と取得不能、完全なCLI手順を確認する", async ({ page, nod }, info) => {
  const ws = (await nod.me.initWorkspace({ key: "EX", name: "監督表示", path: nod.repo("execution") })).workspace;
  const issue = await nod.me.createIssue({ workspaceId: ws.id, title: "監督を確認する仕事" });
  const planned = await plannedSprint(page, ws.key, [issue.id]);
  const configured = await sprintApi<SprintPlanResult>(page, "POST", `/sprints/${planned.sprint.id}/plans`, {
    ...planned.input, expectedVersion: planned.sprint.version, requestKey: crypto.randomUUID(),
    constraints: { ...planned.input.constraints, maxParallel: 1, model: "required-model", effort: "high", executionTarget: "fixture-host" },
  });
  const sprint = await acceptAndActivate(page, configured);
  const fixture = await execute(page, sprint.id, "stale");
  await page.goto(`/sprints/${sprint.id}`);
  const supervision = page.getByRole("region", { name: "監督と実行", exact: true });
  await expect(supervision).toContainText("codex（監督を所有、世代1）");
  await expect(supervision).toContainText("占有 1 / 上限 1（主試行の予約 1");
  await expect(supervision).toContainText("観測が古いため、現在の監督状態は不明");
  await expect(supervision).toContainText("HOST_SETTINGS_MISMATCH");
  // 技術IDは閉じた詳細に置く。
  await expect(supervision.getByText(/監督端末：/)).toBeHidden();
  await captureSprint(page, "task4-overview-stale-reserved", info);
  await supervision.getByText("実行の詳細・再照合手順", { exact: true }).click();
  const command = supervision.getByLabel("実行できるCLI手順");
  await expect(command).toHaveText(fixture.execution.nextActions[0]!.command);
  await expect(command).toContainText("NOD_ACTOR='codex'");
  await expect(command).toContainText("'--input' '-' '--from'");
  await expect(command).toContainText(JSON.stringify({ sessionId: fixture.execution.session!.id, generation: 1 }));
  await supervision.getByText(`${issue.id} 主担当 codexの根拠`, { exact: true }).click();
  await expect(supervision).toContainText("要求した設定：codex / model：required-model / effort：high");
  await expect(supervision).toContainText("起動receiptのeffective：codex / receipt-model / medium");
  await expect(supervision).toContainText("ホスト観測の設定：model host-model / effort low");
  await expect(supervision).toContainText("設定適用日時：");
  await expect(supervision).toContainText("採取日時：");
  await expect(supervision).toContainText("Orca観測日時：");
  await expect(supervision).toContainText("PM照合日時：");
  await captureSprint(page, "task4-settings-three-sources-procedure", info);
  await execute(page, sprint.id, "unknown");
  await supervision.getByRole("button", { name: "保存状態を再取得", exact: true }).click();
  await expect(supervision).toContainText("実行を確認できません。所有と枠を保持しています");
  await expect(supervision).toContainText("占有 1 / 上限 1");
  await execute(page, sprint.id, "unavailable");
  await supervision.getByRole("button", { name: "保存状態を再取得", exact: true }).click();
  await expect(supervision).toContainText("ホスト観測の設定：model 取得不能 / effort 取得不能");
  await expect(supervision).toContainText("起動receiptのeffective：codex / receipt-model / medium");
  await captureSprint(page, "task4-host-unavailable-held", info);
  const completed = await execute(page, sprint.id, "complete");
  expect(completed.execution).toMatchObject({ occupied: 1, reserved: 1, attempts: [{ phase: "completed" }] });
  await supervision.getByRole("button", { name: "保存状態を再取得", exact: true }).click();
  await expect(supervision).toContainText("正規解放確認済み");
  await expect(supervision).toContainText("担当終了確認・成果確認待ち");
  await expect(supervision).toContainText("占有 1 / 上限 1");
  expect((await sprintApi<{ status: string }>(page, "GET", `/issues/${issue.id}`)).status).toBe("todo");
  await captureSprint(page, "task4-completion-release-held", info);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(`tr[data-issue-row="${issue.id}"]`)).toBeVisible();
  await captureSprint(page, "task4-narrow-overview", info);
});

test.describe("保存状態の取得失敗", () => {
  test.use({ allowedConsoleErrors: [/status of 503/] });
  test("初回失敗を0件と区別し、再取得失敗は最後の監督と時刻を残して再試行できる", async ({ page, nod }, info) => {
    const ws = (await nod.me.initWorkspace({ key: "RE", name: "再取得", path: nod.repo("refresh") })).workspace;
    const issue = await nod.me.createIssue({ workspaceId: ws.id, title: "再取得の仕事" });
    const planned = await plannedSprint(page, ws.key, [issue.id]);
    const sprint = await acceptAndActivate(page, planned);
    const path = `**/api/sprints/${sprint.id}/execution`;
    let failures = 0, finishFailure!: () => void;
    let failed = new Promise<void>(resolve => { finishFailure = resolve; });
    const failure = async (route: import("@playwright/test").Route) => {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL", message: "保存状態を読み取れません" } }) });
      if (++failures % 4 === 0) finishFailure(); // 既存Queryの初回+3回の再試行を実際に観測する。
    };
    await page.route(path, failure);
    await page.goto(`/sprints/${sprint.id}`);
    const supervision = page.getByRole("region", { name: "監督と実行", exact: true });
    await failed;
    await expect(supervision.getByRole("alert")).toContainText("0件とは判定できません");
    await captureSprint(page, "task4-initial-read-failed", info);
    await page.unroute(path, failure);
    await supervision.getByRole("button", { name: "保存状態を再取得", exact: true }).click();
    await expect(supervision).toContainText("記録なし。実際のPM・workerの存在は未確認");
    await expect(supervision).toContainText("既存の計画と元Runを確認");
    await execute(page, sprint.id, "stale");
    await supervision.getByRole("button", { name: "保存状態を再取得", exact: true }).click();
    await expect(supervision).toContainText("codex（監督を所有");
    const previous = await supervision.locator("p").filter({ hasText: /^保存状態の取得時刻：/ }).locator("time").getAttribute("datetime");
    failed = new Promise<void>(resolve => { finishFailure = resolve; });
    await page.route(path, failure);
    await supervision.getByRole("button", { name: "保存状態を再取得", exact: true }).click();
    await failed;
    await expect(supervision.getByRole("alert")).toContainText("最後に取得した状態を表示");
    await expect(supervision).toContainText("codex（監督を所有");
    await expect(supervision).toContainText("占有 1 / 上限 2");
    await expect(supervision.locator("time").first()).toHaveAttribute("datetime", previous!);
    await captureSprint(page, "task4-refresh-failed-retained", info);
    await page.unroute(path, failure);
    await supervision.getByRole("button", { name: "保存状態を再取得", exact: true }).click();
    await expect(supervision.getByRole("alert")).toHaveCount(0);
  });
});

test("表示中は30秒で再取得し、非表示中は止めて復帰時に保存状態を取り直す", async ({ page, nod }) => {
  const ws = (await nod.me.initWorkspace({ key: "PO", name: "鮮度", path: nod.repo("poll") })).workspace;
  const issue = await nod.me.createIssue({ workspaceId: ws.id, title: "鮮度の仕事" });
  const planned = await plannedSprint(page, ws.key, [issue.id]);
  const sprint = await acceptAndActivate(page, planned);
  let reads = 0;
  page.on("request", request => { if (new URL(request.url()).pathname === `/api/sprints/${sprint.id}/execution`) reads++; });
  await page.goto(`/sprints/${sprint.id}`);
  await expect(page.getByRole("region", { name: "監督と実行", exact: true })).toContainText("記録なし");
  await waitForServerEvents(page);
  await page.clock.install();
  const before = reads;
  await page.clock.fastForward(31_000);
  await expect.poll(() => reads).toBeGreaterThan(before);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
  const hidden = reads;
  await page.clock.fastForward(61_000);
  expect(reads).toBe(hidden);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect.poll(() => reads).toBeGreaterThan(hidden);
});
