import { expect, test, waitForServerEvents } from "./fixtures";
import { chooseDisplay, closeDisplay, displaySelect, searchBox } from "./support/issue-list";

test.use({ dataset: "issue-list" });
const statusControl = (page: import("@playwright/test").Page) => page.getByRole("combobox", { name: "Project のステータス" });

test("概要から完了・中止・再開し、タブの分類とIssue・Documentsを保持する", async ({ page, nod }) => {
  const before = await nod.me.getProject("1");
  await page.goto("/projects/1?layout=board&q=API");
  await expect(statusControl(page)).toHaveValue("started");
  await statusControl(page).selectOption("completed");
  await expect(statusControl(page)).toBeEnabled();
  await expect(statusControl(page)).toHaveValue("completed");
  await expect(page).toHaveURL(/layout=board/);
  await expect(page).toHaveURL(/q=API/);
  await expect(page.getByRole("link", { name: "検索 API の高速化 設計" })).toBeVisible();
  await page.goto("/projects?tab=completed");
  await expect(page.getByRole("link", { name: "検索 API の高速化" })).toBeVisible();
  await page.goto("/projects");
  await expect(page.getByRole("link", { name: "検索 API の高速化" })).toHaveCount(0);
  await page.goto("/projects/1");
  await statusControl(page).selectOption("canceled");
  await expect(statusControl(page)).toHaveValue("canceled");
  await page.goto("/projects?tab=completed");
  await expect(page.getByRole("link", { name: "検索 API の高速化" })).toHaveCount(0);
  await page.goto("/projects?tab=all");
  await page.getByRole("link", { name: "検索 API の高速化" }).click();
  for (const status of ["started", "planned"]) {
    await statusControl(page).selectOption(status);
    await expect(statusControl(page)).toHaveValue(status);
    await page.goto("/projects");
    await page.getByRole("link", { name: "検索 API の高速化" }).click();
  }
  const after = await nod.me.getProject("1");
  expect(after.issues).toEqual(before.issues);
  expect(after.documents).toEqual(before.documents);
});

test.describe("保存状態", () => {
  test.use({ allowedConsoleErrors: [/status of 400/] });
  test("保存中は連打を防ぎ、失敗時は元の値を保ち、再試行できる", async ({ page }) => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/projects/1/update", async (route) => {
      await waiting;
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { code: "INVALID_ARGS", message: "保存に失敗しました" } }) });
    });
    try {
      await page.goto("/projects/1");
      await statusControl(page).selectOption("completed");
      await expect(statusControl(page)).toBeDisabled();
      await expect(page.getByRole("status").filter({ hasText: "保存中" })).toBeVisible();
      release();
      await expect(page.getByRole("alert")).toContainText("保存に失敗しました");
      await expect(statusControl(page)).toBeEnabled();
      await expect(statusControl(page)).toHaveValue("started");
      await page.unroute("**/api/projects/1/update");
      await statusControl(page).selectOption("completed");
      await expect(statusControl(page)).toHaveValue("completed");
      await expect(page.getByRole("alert")).toHaveCount(0);
    } finally { release(); }
  });
});

test("外部のProject更新がSSEで一覧と開いた詳細に反映する", async ({ page, nod }) => {
  await page.goto("/projects?tab=completed");
  await waitForServerEvents(page);
  await nod.codex.updateProject("1", { status: "completed" });
  await expect(page.getByRole("link", { name: "検索 API の高速化" })).toBeVisible();
  await page.getByRole("link", { name: "検索 API の高速化" }).click();
  await expect(statusControl(page)).toHaveValue("completed");
  await waitForServerEvents(page);
  await nod.codex.updateProject("1", { status: "started" });
  await expect(statusControl(page)).toHaveValue("started");
});

test("完了した Issue はレビュー待ちを出さず、作業中・入力待ち・エラーを表示する", async ({ page, nod }) => {
  await nod.me.createProject({ name: "活動なし" });
  await page.goto("/projects");
  await waitForServerEvents(page);
  const source = page.getByRole("row", { name: /決済まわり/ });
  await expect(source).not.toContainText("レビュー待ち");
  await expect(source).toContainText("入力待ち 1");
  await expect(page.getByRole("row", { name: /活動なし/ }).getByRole("cell").nth(4)).toHaveText("—");
  const working = await nod.me.createIssue({ workspaceId: 1, title: "並行作業", projectRef: "1" });
  await nod.codex.startIssue(working.id);
  await expect(page.getByRole("row", { name: /検索 API の高速化/ })).toContainText("作業中 1");
  await nod.codex.failIssue(working.id, "追加調査");
  await expect(page.getByRole("row", { name: /検索 API の高速化/ })).toContainText("エラー 1");
});

for (const layout of ["list", "board"]) {
  test(`Project状態保存後も${layout}の検索・グループ化・blocked条件を保持する`, async ({ page, nod }) => {
    await nod.me.updateIssue("API-13", { description: "統合確認用の検索語" });
    await page.goto(`/projects/1?layout=${layout}`);
    await chooseDisplay(page, "グループ化", "Workspace");
    await closeDisplay(page);
    await page.getByLabel("ブロック", { exact: true }).selectOption("true");
    await (await searchBox(page)).fill("統合確認用");
    const group = page.getByRole("region", { name: "Workspace API", exact: true });
    await expect(group).toContainText("API-13");
    const url = page.url();
    const search = new URL(url).searchParams;
    expect(search.get("groupBy")).toBe("workspace");
    expect(search.get("blocked")).toBe("true");
    expect(search.get("q")).toBe("統合確認用");
    await statusControl(page).selectOption("completed");
    await expect(statusControl(page)).toBeEnabled();
    await expect(statusControl(page)).toHaveValue("completed");
    expect((await nod.me.getProject("1")).status).toBe("completed");
    await expect(page).toHaveURL(url);
    await expect(group).toContainText("API-13");
    await page.reload();
    await expect(page).toHaveURL(url);
    await expect(statusControl(page)).toHaveValue("completed");
    await expect(page.getByLabel("ブロック", { exact: true })).toHaveValue("true");
    await expect(page.getByRole("textbox", { name: "検索", exact: true })).toHaveValue("統合確認用");
    await expect(await displaySelect(page, "グループ化")).toHaveAttribute("data-value", "workspace");
    await expect(page.getByRole("tab", { name: layout === "board" ? "Board" : "List", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(group).toContainText("API-13");
    await expect(group).not.toContainText("API-9");
  });
}
