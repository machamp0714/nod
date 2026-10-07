import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";
import { region } from "./helpers";
import { type FakeTogglEntry, type FakeTogglProject, stubToggl, togglState } from "./support/nod";

// Toggl 打刻（NOD-6）。e2e の server は本物の Toggl の代わりに偽のクライアントを使い、Toggl には触れない
const toggl = (page: import("@playwright/test").Page) => region(page, "Toggl 打刻");

const running = (description: string, minutesAgo: number): FakeTogglEntry => ({
  id: 501,
  workspace_id: 4242,
  description,
  start: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  duration: -1,
});

// 打刻の要求だけ（Project の一覧の取得と、そのための既定の Workspace の取得は除く。開くと打刻の取得と並んで走る）
const entryCalls = async () =>
  (await togglState()).calls.filter((c) => c.path !== "/me" && !c.path.endsWith("/projects?active=true"));

const PROJECTS: FakeTogglProject[] = [
  { id: 11, name: "nod", color: "#0b83d9" },
  { id: 12, name: "社内業務", color: "#e36a00" },
];
const projectSelect = (page: import("@playwright/test").Page) => toggl(page).getByRole("combobox", { name: "Toggl の Project" });

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
  expect((await entryCalls()).length).toBeLessThanOrEqual(2);
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
  const { current } = await togglState();
  // 開始の直前に取り直し、動いている打刻を明示的に止めてから開始する
  expect((await entryCalls()).slice(-3).map((c) => `${c.method} ${c.path}`)).toEqual([
    "GET /me/time_entries/current",
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
    expect((await entryCalls()).map((c) => `${c.method} ${c.path}`)).toEqual([
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
    expect((await togglState()).calls.map((c) => c.token)).not.toContain("tok-e2e");
    expect((await entryCalls()).map((c) => c.token)).toEqual(["tok-new"]);
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

  test("開始に失敗し、取り直しにも失敗したら「成否を確認できません」と出し、取り直せるまでボタンを無効にする", async ({ page, nod }) => {
    const id = await issue(nod);
    await stubToggl({ token: "tok-e2e", current: running("API-99 レビュー対応", 10), failures: { start: "timeout", currentAfterStart: true } });
    await page.goto(`/issues/${id}`);
    const panel = toggl(page);
    await panel.getByRole("button", { name: "この Issue に切り替える" }).click();

    await expect(panel.getByRole("alert")).toHaveText(/成否を確認できません/);
    // 操作前の打刻と切り替えボタンは残さず、「未確認」としてボタンを無効にする
    await expect(panel.getByText("未確認")).toBeVisible();
    // 打刻の説明（文言の中の引用は除く）
    await expect(panel.getByText("API-99 レビュー対応", { exact: true })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "この Issue に切り替える" })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "打刻を開始" })).toBeDisabled();
    // 成否が分からない間も、最後に Toggl の状態が分かった時刻を添える
    await expect(panel.getByText(/^\d\d:\d\d 時点$/)).toBeVisible();
    expect((await togglState()).calls.filter((c) => c.method === "POST")).toHaveLength(1);

    // 開き直しても取り直せなければ無効のまま。取り直せたらその状態を出す
    await page.reload();
    await expect(panel.getByRole("button", { name: "打刻を開始" })).toBeDisabled();
    await expect(panel.getByText(/^\d\d:\d\d 時点$/)).toBeVisible();
    await stubToggl({ failures: {}, keepCache: true });
    await panel.getByRole("button", { name: "最新にする" }).click();
    await expect(panel.getByRole("button", { name: "打刻を停止" })).toBeEnabled();
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

test.describe("Toggl を呼べなかったとき", () => {
  // server がわざと 502 を返す
  test.use({ allowedConsoleErrors: [/status of 502/] });

  test("トークンが受け付けられなければボタンを無効にし、トークンを直す案内を出す", async ({ page, nod }) => {
    const id = await issue(nod);
    await stubToggl({ token: "tok-bad", current: null, failures: { current: "auth" } });
    await page.goto(`/issues/${id}`);
    const panel = toggl(page);
    await expect(panel.getByText(/API トークンが受け付けられませんでした（HTTP 401）/)).toBeVisible();
    const { configPath } = await togglState();
    await expect(panel.getByText(configPath)).toBeVisible();
    await expect(panel.getByRole("button", { name: "打刻を開始" })).toBeDisabled();
    await expect(panel.getByText("停止中")).toHaveCount(0);

    // トークンが誤ったままなら、開き直しても Toggl を呼ばない
    await page.reload();
    await expect(panel.getByText(/API トークンが受け付けられませんでした（HTTP 401）/)).toBeVisible();
    expect(await entryCalls()).toHaveLength(1);

    // 設定ファイルのトークンを直したら、開き直したときにすぐ取り直す
    await stubToggl({ token: "tok-good", failures: {}, keepCache: true });
    await page.reload();
    await expect(panel.getByText("停止中")).toBeVisible();
    await expect(panel.getByRole("button", { name: "打刻を開始" })).toBeEnabled();
    expect((await entryCalls()).map((c) => c.token)).toEqual(["tok-good"]);
  });

  test("利用上限に達したら最後に分かっている状態を「〜時点」と添えて出し、待っている間はボタンを無効にして理由を出す", async ({ page, nod }) => {
    const id = await issue(nod);
    await stubToggl({ token: "tok-e2e", current: running("API-99 レビュー対応", 10) });
    await page.goto(`/issues/${id}`);
    const panel = toggl(page);
    await expect(panel.getByRole("button", { name: "この Issue に切り替える" })).toBeEnabled();

    await stubToggl({ failures: { current: "quota" }, keepCache: true });
    await panel.getByRole("button", { name: "最新にする" }).click();
    await expect(panel.getByText(/利用上限に達したため、\d\d:\d\d まで打刻を操作できません/)).toBeVisible();
    await expect(panel.getByText("API-99 レビュー対応")).toBeVisible();
    await expect(panel.getByText(/^\d\d:\d\d 時点$/)).toBeVisible();
    await expect(panel.getByRole("button", { name: "この Issue に切り替える" })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "最新にする" })).toBeDisabled();

    // 開き直しても待っている間は Toggl を呼ばない
    await page.reload();
    await expect(panel.getByRole("button", { name: "この Issue に切り替える" })).toBeDisabled();
    expect(await entryCalls()).toHaveLength(1);
  });

  test("初めての取得に通信で失敗したら「停止中」ではなく「未確認」と出す", async ({ page, nod }) => {
    const id = await issue(nod);
    await stubToggl({ token: "tok-e2e", current: null, failures: { current: "network" } });
    await page.goto(`/issues/${id}`);
    const panel = toggl(page);
    await expect(panel.getByText("未確認")).toBeVisible();
    await expect(panel.getByText("停止中")).toHaveCount(0);
    await expect(panel.getByText(/Toggl に接続できませんでした（ECONNREFUSED）。打刻の状態は分かりません/)).toBeVisible();
  });

  test("以前に取得していれば、通信に失敗しても最後に分かっている状態を「〜時点」と添えて出す", async ({ page, nod }) => {
    const id = await issue(nod);
    await stubToggl({ token: "tok-e2e", current: running(`${id} 検索 API の N+1 を解消`, 5) });
    await page.goto(`/issues/${id}`);
    const panel = toggl(page);
    await expect(panel.getByRole("button", { name: "打刻を停止" })).toBeVisible();

    await stubToggl({ failures: { current: "network" }, keepCache: true });
    await panel.getByRole("button", { name: "最新にする" }).click();
    await expect(panel.getByText(/Toggl に接続できませんでした（ECONNREFUSED）。表示は最後に分かっている状態です/)).toBeVisible();
    await expect(panel.getByRole("timer", { name: "経過時間" })).toBeVisible();
    await expect(panel.getByText(/^\d\d:\d\d 時点$/)).toBeVisible();
  });
});

