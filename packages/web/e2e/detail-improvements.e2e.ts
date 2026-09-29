import { seedApiWorkspace } from "./decision-data";
import { expect, test, waitForServerEvents } from "./fixtures";

test("detached の実行場所は詳細とInboxでパスも読める", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "ブランチなし" });
  const worktree = `${api.repo}/日本語の長い作業場所`;
  await nod.codex.startIssue(issue.id, { location: { branch: null, worktree } });
  await nod.codex.askQuestion(issue.id, "進めてよいですか");
  await page.goto(`/issues/${issue.id}`);
  const property = page.locator("dt").filter({ hasText: /^実行場所$/ }).locator("..");
  await expect(property).toContainText("(detached)");
  await expect(property).toContainText(worktree);
  await page.goto("/inbox");
  const detail = page.getByRole("region", { name: "詳細", exact: true });
  await expect(detail).toContainText("(detached)");
  await expect(detail.getByText(worktree, { exact: true })).toBeVisible();
});

test("子の完了数は直接のdoneだけを数え、canceledと孫を含めない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const parent = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "親" });
  await page.goto(`/issues/${parent.id}`);
  await expect(page.getByRole("heading", { name: "Sub-issues 0/0" })).toBeVisible();
  const child = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "完了", parentRef: parent.id });
  await nod.me.updateIssue(child.id, { status: "done" });
  const canceled = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "中止", parentRef: parent.id });
  await nod.me.updateIssue(canceled.id, { status: "canceled" });
  await nod.me.createIssue({ workspaceId: api.workspace.id, title: "未完了", parentRef: parent.id });
  const grandchild = await nod.me.createIssue({ workspaceId: api.workspace.id, title: "孫", parentRef: child.id });
  await nod.me.updateIssue(grandchild.id, { status: "done" });
  await expect(page.getByRole("heading", { name: "Sub-issues 1/2 · キャンセル 1" })).toBeVisible();
});

test("タイトルを編集して保存すると履歴が残り、キャンセルと空白は保存しない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await api.startedIssue("元のタイトル");
  await page.goto(`/issues/${issue.id}`);
  await page.getByRole("heading", { level: 1 }).click();
  const box = page.getByRole("textbox", { name: "タイトル", exact: true });
  await box.fill("   ");
  await expect(page.getByRole("button", { name: "タイトルを保存" })).toBeDisabled();
  await box.fill("保存しない");
  await page.getByRole("button", { name: "タイトル編集をキャンセル" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("元のタイトル");
  await page.getByRole("heading", { level: 1 }).click();
  await box.fill("更新したタイトル");
  await page.getByRole("button", { name: "タイトルを保存" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("更新したタイトル");
  const events = (await api.show(issue.id)).activity.filter((a) => a.kind === "event" && a.type === "title_changed");
  expect(events).toMatchObject([{ actor: "me", data: { from: "元のタイトル", to: "更新したタイトル" } }]);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("更新したタイトル");
  await page.getByRole("heading", { level: 1 }).click();
  await page.getByRole("button", { name: "タイトルを保存" }).click();
  expect((await api.show(issue.id)).activity.filter((a) => a.kind === "event" && a.type === "title_changed")).toHaveLength(1);
});

test("IME変換中のEnterとSSE再取得でタイトルの下書きを失わない", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await api.startedIssue("元のタイトル");
  await page.goto(`/issues/${issue.id}`);
  await waitForServerEvents(page);
  await page.getByRole("heading", { level: 1 }).click();
  const box = page.getByRole("textbox", { name: "タイトル", exact: true });
  await box.fill("変換中の日本語");
  await box.dispatchEvent("compositionstart");
  await box.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, keyCode: 229 });
  await expect(box).toHaveValue("変換中の日本語");
  expect((await api.show(issue.id)).title).toBe("元のタイトル");
  await box.dispatchEvent("compositionend");
  await nod.codex.commentIssue(issue.id, "外部からの更新");
  await expect(page.getByRole("region", { name: "Activity", exact: true })).toContainText("外部からの更新");
  await expect(box).toHaveValue("変換中の日本語");
  await box.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("変換中の日本語");
});

