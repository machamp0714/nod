import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { setLayout } from "./support/issue-list";

// design/nod.pen「Issues｜一括編集（#31）」。選択は URL に残さず、1件でも失敗したら何も変えない

const bar = (page: Page) => page.getByRole("toolbar", { name: "一括操作" });
const box = (page: Page, id: string) => page.getByRole("checkbox", { name: `${id} を選択`, exact: true });
// ブラウザと同じローカルの暦日
function localDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const selectAll = (page: Page) => page.getByRole("checkbox", { name: "表示中の Issue をすべて選択" });

async function seed(nod: import("./support/nod").NodData) {
  const ws = (await nod.me.initWorkspace({ path: nod.repo("api-server"), key: "API", name: "api-server" })).workspace;
  await nod.me.createProject({ name: "決済まわり" });
  const ids: string[] = [];
  for (const title of ["B1 一つ目", "B2 二つ目", "B3 三つ目", "B4 四つ目"]) {
    ids.push((await nod.me.createIssue({ workspaceId: ws.id, title, labels: title.startsWith("B1") ? ["perf"] : [] })).id);
  }
  return { ws, ids };
}

test("チェックボックス・Shift 範囲・全選択で選び、状態・優先度・ラベル・Project をまとめて変える", async ({ page, nod }) => {
  const { ids } = await seed(nod);
  const [b1, b2, b3, b4] = ids as [string, string, string, string];
  await page.goto("/issues?sort=title");
  await expect(bar(page)).toHaveCount(0);

  await box(page, b1).click();
  await box(page, b3).click({ modifiers: ["Shift"] });
  await expect(bar(page)).toContainText("3 件選択");
  await expect(box(page, b2)).toBeChecked();
  await expect(box(page, b4)).not.toBeChecked();
  // 一部だけ選んでいるときは全選択が不定になる
  await expect(selectAll(page)).toHaveJSProperty("indeterminate", true);
  // 選択は URL に残さない
  expect(new URL(page.url()).search).toBe("?sort=title");

  await bar(page).getByRole("button", { name: "Status" }).click();
  await page.getByRole("menu", { name: "Status を変更" }).getByRole("menuitem", { name: "In Progress" }).click();
  await expect(page.getByRole("status").filter({ hasText: "3件を更新しました" })).toBeVisible();
  await expect(bar(page)).toHaveCount(0);
  await expect(selectAll(page)).toBeFocused();

  const issues = (await (await page.request.get("/api/issues?status=in_progress")).json()).issues as { id: string }[];
  expect(issues.map((i) => i.id).sort()).toEqual([b1, b2, b3].sort());
  // event は Issue ごとに1件ずつ
  for (const id of [b1, b2, b3]) {
    const detail = await (await page.request.get(`/api/issues/${id}`)).json();
    expect(detail.activity.filter((a: { type: string }) => a.type === "status_changed")).toHaveLength(1);
  }

  await selectAll(page).click();
  await expect(bar(page)).toContainText("4 件選択");
  await bar(page).getByRole("button", { name: "優先度" }).click();
  await page.getByRole("menuitem", { name: "High" }).click();
  await expect(page.getByRole("status").filter({ hasText: "4件を更新しました" })).toBeVisible();

  await selectAll(page).click();
  await bar(page).getByRole("button", { name: "ラベル" }).click();
  await expect(page.getByRole("menu", { name: "ラベルを削除" }).getByRole("menuitem", { name: /perf/ })).toContainText("4件中 1");
  await page.getByRole("textbox", { name: "ラベルを検索" }).fill("bulk");
  await page.getByRole("menuitem", { name: "「bulk」を新しく追加" }).click();
  await expect(page.getByRole("status").filter({ hasText: "4件を更新しました" })).toBeVisible();

  await box(page, b4).click();
  await bar(page).getByRole("button", { name: "Project" }).click();
  await page.getByRole("menuitem", { name: "決済まわり" }).click();
  await expect(page.getByRole("status").filter({ hasText: "1件を更新しました" })).toBeVisible();

  const all = (await (await page.request.get("/api/issues")).json()).issues as { id: string; priority: number; labels: string[]; project: { name: string } | null }[];
  for (const issue of all) {
    expect(issue.priority).toBe(2);
    expect(issue.labels).toContain("bulk");
    expect(issue.project?.name ?? null).toBe(issue.id === b4 ? "決済まわり" : null);
  }
});

