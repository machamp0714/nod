import { expect, test } from "./fixtures";
import { chooseProperty, property, propertyMenu } from "./helpers";

test.use({ dataset: "issue-list" });

// ブラウザと同じローカルの暦日（e2e のブラウザは Node と同じマシンで動く）
function localDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

test("Initiative を作り、Project を紐付け・外し、状態と目標日を変え、Project 詳細に所属を出す", async ({ page, nod }) => {
  await page.goto("/issues");
  await page.getByRole("link", { name: "Initiatives" }).click();
  await expect(page).toHaveURL(/\/initiatives$/);
  await expect(page.getByText("Initiative はありません")).toBeVisible();

  await page.getByRole("button", { name: "New initiative" }).click();
  const dialog = page.getByRole("dialog", { name: "New initiative" });
  await dialog.getByRole("button", { name: "作成" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("名前を入力してください");
  await dialog.getByLabel("名前").fill("検索基盤の刷新");
  await dialog.getByLabel("説明").fill("検索の速度と精度を上げる");
  await dialog.getByLabel("目標日").fill("2026-12-20");
  await dialog.getByRole("button", { name: "作成" }).click();
  await expect(page).toHaveURL(/\/initiatives\/\d+$/);
  await expect(page.getByRole("heading", { level: 1, name: "検索基盤の刷新" })).toBeVisible();
  await expect(page.getByText("この Initiative に Project はありません。「Project を追加」から紐づけます")).toBeVisible();

  const add = page.getByRole("combobox", { name: "Project を追加" });
  await add.selectOption({ label: "検索 API の高速化" });
  await add.selectOption({ label: "決済まわり" });
  const projects = page.getByRole("region", { name: "配下の Project" });
  await expect(projects.getByRole("listitem")).toHaveCount(2);
  const [initiative] = await nod.me.listInitiatives({ includeClosed: true });
  const detail = await nod.me.getInitiative(String(initiative!.id));
  expect(detail.projects.map((p) => p.name)).toEqual(["検索 API の高速化", "決済まわり"]);
  await expect(page.getByText(`Issue ${detail.done}/${detail.total} 完了`)).toBeVisible();

  await page.getByRole("combobox", { name: "Status" }).selectOption({ label: "Active" });
  await expect.poll(async () => (await nod.me.getInitiative(String(initiative!.id))).status).toBe("started");
  const target = page.getByLabel("目標日");
  await target.fill("2027-01-31");
  await target.blur();
  await expect.poll(async () => (await nod.me.getInitiative(String(initiative!.id))).targetDate).toBe("2027-01-31");

  await projects.getByRole("button", { name: "決済まわり の紐付けを外す" }).click();
  await expect(projects.getByRole("listitem")).toHaveCount(1);

  await projects.getByRole("link", { name: "検索 API の高速化" }).click();
  const chip = page.getByRole("link", { name: /Initiative\s*検索基盤の刷新/ });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page).toHaveURL(new RegExp(`/initiatives/${initiative!.id}$`));

  await page.goto("/initiatives");
  const row = page.getByRole("row", { name: /検索基盤の刷新/ });
  await expect(row).toContainText("Active");
  await expect(row).toContainText("2027-01-31");
  await expect(row.getByRole("cell").last()).toHaveText("1");
});

test.describe("Initiative の編集（#154）", () => {
  test.use({ allowedConsoleErrors: [/status of 409/] });

  test("詳細の「編集」で名前と説明を直し、空・重複の名前は欄の下に理由を出して保存しない", async ({ page, nod }) => {
    await nod.me.createInitiative({ name: "決済の信頼性向上" });
    const target = await nod.me.createInitiative({ name: "検索基盤の刷新", description: "旧い説明" });
    await page.goto(`/initiatives/${target.id}`);
    await page.getByRole("button", { name: "編集" }).click();
    const dialog = page.getByRole("dialog", { name: "Initiative を編集" });
    await expect(dialog.getByLabel("名前")).toHaveValue("検索基盤の刷新");
    await expect(dialog.getByLabel("説明")).toHaveValue("旧い説明");

    await dialog.getByLabel("名前").fill(" ");
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog.getByText("名前を入力してください")).toBeVisible();
    await dialog.getByLabel("名前").fill("決済の信頼性向上");
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog.getByText("同じ名前の Initiative「決済の信頼性向上」があります")).toBeVisible();
    await expect(dialog.getByLabel("名前")).toHaveAttribute("aria-invalid", "true");
    expect((await nod.me.getInitiative(String(target.id))).name).toBe("検索基盤の刷新");

    await dialog.getByLabel("名前").fill("  検索基盤の刷新 v2 ");
    await dialog.getByLabel("説明").fill("検索の速度と精度を上げる\nUI もまとめて追う");
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("heading", { level: 1, name: "検索基盤の刷新 v2" })).toBeVisible();
    const saved = await nod.me.getInitiative(String(target.id));
    expect([saved.name, saved.description]).toEqual(["検索基盤の刷新 v2", "検索の速度と精度を上げる\nUI もまとめて追う"]);

    // 説明を空にすると外れる。キャンセルでは何も変えない
    await page.getByRole("button", { name: "編集" }).click();
    await dialog.getByLabel("説明").fill("");
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog).toBeHidden();
    expect((await nod.me.getInitiative(String(target.id))).description).toBeNull();
    await page.getByRole("button", { name: "編集" }).click();
    await dialog.getByLabel("名前").fill("捨てる");
    await dialog.getByRole("button", { name: "キャンセル" }).click();
    await expect(dialog).toBeHidden();
    expect((await nod.me.getInitiative(String(target.id))).name).toBe("検索基盤の刷新 v2");
  });

  test("名前だけ直したとき、説明の字下げ・末尾の改行を消さない（#154）", async ({ page, nod }) => {
    const description = "  字下げした一行目\n- 箇条書き\n";
    const target = await nod.me.createInitiative({ name: "検索基盤の刷新", description });
    await page.goto(`/initiatives/${target.id}`);
    await page.getByRole("button", { name: "編集" }).click();
    const dialog = page.getByRole("dialog", { name: "Initiative を編集" });
    await dialog.getByLabel("名前").fill("検索基盤の刷新 v2");
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog).toBeHidden();
    const saved = await nod.me.getInitiative(String(target.id));
    expect([saved.name, saved.description]).toEqual(["検索基盤の刷新 v2", description]);
  });
});

