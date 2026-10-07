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
  // API-10 の打刻は「別の打刻」として扱う
  await expect(panel.getByRole("button", { name: "この Issue に切り替える" })).toBeEnabled();
  await expect(panel.getByRole("button", { name: "打刻を停止" })).toHaveCount(0);
  await expect(panel.getByRole("timer")).toHaveCount(0);
});

test("別の打刻が動いているときは、その説明と「この Issue に切り替える」を出し、確認なしで切り替える", async ({ page, nod }) => {
  const id = await issue(nod);
  await stubToggl({ token: "tok-e2e", current: running("API-99 レビュー対応", 10) });
  await page.goto(`/issues/${id}`);
  const panel = toggl(page);
  await expect(panel.getByText("API-99 レビュー対応")).toBeVisible();
  await expect(panel.getByRole("button", { name: "打刻を開始" })).toHaveCount(0);
  await panel.getByRole("button", { name: "この Issue に切り替える" }).click();

  await expect(panel.getByRole("button", { name: "打刻を停止" })).toBeVisible();
  await expect(panel.getByText("API-99 レビュー対応")).toHaveCount(0);
  const { calls, current } = await togglState();
  // 開始の直前に取り直し、動いている打刻を明示的に止めてから開始する
  expect(calls.slice(-3).map((c) => `${c.method} ${c.path}`)).toEqual([
    "GET /me",
    "PATCH /workspaces/4242/time_entries/501/stop",
    "POST /workspaces/4242/time_entries",
  ]);
  expect(current?.description).toBe(`${id} 検索 API の N+1 を解消`);
});

test.describe("現在の打刻のキャッシュ", () => {
  const currentCalls = async () => (await togglState()).calls.filter((c) => c.path === "/me/time_entries/current").length;

  test("取得時刻を添えて表示し、詳細ページを開き直しても別の Issue を開いても期限内は Toggl を呼ばない", async ({ page, nod }) => {
    const api = await seedApiWorkspace(nod);
    const first = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "検索 API" });
    const second = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "一覧 API" });
    await stubToggl({ token: "tok-e2e", current: running(`${first.id} 検索 API`, 5) });
    await page.goto(`/issues/${first.id}`);
    const panel = toggl(page);
    await expect(panel.getByRole("button", { name: "打刻を停止" })).toBeVisible();
    await expect(panel.getByText(/^\d\d:\d\d 時点$/)).toBeVisible();

    await page.reload();
    await expect(panel.getByRole("button", { name: "打刻を停止" })).toBeVisible();
    // 同じキャッシュを、別の Issue では「別の打刻」として表示する
    await page.goto(`/issues/${second.id}`);
    await expect(panel.getByRole("button", { name: "この Issue に切り替える" })).toBeVisible();
    await expect(panel.getByText(/^\d\d:\d\d 時点$/)).toBeVisible();
    expect(await currentCalls()).toBe(1);
  });

  test("Toggl 側の変化は「最新にする」を押したときだけ取り直して反映する", async ({ page, nod }) => {
    const id = await issue(nod);
    await stubToggl({ token: "tok-e2e", current: null });
    await page.goto(`/issues/${id}`);
    const panel = toggl(page);
    await expect(panel.getByText("停止中")).toBeVisible();

    // nod の外で Toggl の打刻が始まった。開き直してもキャッシュの状態のまま
    await stubToggl({ current: running("Toggl で始めた打刻", 1), keepCache: true });
    await page.reload();
    await expect(panel.getByText("停止中")).toBeVisible();
    expect(await currentCalls()).toBe(0);

    await panel.getByRole("button", { name: "最新にする" }).click();
    await expect(panel.getByText("Toggl で始めた打刻")).toBeVisible();
    await expect(panel.getByRole("button", { name: "この Issue に切り替える" })).toBeVisible();
    expect(await currentCalls()).toBe(1);
  });

  test("停止はキャッシュの打刻 ID で行い、直前に取り直さない", async ({ page, nod }) => {
    const id = await issue(nod);
    await stubToggl({ token: "tok-e2e", current: running(`${id} 検索 API の N+1 を解消`, 5) });
    await page.goto(`/issues/${id}`);
    const panel = toggl(page);
    await panel.getByRole("button", { name: "打刻を停止" }).click();
    await expect(panel.getByRole("button", { name: "打刻を開始" })).toBeEnabled();
    await expect(panel.getByText(/^\d\d:\d\d 時点$/)).toBeVisible();
    expect((await togglState()).calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /me/time_entries/current",
      "PATCH /workspaces/4242/time_entries/501/stop",
    ]);
  });

  test("トークンを書き換えたら、開き直したときに新しいトークンで取り直す", async ({ page, nod }) => {
    const id = await issue(nod);
    await stubToggl({ token: "tok-e2e", current: null });
    await page.goto(`/issues/${id}`);
    const panel = toggl(page);
    await expect(panel.getByText("停止中")).toBeVisible();

    await stubToggl({ token: "tok-new", current: running("新しいアカウントの打刻", 1), keepCache: true });
    await page.reload();
    await expect(panel.getByText("新しいアカウントの打刻")).toBeVisible();
    expect((await togglState()).calls.map((c) => c.token)).toEqual(["tok-new"]);
  });
});