test.describe("失敗したとき", () => {
  test.use({ allowedConsoleErrors: [/status of 409/] });

  test("Triage の Issue を含めると何も変えず、失敗した Issue と理由を出して選択を残す。Escape で選択を解く", async ({ page, nod }) => {
    const { ws, ids } = await seed(nod);
    const triage = (await nod.claude.createIssue({ workspaceId: ws.id, title: "B5 Triage" })).id;
    await page.goto("/issues?sort=title");
    await box(page, ids[0] as string).click();
    await box(page, triage).click();
    await bar(page).getByRole("button", { name: "Status" }).click();
    await page.getByRole("menuitem", { name: "Todo" }).click();

    const alert = page.getByRole("alert").filter({ hasText: "1件を更新できませんでした。何も変更していません" });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(triage);
    await expect(alert).toContainText("Triage 画面で判断してください");
    await expect(bar(page)).toContainText("2 件選択");
    await expect(bar(page).getByRole("button", { name: "Status" })).toBeFocused();
    const detail = await (await page.request.get(`/api/issues/${triage}`)).json();
    expect(detail.status).toBe("triage");

    await box(page, triage).focus();
    await page.keyboard.press("Escape");
    await expect(bar(page)).toHaveCount(0);
    await expect(box(page, ids[0] as string)).not.toBeChecked();
  });
});

test("キーボードで選び（Space・Shift+Space）、グループの全選択を使える。Board では選択を出さない", async ({ page, nod }) => {
  const { ids } = await seed(nod);
  const [b1, b2, b3, b4] = ids as [string, string, string, string];
  await page.goto("/issues?sort=title");
  await box(page, b1).focus();
  await page.keyboard.press("Space");
  await expect(box(page, b1)).toBeChecked();
  await box(page, b3).focus();
  await page.keyboard.press("Shift+Space");
  await expect(box(page, b2)).toBeChecked();
  await expect(box(page, b3)).toBeChecked();
  // Space で選んでもプレビューは開かない
  await expect(page).not.toHaveURL(/preview=/);

  // 見積もり・期限はポップオーバーで入力して適用する
  await bar(page).getByRole("button", { name: "見積もり" }).click();
  await page.getByRole("spinbutton", { name: "見積もり（ポイント）" }).fill("5");
  await page.getByRole("spinbutton", { name: "見積もり（ポイント）" }).press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "3件を更新しました" })).toBeVisible();
  const estimates = (await (await page.request.get("/api/issues")).json()).issues as { id: string; estimate: number | null }[];
  expect(estimates.filter((i) => i.estimate === 5).map((i) => i.id).sort()).toEqual([b1, b2, b3].sort());

  await page.goto("/issues?sort=title&groupBy=status");
  const group = page.getByRole("checkbox", { name: "Status Todo の Issue をすべて選択" });
  await group.click();
  await expect(bar(page)).toContainText("4 件選択");
  await box(page, b4).click();
  await expect(group).toHaveJSProperty("indeterminate", true);
  // メニューの Escape はメニューだけを閉じ、選択は残す
  await bar(page).getByRole("button", { name: "担当" }).click();
  await expect(page.getByRole("menu", { name: "担当を変更" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "担当を変更" })).toHaveCount(0);
  await expect(bar(page)).toContainText("3 件選択");

  await setLayout(page, "Board");
  await expect(page.getByRole("checkbox", { name: /を選択$/ })).toHaveCount(0);
  await expect(bar(page)).toHaveCount(0);
});

