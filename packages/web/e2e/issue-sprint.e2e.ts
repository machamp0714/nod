import type { Page } from "@playwright/test";
import type { Sprint, SprintPlanResult } from "@nod/core";
import { expect, test } from "./fixtures";
import { property, propertyMenu, region } from "./helpers";
import type { NodData } from "./support/nod";
import { associateSprint, seedSprint } from "./support/nod";
import { plannedSprint, sprintApi, todayUtc } from "./support/sprint-planning";

// Issue 詳細の Sprint のピル（NOD-56）。準備は製品の公開 HTTP と e2e の fixture で行い、画面では実際のクリックだけで変える

async function enableScrum(page: Page, workspaceKey: string) {
  const config = await sprintApi<{ version: number; enabled: boolean }>(page, "GET", `/workspaces/${workspaceKey}/scrum`);
  if (config.enabled) return;
  await sprintApi(page, "PUT", `/workspaces/${workspaceKey}/scrum`, { expectedVersion: config.version, requestKey: crypto.randomUUID(), enabled: true,
    problem: "判断が散在する", productGoal: "判断を確認できる", priorityRationale: "待ち時間を減らす" });
}

// 下書きの Sprint を公開 HTTP で作る
async function draftSprint(page: Page, workspaceKey: string, name: string, startOffset: number, days = 6): Promise<Sprint> {
  await enableScrum(page, workspaceKey);
  return sprintApi<Sprint>(page, "POST", "/sprints", { expectedVersion: 0, requestKey: crypto.randomUUID(), workspaceKey, name,
    startDate: todayUtc(startOffset), endDate: todayUtc(startOffset + days), timezone: "UTC" });
}

// 計画に refs を採択して人が合意した準備完了の Sprint
async function readySprint(page: Page, workspaceKey: string, refs: string[], options: Parameters<typeof plannedSprint>[3]): Promise<Sprint> {
  const planned = await plannedSprint(page, workspaceKey, refs, options);
  const ready = await sprintApi<SprintPlanResult>(page, "POST", `/sprints/${planned.sprint.id}/plans/${planned.plan.id}/accept`,
    { expectedVersion: planned.sprint.version, requestKey: crypto.randomUUID(), contentHash: planned.plan.contentHash });
  return ready.sprint;
}

const addToSprint = (page: Page, sprintId: string, issueRef: string) => sprintApi(page, "POST", `/sprints/${sprintId}/issues`, { issueRef });

async function workspace(nod: NodData, key: string) {
  return (await nod.me.initWorkspace({ key, name: `${key} の作業`, path: nod.repo(key) })).workspace;
}

const sprintMenu = (page: Page) => propertyMenu(region(page, "プロパティ"), "Sprint");
const sprintOption = (page: Page, name: string) => sprintMenu(page).getByRole("menuitemradio", { name: new RegExp(`^${name}`) });
async function chooseSprint(page: Page, name: string) {
  await property(region(page, "プロパティ"), "Sprint").click();
  await sprintOption(page, name).click();
  await expect(sprintMenu(page)).toHaveCount(0);
}
const sprintLink = (page: Page, text: string) => region(page, "プロパティ").getByRole("link", { name: text, exact: true });