test.describe("切り替えの途中の失敗", () => {
  // server がわざと 409・502 を返す
  test.use({ allowedConsoleErrors: [/status of (409|502)/] });

  test("切り替えで開始に失敗したら、前の打刻が止まったことと開始の失敗を出し、再送しない", async ({ page, nod }) => {
    const id = await issue(nod);
    await stubToggl({ token: "tok-e2e", current: running("API-99 レビュー対応", 10), failures: { start: "http_error" } });
    await page.goto(`/issues/${id}`);
    const panel = toggl(page);
    await panel.getByRole("button", { name: "この Issue に切り替える" }).click();

    await expect(panel.getByRole("alert")).toHaveText(/前の打刻「API-99 レビュー対応」は止まりました。この Issue の打刻は開始できませんでした（HTTP 500）/);
    // 取り直した状態（何も動いていない）を表示する
    await expect(panel.getByText("停止中")).toBeVisible();
    const { calls } = await togglState();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  test("開始の応答が途絶えたら成否不明と出し、取り直した打刻を表示する", async ({ page, nod }) => {
    const id = await issue(nod);
    await stubToggl({ token: "tok-e2e", current: running("API-99 レビュー対応", 10), failures: { start: "timeout" } });
    await page.goto(`/issues/${id}`);
    const panel = toggl(page);
    await panel.getByRole("button", { name: "この Issue に切り替える" }).click();

    await expect(panel.getByRole("alert")).toHaveText(/前の打刻「API-99 レビュー対応」は止まりました。この Issue の打刻が開始されたかは分かりません/);
    // Toggl 側では打刻が作られていたので、取り直した状態ではこの Issue の打刻が動いている
    await expect(panel.getByRole("button", { name: "打刻を停止" })).toBeVisible();
    expect((await togglState()).calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  test("開始に失敗し、取り直しにも失敗したら「成否を確認できません」と出す", async ({ page, nod }) => {
    const id = await issue(nod);
    await stubToggl({ token: "tok-e2e", current: running("API-99 レビュー対応", 10), failures: { start: "timeout", currentAfterStart: true } });
    await page.goto(`/issues/${id}`);
    const panel = toggl(page);
    await panel.getByRole("button", { name: "この Issue に切り替える" }).click();

    await expect(panel.getByRole("alert").first()).toHaveText(/成否を確認できません/);
    expect((await togglState()).calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  test("止めようとした打刻がほかで止められていたら、中断して取り直した状態を出す", async ({ page, nod }) => {
    const id = await issue(nod);
    await stubToggl({ token: "tok-e2e", current: running("API-99 レビュー対応", 10), failures: { stop: "conflict" } });
    await page.goto(`/issues/${id}`);
    const panel = toggl(page);
    await panel.getByRole("button", { name: "この Issue に切り替える" }).click();

    await expect(panel.getByRole("alert")).toHaveText(/ほかで変わっていたため、操作を中断しました/);
    await expect(panel.getByText("停止中")).toBeVisible();
    expect((await togglState()).calls.some((c) => c.method === "POST")).toBe(false);
  });
});