test("打刻の欄は右 rail の一番上に置く", async ({ page, nod }) => {
  const id = await issue(nod);
  await page.goto(`/issues/${id}`);
  const first = page.getByRole("complementary").getByRole("region").first();
  await expect(first).toHaveAccessibleName("Toggl 打刻");
});

test.describe("Project", () => {
  test("開始ボタンの横で Project を選んで開始し、次に開いたときは前回の Project を選んでおく", async ({ page, nod }) => {
    const api = await seedApiWorkspace(nod);
    const first = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "検索 API" });
    const second = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "一覧 API" });
    await stubToggl({ token: "tok-e2e", current: null, projects: PROJECTS });
    await page.goto(`/issues/${first.id}`);
    const panel = toggl(page);
    const select = projectSelect(page);
    await expect(select).toHaveValue("");
    await expect(select.getByRole("option")).toHaveText(["Project なし", "nod", "社内業務"]);
    await select.selectOption({ label: "社内業務" });
    await panel.getByRole("button", { name: "打刻を開始" }).click();
    await expect(panel.getByRole("button", { name: "打刻を停止" })).toBeVisible();
    expect((await togglState()).calls.find((c) => c.method === "POST")?.body).toMatchObject({ project_id: 12 });
    // 打刻中はその打刻の Project を出す
    await expect(select).toHaveValue("12");

    await panel.getByRole("button", { name: "打刻を停止" }).click();
    await expect(panel.getByRole("button", { name: "打刻を開始" })).toBeEnabled();
    await page.goto(`/issues/${second.id}`);
    await expect(select).toHaveValue("12");
    // Project の一覧は詳細ページを開くたびには取り直さない
    expect((await togglState()).calls.filter((c) => c.path.endsWith("/projects?active=true"))).toHaveLength(1);
  });

  test("別の打刻からの切り替えも選んだ Project で開始する", async ({ page, nod }) => {
    const id = await issue(nod);
    await stubToggl({ token: "tok-e2e", current: { ...running("API-99 レビュー対応", 10), project_id: 11 }, projects: PROJECTS });
    await page.goto(`/issues/${id}`);
    const panel = toggl(page);
    await projectSelect(page).selectOption({ label: "社内業務" });
    await panel.getByRole("button", { name: "この Issue に切り替える" }).click();
    await expect(panel.getByRole("button", { name: "打刻を停止" })).toBeVisible();
    expect((await togglState()).current).toMatchObject({ description: `${id} 検索 API の N+1 を解消`, project_id: 12 });
  });

  test("打刻中に Project を変えると Toggl の打刻の Project も変える。Project なしにもできる", async ({ page, nod }) => {
    const id = await issue(nod);
    await stubToggl({ token: "tok-e2e", current: { ...running(`${id} 検索 API の N+1 を解消`, 5), project_id: 11 }, projects: PROJECTS });
    await page.goto(`/issues/${id}`);
    const select = projectSelect(page);
    await expect(select).toHaveValue("11");
    await select.selectOption({ label: "社内業務" });
    await expect.poll(async () => (await togglState()).current?.project_id).toBe(12);
    await expect(select).toHaveValue("12");
    await expect(select).toBeEnabled();
    await select.selectOption({ label: "Project なし" });
    await expect.poll(async () => (await togglState()).current?.project_id).toBeNull();
    const puts = (await togglState()).calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => [c.path, c.body])).toEqual([
      ["/workspaces/4242/time_entries/501", { project_id: 12 }],
      ["/workspaces/4242/time_entries/501", { project_id: null }],
    ]);
    // 変えた Project を、次の開始の初期値にする
    await page.reload();
    await toggl(page).getByRole("button", { name: "打刻を停止" }).click();
    await expect(select).toHaveValue("");
  });

  test("前回の Project が一覧に無くなっていたら「Project なし」にする", async ({ page, nod }) => {
    const id = await issue(nod);
    await page.addInitScript(() => window.localStorage.setItem("nod.toggl.projectId", "99"));
    await stubToggl({ token: "tok-e2e", current: null, projects: PROJECTS });
    await page.goto(`/issues/${id}`);
    await expect(projectSelect(page)).toHaveValue("");
    await toggl(page).getByRole("button", { name: "打刻を開始" }).click();
    await expect(toggl(page).getByRole("button", { name: "打刻を停止" })).toBeVisible();
    expect((await togglState()).calls.find((c) => c.method === "POST")?.body).not.toHaveProperty("project_id");
  });

  test("ブラウザに覚えられなくても、Project を選んで開始できる", async ({ page, nod }) => {
    const id = await issue(nod);
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", { get: () => { throw new Error("blocked"); } });
    });
    await stubToggl({ token: "tok-e2e", current: null, projects: PROJECTS });
    await page.goto(`/issues/${id}`);
    await projectSelect(page).selectOption({ label: "nod" });
    await toggl(page).getByRole("button", { name: "打刻を開始" }).click();
    await expect(toggl(page).getByRole("button", { name: "打刻を停止" })).toBeVisible();
    expect((await togglState()).current?.project_id).toBe(11);
  });

  test("一覧の取得に失敗したら選択欄だけを無効にして理由を出し、Project なしで開始できる。「最新にする」で取り直す", async ({ page, nod }) => {
    const id = await issue(nod);
    await stubToggl({ token: "tok-e2e", current: null, projects: PROJECTS, failures: { projects: "network" } });
    await page.goto(`/issues/${id}`);
    const panel = toggl(page);
    await expect(projectSelect(page)).toBeDisabled();
    await expect(panel.getByText(/Project の一覧を取得できませんでした（ECONNREFUSED）/)).toBeVisible();
    await panel.getByRole("button", { name: "打刻を開始" }).click();
    await expect(panel.getByRole("button", { name: "打刻を停止" })).toBeEnabled();

    await stubToggl({ failures: {}, keepCache: true });
    await panel.getByRole("button", { name: "最新にする" }).click();
    await expect(projectSelect(page)).toBeEnabled();
    await expect(projectSelect(page).getByRole("option")).toHaveText(["Project なし", "nod", "社内業務"]);
    await expect(panel.getByText(/Project の一覧を取得できませんでした/)).toHaveCount(0);
  });

  test.describe("変更の失敗", () => {
    // server がわざと 502 を返す
    test.use({ allowedConsoleErrors: [/status of 502/] });

    test("Project の変更に失敗したら知らせ、再送しない", async ({ page, nod }) => {
      const id = await issue(nod);
      await stubToggl({ token: "tok-e2e", current: running(`${id} 検索 API の N+1 を解消`, 5), projects: PROJECTS, failures: { update: "http_error" } });
      await page.goto(`/issues/${id}`);
      const select = projectSelect(page);
      await expect(select).toHaveValue("");
      await select.selectOption({ label: "nod" });
      await expect(toggl(page).getByRole("alert")).toHaveText(/打刻の Project を変更できませんでした（HTTP 500）/);
      // 取り直した打刻の Project を出す
      await expect(select).toHaveValue("");
      expect((await togglState()).calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    });
  });
});