test.describe("Cycle", () => {
  test.use({ allowedConsoleErrors: [/status of 409/] });

  test("Workspace を選んで Cycle を作り、重なりは理由を出して作らない", async ({ page, nod }) => {
    await page.goto("/cycles");
    await expect(page.getByText("Cycle はまだありません")).toBeVisible();
    await page.getByRole("button", { name: "New cycle" }).first().click();
    const dialog = page.getByRole("dialog", { name: "New cycle" });
    await dialog.getByLabel("Workspace").selectOption({ label: "nod" });
    await dialog.getByLabel("名前").fill("Sprint 12");
    await dialog.getByLabel("開始日").fill(localDate(-3));
    await dialog.getByLabel("終了日").fill(localDate(3));
    await dialog.getByRole("button", { name: "作成" }).click();
    await expect(dialog).toHaveCount(0);
    const group = page.getByRole("rowgroup", { name: "Workspace nod" });
    await expect(group.getByRole("row", { name: /Sprint 12/ })).toContainText("Current");

    await page.getByRole("button", { name: "New cycle" }).click();
    await dialog.getByLabel("Workspace").selectOption({ label: "nod" });
    await dialog.getByLabel("名前").fill("重なり");
    await dialog.getByLabel("開始日").fill(localDate(0));
    await dialog.getByLabel("終了日").fill(localDate(10));
    await dialog.getByRole("button", { name: "作成" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Sprint 12");
    await dialog.getByRole("button", { name: "キャンセル" }).click();
    expect((await nod.me.listAllCycles({})).map((c) => c.name)).toEqual(["Sprint 12"]);
  });

  test("終了した Cycle の未完了を確認のうえ現在の Cycle へ移し、Issues を Cycle で絞り・まとめる", async ({ page, nod }) => {
    const [api] = await nod.me.listWorkspaces().then((list) => list.filter((w) => w.key === "API"));
    const past = await nod.me.createCycle({ workspaceId: api!.id, name: "Sprint 11", startDate: localDate(-20), endDate: localDate(-7) });
    const current = await nod.me.createCycle({ workspaceId: api!.id, name: "Sprint 12", startDate: localDate(-6), endDate: localDate(7) });
    const issues = (await nod.me.queryIssues({ workspace: ["API"] })).issues;
    const [a, b, c] = issues.filter((i) => i.status !== "done" && i.status !== "canceled" && i.status !== "triage");
    const open = [a!, b!];
    const done = await nod.me.updateIssue(c!.id, { status: "done" });
    for (const issue of [...open, done]) await nod.me.updateIssue(issue.id, { cycleRef: String(past.id) });

    await page.goto(`/cycles/${past.id}`);
    await expect(page.getByRole("heading", { level: 1, name: "Sprint 11" })).toBeVisible();
    await expect(page.getByText("Completed", { exact: true })).toBeVisible();
    await expect(page.getByText("未完了 2", { exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "移動先" })).toHaveValue(String(current.id));
    await page.getByRole("button", { name: "未完了 2 件を別の Cycle へ移す" }).click();
    const confirm = page.getByRole("dialog", { name: "未完了 2 件を Sprint 12 へ移しますか？" });
    await expect(confirm).toContainText(open.map((i) => i.id).join("・"));
    await confirm.getByRole("button", { name: "移す" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByRole("button", { name: /件を別の Cycle へ移す/ })).toHaveCount(0);
    for (const issue of open) expect((await nod.me.getIssue(issue.id)).cycle?.name).toBe("Sprint 12");
    expect((await nod.me.getIssue(done.id)).cycle?.name).toBe("Sprint 11");

    await page.goto("/issues");
    await page.getByRole("combobox", { name: "Cycle" }).selectOption({ label: "Sprint 12（Current）" });
    // TanStack Router は数字の文字列を引用符つきで書く（cycle=%222%22）ため、値で確かめる
    await expect.poll(() => new URL(page.url()).searchParams.get("cycle")).toBe(`"${current.id}"`);
    await expect(page.getByRole("link", { name: open[0]!.title })).toBeVisible();
    await expect(page.getByRole("link", { name: done.title })).toHaveCount(0);
    await page.getByRole("combobox", { name: "Cycle" }).selectOption({ label: "Cycle なし" });
    await expect.poll(() => new URL(page.url()).searchParams.get("cycle")).toBe("none");
    await expect(page.getByRole("link", { name: open[0]!.title })).toHaveCount(0);
    const loose = issues.find((i) => i.status === "todo" && ![...open, done].some((o) => o.id === i.id))!;
    await expect(page.getByRole("link", { name: loose.title })).toBeVisible();
    await page.getByRole("combobox", { name: "Cycle" }).selectOption({ label: "すべて" });
    await expect(page).not.toHaveURL(/cycle=/);

    await page.getByLabel("グループ化", { exact: true }).selectOption({ label: "Cycle" });
    await expect(page).toHaveURL(/groupBy=cycle/);
    const headings = page.getByRole("heading", { level: 2 });
    await expect(headings.filter({ hasText: /Sprint|Cycleなし/ })).toHaveText([/Sprint 11（Completed）/, /Sprint 12（Current）/, /Cycleなし/]);
    await page.reload();
    await expect(page.getByLabel("グループ化", { exact: true })).toHaveValue("cycle");
  });

  test("消えた Cycle の ID が URL や保存済みの View に残ると、API を呼ばずにメッセージを出す", async ({ page, nod }) => {
    const [api] = await nod.me.listWorkspaces().then((list) => list.filter((w) => w.key === "API"));
    const gone = await nod.me.createCycle({ workspaceId: api!.id, name: "消す", startDate: localDate(-1), endDate: localDate(1) });
    const view = await nod.me.createView({ name: "消えた Cycle", filter: { cycle: String(gone.id) } });
    await nod.me.deleteCycle(api!.id, String(gone.id));
    const message = `条件の Cycle（${gone.id}）が見つかりません`;

    await page.goto(`/issues?cycle=${gone.id}`);
    await expect(page.getByRole("alert")).toHaveText(message);
    await page.goto(`/views/${view.id}`);
    await expect(page.getByRole("alert")).toHaveText(message);
  });

  test("Issue 詳細で同じ Workspace の Cycle に入れ、外せる", async ({ page, nod }) => {
    const [api] = await nod.me.listWorkspaces().then((list) => list.filter((w) => w.key === "API"));
    const [nodWs] = await nod.me.listWorkspaces().then((list) => list.filter((w) => w.key === "NOD"));
    await nod.me.createCycle({ workspaceId: api!.id, name: "Sprint 12", startDate: localDate(-1), endDate: localDate(1) });
    await nod.me.createCycle({ workspaceId: nodWs!.id, name: "他の Workspace", startDate: localDate(-1), endDate: localDate(1) });
    const issue = (await nod.me.queryIssues({ workspace: ["API"] })).issues.find((i) => i.status === "todo")!;
    await page.goto(`/issues/${issue.id}`);
    await property(page, "Cycle").click();
    await expect(propertyMenu(page, "Cycle").getByRole("menuitemradio")).toHaveText(["なし", "Sprint 12"]);
    await propertyMenu(page, "Cycle").getByRole("menuitemradio", { name: "Sprint 12", exact: true }).click();
    await expect.poll(async () => (await nod.me.getIssue(issue.id)).cycle?.name).toBe("Sprint 12");
    await expect(page.getByText("me が Cycle を Sprint 12 に変えた")).toBeVisible();
    await chooseProperty(page, "Cycle", "なし");
    await expect.poll(async () => (await nod.me.getIssue(issue.id)).cycle).toBeNull();
  });
});