test("ラベルのグループでは、2回目に出た行を起点にした Shift の範囲もその位置から選ぶ（#121）", async ({ page, nod }) => {
  const ws = (await nod.me.initWorkspace({ path: nod.repo("api-server"), key: "API", name: "api-server" })).workspace;
  const labels: Record<string, string[]> = { B1: ["perf", "security"], B2: ["perf"], B3: ["security"], B4: ["security"] };
  const ids: Record<string, string> = {};
  for (const [title, l] of Object.entries(labels)) ids[title] = (await nod.me.createIssue({ workspaceId: ws.id, title, labels: l })).id;
  await page.goto("/issues?sort=title&groupBy=label");
  const security = page.getByRole("region", { name: "ラベル security" });
  await security.getByRole("checkbox", { name: `${ids.B1} を選択`, exact: true }).click();
  await security.getByRole("checkbox", { name: `${ids.B3} を選択`, exact: true }).click({ modifiers: ["Shift"] });
  await expect(bar(page)).toContainText("2 件選択");
  await expect(box(page, ids.B2 as string)).not.toBeChecked();
  await expect(box(page, ids.B4 as string)).not.toBeChecked();
  // 同じ Issue はどのグループの行でも選択済みに見える
  await expect(page.getByRole("region", { name: "ラベル perf" }).getByRole("checkbox", { name: `${ids.B1} を選択`, exact: true })).toBeChecked();
});

test("上限の100件を超えて選ぶと、送る前に知らせて項目を選べなくする（#121）", async ({ page, nod }) => {
  const ws = (await nod.me.initWorkspace({ path: nod.repo("api-server"), key: "API", name: "api-server" })).workspace;
  for (let n = 0; n < 101; n++) await nod.me.createIssue({ workspaceId: ws.id, title: `L${String(n).padStart(3, "0")}` });
  await page.goto("/issues?sort=title");
  await selectAll(page).click();
  await expect(bar(page)).toContainText("101 件選択");
  await expect(page.getByRole("alert")).toContainText("選択が一括編集の上限 100 件を超えています（101 件）。100 件以下にしてください");
  for (const name of ["Status", "優先度", "担当", "Project", "ラベル", "見積もり", "期限"]) {
    await expect(bar(page).getByRole("button", { name, exact: true })).toBeDisabled();
  }
  await expect(bar(page).getByRole("button", { name: "選択解除" })).toBeEnabled();
  // 1件外せば上限内に戻り、操作できる
  await page.getByRole("checkbox", { name: /を選択$/ }).first().click();
  await expect(bar(page)).toContainText("100 件選択");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(bar(page).getByRole("button", { name: "Status", exact: true })).toBeEnabled();
});

