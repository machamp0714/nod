import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";
import { region } from "./helpers";
import { type FakeTogglEntry, stubToggl, togglState } from "./support/nod";

// Toggl 打刻（NOD-6）。e2e の server は本物の Toggl の代わりに偽のクライアントを使い、Toggl には触れない
const toggl = (page: import("@playwright/test").Page) => region(page, "Toggl 打刻");

const running = (description: string, minutesAgo: number): FakeTogglEntry => ({
  id: 501,
  workspace_id: 4242,
  description,
  start: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  duration: -1,
});

async function issue(nod: Parameters<typeof seedApiWorkspace>[0]) {
  const api = await seedApiWorkspace(nod);
  const created = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "検索 API の N+1 を解消" });
  return created.id;
}

test("トークンが未設定ならボタンが無効になり、設定ファイルの場所と書き方を案内する。Toggl は呼ばない", async ({ page, nod }) => {
  const id = await issue(nod);
  await page.goto(`/issues/${id}`);
  const panel = toggl(page);
  await expect(panel.getByRole("button", { name: "打刻を開始" })).toBeDisabled();
  const { configPath } = await togglState();
  await expect(panel.getByText(configPath)).toBeVisible();
  await expect(panel.getByText('{"apiToken": "<API トークン>"}')).toBeVisible();
  expect((await togglState()).calls).toEqual([]);
});

test("開始すると「<ID> <タイトル>」で打刻し、停止ボタンと経過時間を出す。停止で止まる", async ({ page, nod }) => {
  const id = await issue(nod);
  await stubToggl({ token: "tok-e2e", current: null });
  await page.goto(`/issues/${id}`);
  const panel = toggl(page);
  await panel.getByRole("button", { name: "打刻を開始" }).click();

  await expect(panel.getByRole("button", { name: "打刻を停止" })).toBeVisible();
  await expect(panel.getByRole("timer", { name: "経過時間" })).toHaveText(/^0:00:0\d$/);
  const started = await togglState();
  expect(started.current?.description).toBe(`${id} 検索 API の N+1 を解消`);
  const create = started.calls.find((c) => c.method === "POST");
  expect(create).toMatchObject({ path: "/workspaces/4242/time_entries", token: "tok-e2e", body: { created_with: "nod", workspace_id: 4242, duration: -1 } });

  await panel.getByRole("button", { name: "打刻を停止" }).click();
  await expect(panel.getByRole("button", { name: "打刻を開始" })).toBeEnabled();
  await expect(panel.getByRole("timer")).toHaveCount(0);
  expect((await togglState()).current).toBeNull();
});

test("この Issue の打刻中なら、開始時刻から数えた経過時間を画面内で進める", async ({ page, nod }) => {
  const id = await issue(nod);
  await stubToggl({ token: "tok-e2e", current: running(`${id} 検索 API の N+1 を解消`, 65) });
  await page.goto(`/issues/${id}`);
  const timer = toggl(page).getByRole("timer", { name: "経過時間" });
  await expect(timer).toHaveText(/^1:05:\d\d$/);
  const first = await timer.textContent();
  await expect(timer).not.toHaveText(first ?? "");
  // 経過時間は画面内で数え、毎秒 Toggl を呼ばない
  expect((await togglState()).calls.length).toBeLessThanOrEqual(2);
});

test("API-10 の打刻を API-1 の打刻と取り違えない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const created = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "検索 API" });
  expect(created.id).toBe("API-1");
  await stubToggl({ token: "tok-e2e", current: running("API-10 別の作業", 3) });
  await page.goto("/issues/API-1");
  const panel = toggl(page);
  await expect(panel.getByRole("button", { name: "打刻を開始" })).toBeEnabled();
  await expect(panel.getByRole("button", { name: "打刻を停止" })).toHaveCount(0);
  await expect(panel.getByRole("timer")).toHaveCount(0);
});