test.describe("Sprint のメニュー", () => {
  test("同じWorkspaceの開いているSprintだけを進行中・準備完了・下書きの順に並べ、状態・期間と期限超過を出す", async ({ page, nod }) => {
    const ws = await workspace(nod, "ORD");
    await workspace(nod, "OTH");
    const issue = await nod.me.createIssue({ workspaceId: ws.id, title: "Sprint を選ぶ" });
    // 期限を過ぎた進行中：固定時計で期間内に開始し、画面は実時計で見る
    const overdue = await readySprint(page, "ORD", [], { name: "期限切れ", startDate: todayUtc(-3), endDate: todayUtc(-1) });
    await nod.me.activateSprint(overdue.id, { expectedVersion: overdue.version, requestKey: crypto.randomUUID() }, { now: new Date(`${todayUtc(-2)}T12:00:00.000Z`) });
    await readySprint(page, "ORD", [], { name: "準備", startDate: todayUtc(1), endDate: todayUtc(7) });
    await draftSprint(page, "ORD", "下書き 後", 20);
    await draftSprint(page, "ORD", "下書き 先", 10);
    const canceled = await draftSprint(page, "ORD", "中止した", 30);
    await sprintApi(page, "POST", `/sprints/${canceled.id}/cancel`, { expectedVersion: canceled.version, requestKey: crypto.randomUUID(), reason: "取りやめ" });
    await draftSprint(page, "OTH", "別Workspace", 1);
    // Scrum 運用を止めても、既にある開いている Sprint は選べる
    const config = await sprintApi<{ version: number }>(page, "GET", "/workspaces/ORD/scrum");
    await sprintApi(page, "PUT", "/workspaces/ORD/scrum", { expectedVersion: config.version, requestKey: crypto.randomUUID(), enabled: false,
      problem: "判断が散在する", productGoal: "判断を確認できる", priorityRationale: "待ち時間を減らす" });

    await page.goto(`/issues/${issue.id}`);
    const props = region(page, "プロパティ");
    const pill = property(props, "Sprint");
    await expect(pill).toHaveText("なし");
    await expect(pill).toHaveAttribute("data-value", "");
    await pill.click();
    await expect(sprintMenu(page).getByRole("menuitemradio")).toHaveText([
      "なし",
      `期限切れ進行中期限超過${todayUtc(-3)} – ${todayUtc(-1)}`,
      `準備準備完了${todayUtc(1)} – ${todayUtc(7)}`,
      `下書き 先下書き${todayUtc(10)} – ${todayUtc(16)}`,
      `下書き 後下書き${todayUtc(20)} – ${todayUtc(26)}`,
    ]);
    await expect(sprintMenu(page).getByRole("menuitemradio", { name: "なし", exact: true })).toHaveAttribute("aria-checked", "true");
    for (const option of await sprintMenu(page).getByRole("menuitemradio").all()) await expect(option).toBeEnabled();
    await expect(props.getByText("選べる Sprint はありません")).toHaveCount(0);
  });
});

test.describe("Sprint の一覧の読み込み", () => {
  test.use({ allowedConsoleErrors: [/status of 400/] });

  test("Sprintが無ければ「選べる Sprint はありません」、一覧を読み込めなければそれと分かる表示を出す", async ({ page, nod }) => {
    const ws = await workspace(nod, "NON");
    const issue = await nod.me.createIssue({ workspaceId: ws.id, title: "Sprint が無い" });
    await page.goto(`/issues/${issue.id}`);
    const props = region(page, "プロパティ");
    await property(props, "Sprint").click();
    await expect(sprintMenu(page).getByRole("menuitemradio")).toHaveText(["なし"]);
    await expect(props.getByText("選べる Sprint はありません", { exact: true })).toBeVisible();

    // 読み込み中と失敗は「選べる Sprint はありません」と区別する
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/sprints", async (route) => { await gate; await route.fulfill({ status: 400, json: { error: { code: "INVALID_ARGS", message: "読めない" } } }); });
    await page.reload();
    await property(props, "Sprint").click();
    await expect(props.getByText("Sprint を読み込み中…", { exact: true })).toBeVisible();
    await expect(props.getByText("選べる Sprint はありません")).toHaveCount(0);
    release();
    await expect(props.getByText("Sprint を読み込めませんでした", { exact: true })).toBeVisible();
    await expect(props.getByText("Sprint を読み込み中…")).toHaveCount(0);
    await expect(props.getByText("選べる Sprint はありません")).toHaveCount(0);
  });
});

