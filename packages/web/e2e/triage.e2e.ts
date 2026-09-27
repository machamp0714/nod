import type { Page } from "@playwright/test";
import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";

const list = (page: Page) => page.getByRole("region", { name: "Triage の一覧" });
const detail = (page: Page) => page.getByRole("region", { name: "詳細", exact: true });
const empty = (page: Page) => list(page).getByText("Triage の Issue はありません");

test("LLM が起票した Issue だけを並べ、起票者と説明と4つの判断を出す", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  await api.triageIssue("検索結果のページングが 1 件ずれる", "page=2 のとき 22 件目から返る");
  await nod.me.createIssue({ workspaceId: api.workspace.id, title: "私が起票した Issue" });

  await page.goto("/triage");
  await expect(list(page).getByRole("link")).toHaveCount(1);
  await expect(detail(page).getByRole("heading", { level: 2, name: "検索結果のページングが 1 件ずれる" })).toBeVisible();
  await expect(detail(page).getByText(/claude-code が起票/)).toBeVisible();
  await expect(detail(page).getByText("page=2 のとき 22 件目から返る")).toBeVisible();
  for (const name of ["受け入れる", "重複にする", "後回し", "却下"]) {
    await expect(detail(page).getByRole("button", { name, exact: true })).toBeEnabled();
  }
});

test("受け入れると Todo になり、一覧から消える", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const i = await api.triageIssue("検索結果のページングが 1 件ずれる");
  await page.goto("/triage");
  await detail(page).getByRole("button", { name: "受け入れる" }).click();
  await expect(empty(page)).toBeVisible();
  expect((await api.show(i.id)).status).toBe("todo");
});

test("却下は理由を付けて Canceled にできる", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const i = await api.triageIssue("レート制限の残り回数をヘッダーで返す");
  await page.goto("/triage");
  await detail(page).getByRole("button", { name: "却下", exact: true }).click();
  await detail(page).getByRole("textbox", { name: "却下の理由（任意）" }).fill("今は要らない");
  await detail(page).getByRole("button", { name: "却下する" }).click();
  await expect(empty(page)).toBeVisible();
  expect(await api.show(i.id)).toMatchObject({ status: "canceled", closeReason: "今は要らない" });
});

test("重複にすると元の Issue との関係を残して Canceled にする", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const original = await api.startedIssue("検索 API の N+1 を解消");
  const dup = await api.triageIssue("検索が遅い");
  await page.goto("/triage");
  await detail(page).getByRole("button", { name: "重複にする" }).click();
  await detail(page).getByRole("textbox", { name: "元の Issue の ID" }).fill(original.id);
  await detail(page).getByRole("button", { name: "重複として閉じる" }).click();
  await expect(empty(page)).toBeVisible();
  const shown = await api.show(dup.id);
  expect(shown.status).toBe("canceled");
  expect(shown.relations.duplicateOf).toEqual([original.id]);
});

test("後回しにすると期限まで一覧に出さない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const i = await api.triageIssue("ログのタイムゾーンを UTC に統一");
  await page.goto("/triage");
  await detail(page).getByRole("button", { name: "後回し", exact: true }).click();
  await expect(detail(page).getByLabel("後回しの期限")).not.toHaveValue("");
  await detail(page).getByRole("button", { name: "後回しにする" }).click();
  await expect(empty(page)).toBeVisible();
  const shown = await api.show(i.id);
  expect(shown.status).toBe("triage");
  expect(Date.parse(shown.snoozedUntil ?? "")).toBeGreaterThan(Date.now());
});

test("Snooze の期限の前は出さず、期限を過ぎた Issue は再び出す", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const future = await api.triageIssue("期限の前の Issue");
  const past = await api.triageIssue("期限を過ぎた Issue");
  await nod.me.snoozeTriage(future.id, "2999-01-01");
  await nod.me.snoozeTriage(past.id, "2000-01-01");
  await page.goto("/triage");
  await expect(list(page).getByRole("link")).toHaveCount(1);
  await expect(list(page).getByRole("link")).toContainText("期限を過ぎた Issue");
});

test("後回しの期限を手入力しても今日や過去の日付では送信できない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const i = await api.triageIssue("ログのタイムゾーンを UTC に統一");
  await page.goto("/triage");
  await detail(page).getByRole("button", { name: "後回し", exact: true }).click();
  await expect(detail(page).getByRole("button", { name: "後回しにする" })).toBeEnabled();
  await detail(page).getByLabel("後回しの期限").fill("2000-01-01");
  await expect(detail(page).getByRole("button", { name: "後回しにする" })).toBeDisabled();
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  await detail(page).getByLabel("後回しの期限").fill(today);
  await expect(detail(page).getByRole("button", { name: "後回しにする" })).toBeDisabled();
  expect((await api.show(i.id)).snoozedUntil).toBeNull();
  await detail(page).getByLabel("後回しの期限").fill("2999-01-01");
  await expect(detail(page).getByRole("button", { name: "後回しにする" })).toBeEnabled();
});

test("やめるで入力欄を閉じる", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  await api.triageIssue("検索結果のページングが 1 件ずれる");
  await page.goto("/triage");
  await detail(page).getByRole("button", { name: "重複にする" }).click();
  await detail(page).getByRole("button", { name: "やめる" }).click();
  await expect(detail(page).getByRole("textbox", { name: "元の Issue の ID" })).toHaveCount(0);
});

test.describe("存在しない Issue を重複の元にする", () => {
  test.use({ allowedConsoleErrors: [/status of 404/] });

  test("server のメッセージを出し、Issue は Triage に残る", async ({ page, nod }) => {
    const api = await seedApiWorkspace(nod);
    const i = await api.triageIssue("検索が遅い");
    await page.goto("/triage");
    await detail(page).getByRole("button", { name: "重複にする" }).click();
    await detail(page).getByRole("textbox", { name: "元の Issue の ID" }).fill("NOPE-1");
    await detail(page).getByRole("button", { name: "重複として閉じる" }).click();
    await expect(detail(page).getByRole("alert")).toContainText("NOPE-1");
    await expect(list(page).getByRole("link")).toHaveCount(1);
    expect((await api.show(i.id)).status).toBe("triage");
  });
});
