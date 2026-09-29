import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// design/nod.pen「Issues｜一括編集（#31）」。選択は URL に残さず、1件でも失敗したら何も変えない

const bar = (page: Page) => page.getByRole("toolbar", { name: "一括操作" });
const box = (page: Page, id: string) => page.getByRole("checkbox", { name: `${id} を選択`, exact: true });
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

  await page.getByRole("tab", { name: "Board" }).click();
  await expect(page.getByRole("checkbox", { name: /を選択$/ })).toHaveCount(0);
  await expect(bar(page)).toHaveCount(0);
});