test.describe("Sprint の指定・変更・解除", () => {
  test("Sprintを選ぶと所属「追加」になり、別のSprintへ移し、「なし」で開いている所属だけを外す。再読込後も残りActivityに出る", async ({ page, nod }) => {
    const ws = await workspace(nod, "SEL");
    const issue = await nod.me.createIssue({ workspaceId: ws.id, title: "差し込みのタスク" });
    const history = await seedSprint({ name: "過去の期間", startDate: "2026-01-01", endDate: "2026-01-14" });
    await associateSprint(history.id, issue.id);
    // 閉じた Sprint の採択は外す対象ではないため、選べる項目を減らさない
    const closed = await readySprint(page, "SEL", [issue.id], { name: "取りやめ", startDate: todayUtc(1), endDate: todayUtc(3) });
    await sprintApi(page, "POST", `/sprints/${closed.id}/cancel`, { expectedVersion: closed.version, requestKey: crypto.randomUUID(), reason: "取りやめ" });
    const first = await draftSprint(page, "SEL", "次 A", 5);
    const second = await draftSprint(page, "SEL", "次 B", 12);

    await page.goto(`/issues/${issue.id}`);
    const props = region(page, "プロパティ");
    const pill = property(props, "Sprint");
    await expect(pill).toHaveText("なし");
    await expect(sprintLink(page, "過去の期間（移行履歴）")).toBeVisible();
    await expect(sprintLink(page, "取りやめ（追加）")).toBeVisible();
    await expect(props.getByText(/計画で採択されているため外せません/)).toHaveCount(0);
    await pill.click();
    for (const option of await sprintMenu(page).getByRole("menuitemradio").all()) await expect(option).toBeEnabled();
    await pill.click();

    // 保存中はピルを操作できない（楽観的には変えない）
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/issues/*/sprint", async (route) => { await gate; await route.continue(); }, { times: 1 });
    await chooseSprint(page, "次 A");
    await expect(pill).toBeDisabled();
    await expect(pill).toHaveText("なし");
    release();
    await expect(pill).toHaveText("次 A");
    await expect(pill).toBeEnabled();
    await expect(pill).toHaveAttribute("data-value", first.id);
    await expect(sprintLink(page, "次 A（追加）")).toBeVisible();
    await page.reload();
    await expect(pill).toHaveText("次 A");
    await expect(sprintLink(page, "次 A（追加）")).toBeVisible();
    await expect(sprintLink(page, "過去の期間（移行履歴）")).toBeVisible();
    await expect(sprintLink(page, "取りやめ（追加）")).toBeVisible();

    // 別の Sprint を選ぶと元の所属が外れる（移動）
    await chooseSprint(page, "次 B");
    await expect(pill).toHaveText("次 B");
    await expect(sprintLink(page, "次 B（追加）")).toBeVisible();
    await expect(sprintLink(page, "次 A（追加）")).toHaveCount(0);

    // 「なし」は開いている所属を外し、移行履歴と閉じた Sprint の所属は残す
    await chooseSprint(page, "なし");
    await expect(pill).toHaveText("なし");
    await expect(sprintLink(page, "次 B（追加）")).toHaveCount(0);
    await page.reload();
    await expect(pill).toHaveText("なし");
    await expect(sprintLink(page, "過去の期間（移行履歴）")).toBeVisible();
    await expect(sprintLink(page, "取りやめ（追加）")).toBeVisible();
    await expect(sprintLink(page, "次 A（追加）")).toHaveCount(0);

    const activity = region(page, "Activity");
    await expect(activity.getByText(`me が Sprint ${first.number}「次 A」に追加した`)).toBeVisible();
    await expect(activity.getByText(`me が Sprint ${first.number}「次 A」から外した`)).toBeVisible();
    await expect(activity.getByText(`me が Sprint ${second.number}「次 B」に追加した`)).toBeVisible();
    await expect(activity.getByText(`me が Sprint ${second.number}「次 B」から外した`)).toBeVisible();
  });

  test("開いている所属が2件以上ならピルは件数を出し、Sprintを選ぶとその1件にそろえる", async ({ page, nod }) => {
    const ws = await workspace(nod, "TWO");
    const issue = await nod.me.createIssue({ workspaceId: ws.id, title: "二重の所属" });
    const first = await draftSprint(page, "TWO", "前半", 1);
    const second = await draftSprint(page, "TWO", "後半", 8);
    await addToSprint(page, first.id, issue.id);
    await addToSprint(page, second.id, issue.id);

    await page.goto(`/issues/${issue.id}`);
    const pill = property(region(page, "プロパティ"), "Sprint");
    await expect(pill).toHaveText("2 件の Sprint");
    await pill.click();
    await expect(sprintMenu(page).locator("[aria-checked=true]")).toHaveCount(0);
    await sprintOption(page, "前半").click();
    await expect(pill).toHaveText("前半");
    await expect(sprintLink(page, "前半（追加）")).toBeVisible();
    await expect(sprintLink(page, "後半（追加）")).toHaveCount(0);
  });
});

test.describe("計画で採択された所属", () => {
  test("採択の所属が1件ならそのSprintだけを選べて他の追加を外し、2件なら操作できず、理由のSprint名を出す", async ({ page, nod }) => {
    const ws = await workspace(nod, "ADP");
    const issue = await nod.me.createIssue({ workspaceId: ws.id, title: "計画に入れたタスク" });
    const ready = await readySprint(page, "ADP", [issue.id], { name: "実行中", startDate: todayUtc(0), endDate: todayUtc(3) });
    await sprintApi(page, "POST", `/sprints/${ready.id}/activate`, { expectedVersion: ready.version, requestKey: crypto.randomUUID() });
    const extra = await draftSprint(page, "ADP", "差し込み先", 5);
    await addToSprint(page, extra.id, issue.id);

    await page.goto(`/issues/${issue.id}`);
    const props = region(page, "プロパティ");
    const pill = property(props, "Sprint");
    await expect(pill).toHaveText("2 件の Sprint");
    await expect(sprintLink(page, "差し込み先（追加）")).toBeVisible();
    await expect(pill).toHaveAccessibleDescription(/計画で採択されているため外せません（実行中）/);
    await expect(props.getByText("計画で採択されているため外せません（実行中）", { exact: true })).toBeVisible();
    await pill.click();
    await expect(sprintMenu(page).getByRole("menuitemradio", { name: "なし", exact: true })).toBeDisabled();
    await expect(sprintOption(page, "差し込み先")).toBeDisabled();
    await expect(sprintOption(page, "実行中")).toBeEnabled();
    await sprintOption(page, "実行中").click();
    await expect(pill).toHaveText("実行中");
    await expect(sprintLink(page, "差し込み先（追加）")).toHaveCount(0);
    await page.reload();
    await expect(pill).toHaveText("実行中");
    await expect(sprintLink(page, "実行中（追加）")).toBeVisible();
    await expect(region(page, "Activity").getByText(`me が Sprint ${extra.number}「差し込み先」から外した`)).toBeVisible();

    // 採択の所属が2件あると、どれを選んでも採択が外れるため操作できない
    await readySprint(page, "ADP", [issue.id], { name: "次の計画", startDate: todayUtc(15), endDate: todayUtc(19) });
    await page.reload();
    await expect(pill).toHaveText("2 件の Sprint");
    await expect(pill).toBeDisabled();
    await expect(props.getByText(/^計画で採択されているため外せません（(実行中、次の計画|次の計画、実行中)）$/)).toBeVisible();
  });

  test.describe("移行したデータ", () => {
    test.use({ dataset: "sprint-history" });

    test("移行履歴と採択のリンクはそのまま出し、採択だけの進行中Sprintは外せず、別Workspaceの進行中Sprintは出さない", async ({ page }) => {
      await page.goto("/issues/AAA-1");
      const props = region(page, "プロパティ");
      const pill = property(props, "Sprint");
      await expect(pill).toHaveText("実行 12");
      await expect(sprintLink(page, "過去（移行履歴）")).toBeVisible();
      await expect(sprintLink(page, "実行 12（採択）")).toBeVisible();
      await expect(props.getByText("計画で採択されているため外せません（実行 12）", { exact: true })).toBeVisible();
      await pill.click();
      await expect(sprintMenu(page).getByRole("menuitemradio")).toHaveText(["なし", /^実行 12進行中/]);
      await expect(sprintMenu(page).getByRole("menuitemradio", { name: "なし", exact: true })).toBeDisabled();
      await expect(sprintOption(page, "実行 12")).toHaveAttribute("aria-checked", "true");
    });
  });
});

test.describe("拒否", () => {
  test.use({ allowedConsoleErrors: [/status of 409/] });

  test("画面の表示後にSprintが中止され、APIが拒否したら理由を出し、実際の状態に戻す", async ({ page, nod }) => {
    const ws = await workspace(nod, "STL");
    const issue = await nod.me.createIssue({ workspaceId: ws.id, title: "古い画面から選ぶ" });
    const target = await draftSprint(page, "STL", "移動先", 1);
    await page.goto(`/issues/${issue.id}`);
    const props = region(page, "プロパティ");
    const pill = property(props, "Sprint");
    await pill.click();
    await expect(sprintOption(page, "移動先")).toBeEnabled();
    await pill.click();
    // server 自身の書き込みは SSE で画面に届かないため、画面は古い一覧のまま
    await sprintApi(page, "POST", `/sprints/${target.id}/cancel`, { expectedVersion: target.version, requestKey: crypto.randomUUID(), reason: "取りやめ" });

    await chooseSprint(page, "移動先");
    await expect(props.getByRole("alert")).toHaveText(/^Sprintを変更できませんでした：.+/);
    await expect(pill).toHaveText("なし");
    await expect(sprintLink(page, "移動先（追加）")).toHaveCount(0);
    await pill.click();
    await expect(sprintMenu(page).getByRole("menuitemradio")).toHaveText(["なし"]);
    await expect(props.getByText("選べる Sprint はありません", { exact: true })).toBeVisible();
  });
});