test("Cycle・Milestone をまとめて入れ・外し、Project が混ざると Milestone は理由を出して選べなくする。Workspace が混ざっていても Cycle は変えられる（#154）", async ({ page, nod }) => {
  const { ws, ids } = await seed(nod);
  const [b1, b2, b3] = ids as [string, string, string, string];
  await nod.me.createCycle({ name: "Sprint 11", startDate: localDate(-20), endDate: localDate(-7) });
  const current = await nod.me.createCycle({ name: "Sprint 12", startDate: localDate(-6), endDate: localDate(7) });
  await nod.me.createCycle({ name: "Sprint 13", startDate: localDate(8), endDate: localDate(20) });
  const m = await nod.me.createMilestone("決済まわり", { name: "v1.0" });
  await nod.me.createMilestone("決済まわり", { name: "v1.1" });
  for (const id of [b1, b2]) await nod.me.updateIssue(id, { projectRef: "決済まわり" });
  const web = (await nod.me.initWorkspace({ path: nod.repo("web-app"), key: "WEB", name: "web-app" })).workspace;
  const other = (await nod.me.createIssue({ workspaceId: web.id, title: "W1 別の Workspace" })).id;

  await page.goto("/issues?sort=title");
  await box(page, b1).click();
  await box(page, b2).click();
  await bar(page).getByRole("button", { name: "Cycle" }).click();
  const cycleMenu = page.getByRole("menu", { name: "Cycle を変更" });
  // 終了した Cycle は出さず、現在の Cycle を先頭に出す
  await expect(cycleMenu.getByRole("menuitem")).toHaveText(["Sprint 12Current", "Sprint 13Upcoming", "Cycle なし"]);
  await cycleMenu.getByRole("menuitem", { name: /Sprint 12/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "2件を更新しました" })).toBeVisible();
  for (const id of [b1, b2]) expect((await nod.me.getIssue(id)).cycle).toEqual({ id: current.id, name: "Sprint 12" });

  await box(page, b1).click();
  await box(page, b2).click();
  await bar(page).getByRole("button", { name: "Milestone" }).click();
  const milestoneMenu = page.getByRole("menu", { name: "Milestone を変更" });
  await expect(milestoneMenu).toContainText("決済まわり");
  await expect(milestoneMenu.getByRole("menuitem")).toHaveText(["v1.0", "v1.1", "Milestone なし"]);
  await milestoneMenu.getByRole("menuitem", { name: "v1.0" }).click();
  await expect(page.getByRole("status").filter({ hasText: "2件を更新しました" })).toBeVisible();
  expect((await nod.me.getIssue(b2)).milestone).toEqual({ id: m.id, name: "v1.0" });

  await box(page, b1).click();
  await bar(page).getByRole("button", { name: "Milestone" }).click();
  await page.getByRole("menuitem", { name: "Milestone なし" }).click();
  await expect(page.getByRole("status").filter({ hasText: "1件を更新しました" })).toBeVisible();
  expect((await nod.me.getIssue(b1)).milestone).toBeNull();
  await box(page, b1).click();
  await bar(page).getByRole("button", { name: "Cycle" }).click();
  await page.getByRole("menuitem", { name: "Cycle なし" }).click();
  await expect(page.getByRole("status").filter({ hasText: "1件を更新しました" })).toBeVisible();
  expect((await nod.me.getIssue(b1)).cycle).toBeNull();

  // Project のない Issue を含むと Milestone を選べない。Workspace が混ざっていても Cycle は変えられる
  await box(page, b2).click();
  await box(page, b3).click();
  await expect(bar(page).getByRole("button", { name: "Milestone" })).toBeDisabled();
  await expect(bar(page).getByTitle("Project のない Issue が含まれるため、Milestone は一括変更できません")).toBeVisible();
  await box(page, other).click();
  await expect(bar(page).getByRole("button", { name: "Status" })).toBeEnabled();
  await bar(page).getByRole("button", { name: "Cycle" }).click();
  await page.getByRole("menu", { name: "Cycle を変更" }).getByRole("menuitem", { name: /Sprint 13/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "3件を更新しました" })).toBeVisible();
  for (const id of [b2, b3, other]) expect((await nod.me.getIssue(id)).cycle?.name).toBe("Sprint 13");
});

test.describe("Cycle・Milestone の一覧を読めないとき", () => {
  test.use({ allowedConsoleErrors: [/status of 400/] });

  test("読み込み中・取得失敗を「ありません」と取り違えず、それぞれの文言を出す（#154）", async ({ page, nod }) => {
    const { ids } = await seed(nod);
    const [b1] = ids as [string];
    await nod.me.updateIssue(b1, { projectRef: "決済まわり" });
    await page.route("**/api/cycles?*", (route) =>
      route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { code: "INVALID_ARGS", message: "Cycle の一覧の取得に失敗" } }) }),
    );
    await page.route("**/api/milestones*", () => {}); // 応答を返さず、読み込み中のままにする
    await page.goto("/issues?sort=title");
    await box(page, b1).click();
    await bar(page).getByRole("button", { name: "Cycle" }).click();
    const cycleMenu = page.getByRole("menu", { name: "Cycle を変更" });
    await expect(cycleMenu.getByRole("alert")).toHaveText("Cycle の一覧の取得に失敗");
    await expect(cycleMenu).not.toContainText("終了していない Cycle はありません");
    await page.keyboard.press("Escape");
    await bar(page).getByRole("button", { name: "Milestone" }).click();
    const milestoneMenu = page.getByRole("menu", { name: "Milestone を変更" });
    await expect(milestoneMenu).toContainText("読み込み中…");
    await expect(milestoneMenu).not.toContainText("Milestone はありません");
  });
});