test.describe("タイトル保存の失敗", () => {
  test.use({ allowedConsoleErrors: async ({}, use) => { await use([/status of 500/]); } });
  test("失敗時に下書きを保持し、再送中は二重保存を防ぐ", async ({ page, nod }) => {
    const api = await seedApiWorkspace(nod);
    const issue = await api.startedIssue("元のタイトル");
    await page.goto(`/issues/${issue.id}`);
    await page.route("**/api/issues/*/update", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "DB_BUSY", message: "保存できません" } }) }));
    await page.getByRole("heading", { level: 1 }).click();
    const box = page.getByRole("textbox", { name: "タイトル", exact: true });
    await box.fill("失敗しても残る");
    await page.getByRole("button", { name: "タイトルを保存" }).click();
    await expect(page.getByRole("alert")).toContainText("保存できません");
    await expect(box).toHaveValue("失敗しても残る");
    expect((await api.show(issue.id)).title).toBe("元のタイトル");
    await page.unroute("**/api/issues/*/update");
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/issues/*/update", async (route) => { await gate; await route.continue(); });
    await page.getByRole("button", { name: "タイトルを保存" }).click();
    await expect(box).toBeDisabled();
    await expect(page.getByRole("button", { name: "タイトルを保存" })).toBeDisabled();
    release();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("失敗しても残る");
    expect((await api.show(issue.id)).activity.filter((a) => a.kind === "event" && a.type === "title_changed")).toHaveLength(1);
  });
});

test("Inbox回答後のActivityは回答者と作業者を区別する", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await api.startedIssue("確認が必要", nod.codex);
  await api.ask(issue.id, "進めてよいか", nod.codex);
  await page.goto("/inbox");
  await page.getByRole("textbox", { name: "回答", exact: true }).fill("進めてよい");
  await page.getByRole("button", { name: "回答する", exact: true }).click();
  await expect(page.getByRole("region", { name: "確認依頼の一覧" }).getByText("確認依頼はありません", { exact: true })).toBeVisible();
  await page.goto(`/issues/${issue.id}`);
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  await expect(activity).toContainText("me の回答で codex の作業状況が 作業中 になった");
  await expect(activity).not.toContainText("me の作業状況が 作業中");
});

test.describe("詳細の再取得エラー", () => {
  test.use({ allowedConsoleErrors: async ({}, use) => { await use([/status of 500/, /status of 404/]); } });

  test("保存POSTと後続GETが失敗しても下書きを保ち、復旧後に同じ入力を再送できる", async ({ page, nod }) => {
    const api = await seedApiWorkspace(nod);
    const issue = await api.startedIssue("元のタイトル");
    await page.goto(`/issues/${issue.id}`);
    await waitForServerEvents(page);
    await page.getByRole("heading", { level: 1 }).click();
    const box = page.getByRole("textbox", { name: "タイトル", exact: true });
    await box.fill("接続が復旧したら再送する");
    const fail = { status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "DB_BUSY", message: "接続障害" } }) };
    await page.route(`**/api/issues/${issue.id}/update`, (route) => route.fulfill(fail));
    let getFailures = 0;
    await page.route(`**/api/issues/${issue.id}`, (route) => { getFailures += 1; return route.fulfill(fail); });
    await page.getByRole("button", { name: "タイトルを保存" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "最新の Issue を取得できませんでした" })).toBeVisible({ timeout: 20000 });
    expect(getFailures).toBeGreaterThanOrEqual(4);
    await expect(box).toHaveValue("接続が復旧したら再送する");
    await expect(page.getByRole("button", { name: "タイトルを保存" })).toBeEnabled();
    expect((await api.show(issue.id)).title).toBe("元のタイトル");
    await page.unroute(`**/api/issues/${issue.id}/update`);
    await page.unroute(`**/api/issues/${issue.id}`);
    await page.getByRole("button", { name: "タイトルを保存" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("接続が復旧したら再送する");
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect((await api.show(issue.id)).title).toBe("接続が復旧したら再送する");
  });

  test("初回取得失敗では編集画面を出さない", async ({ page }) => {
    await page.route("**/api/issues/API-1", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "DB_BUSY", message: "接続障害" } }) }));
    await page.goto("/issues/API-1");
    await expect(page.getByRole("heading", { name: "読み込めませんでした" })).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole("button", { name: "タイトルを保存" })).toHaveCount(0);
  });

  test("取得済みでもNOT_FOUNDなら見つかりませんを表示する", async ({ page, nod }) => {
    const api = await seedApiWorkspace(nod);
    const issue = await api.startedIssue("削除される Issue");
    await page.goto(`/issues/${issue.id}`);
    await waitForServerEvents(page);
    await page.getByRole("heading", { level: 1 }).click();
    await page.getByRole("textbox", { name: "タイトル", exact: true }).fill("保存できない");
    const fail = { status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Issue が見つかりません" } }) };
    await page.route(`**/api/issues/${issue.id}/update`, (route) => route.fulfill(fail));
    await page.route(`**/api/issues/${issue.id}`, (route) => route.fulfill(fail));
    await page.getByRole("button", { name: "タイトルを保存" }).click();
    await expect(page.getByRole("heading", { name: "Issue が見つかりません" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "タイトル", exact: true })).toHaveCount(0);
  });
});

test("手動でTodoへ戻した作業状況の解除をActivityで説明する", async ({ page, nod }) => {
  const api = await seedApiWorkspace(nod);
  const issue = await api.startedIssue("状態を解除する", nod.codex);
  await page.goto(`/issues/${issue.id}`);
  await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("todo");
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  await expect(activity).toContainText("me が codex の作業状況を解除した");
  await expect(activity).not.toContainText("null");
  const event = (await api.show(issue.id)).activity.filter((a) => a.kind === "event" && a.type === "agent_state_changed").at(-1);
  expect(event).toMatchObject({ actor: "me", data: { from: "working", to: null, agent: "codex" } });
});
