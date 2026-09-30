import { expect, test } from "./fixtures";

test.use({ dataset: "issue-list" });

const labelsSection = (page: import("@playwright/test").Page) => page.getByRole("region", { name: "ラベル", exact: true });
const statusSection = (page: import("@playwright/test").Page) => page.getByRole("region", { name: "ステータスの表示名" });

test("ラベル定義を追加・改名・削除でき、改名は Issue のラベルにも反映し、削除しても Issue のラベルは残る", async ({ page, nod }) => {
  await page.goto("/workspaces/API/settings");
  const section = labelsSection(page);
  await expect(section.getByText("ラベルの定義はありません")).toBeVisible();
  await expect(section.getByText("この Workspace の Issue に付けるラベルの色と説明。LLM は編集できません。")).toBeVisible();

  const add = section.getByRole("form", { name: "ラベルを追加" });
  await expect(add.getByRole("button", { name: "追加" })).toBeDisabled();
  await add.getByLabel("新しいラベルの色").selectOption({ label: "赤" });
  await add.getByRole("textbox", { name: "ラベル名" }).fill("perf");
  await add.getByRole("textbox", { name: "説明" }).fill("性能の改善・劣化に関わるもの");
  await add.getByRole("button", { name: "追加" }).click();
  await expect(page.getByRole("status")).toHaveText("追加しました");
  const row = section.getByRole("listitem").filter({ hasText: "perf" });
  await expect(row).toContainText("性能の改善・劣化に関わるもの");
  await expect(row).toContainText("1 件");
  await expect(add.getByRole("textbox", { name: "ラベル名" })).toHaveValue("");
  expect(await nod.me.listWorkspaceLabels("API")).toMatchObject([{ name: "perf", color: "#B91C1C", issueCount: 1 }]);

  // 同じ名前は追加できず、名前の欄を赤くして理由を示す
  await add.getByRole("textbox", { name: "ラベル名" }).fill("perf");
  await add.getByRole("button", { name: "追加" }).click();
  await expect(add.getByRole("alert")).toHaveText("同じ名前のラベル「perf」がすでにあります");
  await expect(add.getByRole("textbox", { name: "ラベル名" })).toHaveAttribute("aria-invalid", "true");
  await add.getByRole("textbox", { name: "ラベル名" }).fill("");

  // 改名すると API の Issue のラベルも置き換わる
  await row.getByRole("button", { name: "perf を編集" }).click();
  const edit = section.getByRole("form", { name: "perf を編集" });
  await edit.getByRole("textbox", { name: "ラベル名" }).fill("performance");
  await edit.getByLabel("perf の色").selectOption({ label: "青" });
  await edit.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("status")).toHaveText("保存しました");
  await expect(section.getByRole("listitem").filter({ hasText: "performance" })).toContainText("1 件");
  expect((await nod.me.getIssue("API-12")).labels).toEqual(["performance"]);
  expect(await nod.me.listWorkspaceLabels("API")).toMatchObject([{ name: "performance", color: "#2563EB" }]);

  // 編集はキャンセルできる
  await section.getByRole("button", { name: "performance を編集" }).click();
  await section.getByRole("form", { name: "performance を編集" }).getByRole("button", { name: "キャンセル" }).click();
  await expect(section.getByRole("form", { name: "performance を編集" })).toHaveCount(0);

  // 削除は確認し、定義だけを消す
  await section.getByRole("button", { name: "performance を削除" }).click();
  const dialog = page.getByRole("alertdialog", { name: "ラベル「performance」の定義を削除しますか？" });
  await expect(dialog).toContainText("定義を削除します。Issue のラベルは残ります");
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await nod.me.listWorkspaceLabels("API")).toHaveLength(1);
  await section.getByRole("button", { name: "performance を削除" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "削除する" }).click();
  await expect(section.getByText("ラベルの定義はありません")).toBeVisible();
  expect(await nod.me.listWorkspaceLabels("API")).toEqual([]);
  expect((await nod.me.getIssue("API-12")).labels).toEqual(["performance"]);
});

test("ステータスの表示名を保存すると、その Workspace の Issue の表示に使い、内部値は変えない", async ({ page, nod }) => {
  await page.goto("/workspaces/API/settings");
  const section = statusSection(page);
  await expect(section.getByText("表示名だけを変えます。状態の意味や遷移は変わりません。")).toBeVisible();
  const inProgress = section.getByRole("textbox", { name: "in_progress の表示名" });
  await expect(inProgress).toHaveAttribute("placeholder", "In Progress");
  await expect(section.getByRole("button", { name: "表示名を保存" })).toBeDisabled();
  await expect(section.getByRole("button", { name: "既定に戻す" })).toBeDisabled();

  // ほかのステータスと重なる名前は保存できない
  await inProgress.fill("Backlog");
  await expect(section.getByRole("alert")).toHaveText("表示名「Backlog」が複数のステータスで重なっています");
  await expect(section.getByRole("button", { name: "表示名を保存" })).toBeDisabled();

  await inProgress.fill("作業中");
  await section.getByRole("textbox", { name: "todo の表示名" }).fill("着手可");
  await section.getByRole("button", { name: "表示名を保存" }).click();
  await expect(page.getByRole("status")).toHaveText("保存しました");
  expect(await nod.me.getStatusNames("API")).toEqual({ workspaceKey: "API", names: { todo: "着手可", in_progress: "作業中" } });

  // Issue 詳細：ヘッダーと Status の選択肢は表示名、保存される値は内部値
  await page.goto("/issues/API-12");
  await expect(page.getByRole("combobox", { name: "Status" }).locator("option:checked")).toHaveText("作業中");
  expect((await nod.me.getIssue("API-12")).status).toBe("in_progress");

  const both = encodeURIComponent(JSON.stringify(["API", "NOD"]));
  // 一覧：Issue ごとの表示はその Workspace の表示名、ほかの Workspace は既定名
  await page.goto(`/issues?workspace=${both}`);
  await expect(page.locator('tr[data-issue-row="API-12"]')).toContainText("作業中");
  await expect(page.locator('tr[data-issue-row="API-13"]')).toContainText("着手可");
  await expect(page.locator('tr[data-issue-row="NOD-5"]')).toContainText("Todo");
  await expect(page.locator('tr[data-issue-row="NOD-5"]')).not.toContainText("着手可");

  // Workspace を1つに絞ると、カンバンの列見出しも表示名になる
  await page.goto("/issues?workspace=API&layout=board");
  await expect(page.getByRole("heading", { name: "作業中", level: 2 })).toBeVisible();
  await page.goto(`/issues?workspace=${both}&layout=board`);
  await expect(page.getByRole("heading", { name: "In Progress", level: 2 })).toBeVisible();

  // 既定に戻して保存すると、すべて既定名になる
  await page.goto("/workspaces/API/settings");
  await expect(statusSection(page).getByRole("textbox", { name: "in_progress の表示名" })).toHaveValue("作業中");
  await statusSection(page).getByRole("button", { name: "既定に戻す" }).click();
  await expect(statusSection(page).getByRole("textbox", { name: "in_progress の表示名" })).toHaveValue("");
  await statusSection(page).getByRole("button", { name: "表示名を保存" }).click();
  await expect(page.getByRole("status")).toHaveText("保存しました");
  expect((await nod.me.getStatusNames("API")).names).toEqual({});
});

test("CLI など別の場所での変更を表示する", async ({ page, nod }) => {
  await nod.me.addWorkspaceLabel("NOD", { name: "docs", color: "#0D9768", description: "ドキュメントのみの変更" });
  await nod.me.setStatusNames("NOD", { in_review: "レビュー待ち" });
  await page.goto("/workspaces/NOD/settings");
  await expect(labelsSection(page).getByRole("listitem").filter({ hasText: "docs" })).toContainText("ドキュメントのみの変更");
  await expect(statusSection(page).getByRole("textbox", { name: "in_review の表示名" })).toHaveValue("レビュー待ち");
  // API の設定には NOD の定義を出さない
  await page.goto("/workspaces/API/settings");
  await expect(labelsSection(page).getByText("ラベルの定義はありません")).toBeVisible();
});

test.describe("保存の失敗", () => {
  test.use({ allowedConsoleErrors: [/status of 500/] });
  test("ラベルの追加に失敗すると理由を示し、入力を保つ", async ({ page, nod }) => {
    await page.route("**/api/workspaces/API/labels", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "UNEXPECTED", message: "保存に失敗しました" } }) })
        : route.fallback(),
    );
    await page.goto("/workspaces/API/settings");
    const add = labelsSection(page).getByRole("form", { name: "ラベルを追加" });
    await add.getByRole("textbox", { name: "ラベル名" }).fill("bug");
    await add.getByRole("button", { name: "追加" }).click();
    await expect(add.getByRole("alert")).toHaveText("保存に失敗しました");
    await expect(add.getByRole("textbox", { name: "ラベル名" })).toHaveValue("bug");
    expect(await nod.me.listWorkspaceLabels("API")).toEqual([]);
  });
});

// #117: Issue 側のラベル表示は Dot だけをラベル定義の色にし、未定義のラベルは既定の灰色（--ink3）
test("定義したラベルの色を一覧・プレビュー・Issue 詳細の Dot に出し、未定義のラベルは灰色のまま", async ({ page, nod }) => {
  await nod.me.addWorkspaceLabel("API", { name: "perf", color: "#B91C1C", description: "" });
  // 同じ名前でも別の Workspace の定義は使わない
  await nod.me.addWorkspaceLabel("NOD", { name: "security", color: "#2563EB", description: "" });
  await nod.me.updateIssue("API-12", { addLabels: ["security"] });
  const dot = (scope: import("@playwright/test").Locator, name: string) => scope.locator(`[data-label="${name}"] > [data-label-color]`);

  await page.goto("/issues");
  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: "検索 API の N+1 を解消", exact: true }) });
  await expect(dot(row, "perf")).toHaveAttribute("data-label-color", "#B91C1C");
  await expect(dot(row, "perf")).toHaveCSS("background-color", "rgb(185, 28, 28)");
  await expect(dot(row, "security")).toHaveAttribute("data-label-color", "default");
  const ink3 = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--ink3)";
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  await expect(dot(row, "security")).toHaveCSS("background-color", ink3);

  await row.hover();
  await row.getByRole("button", { name: "API-12 をプレビュー", exact: true }).click();
  const pane = page.getByRole("complementary", { name: "API-12 のプレビュー", exact: true });
  await expect(dot(pane, "perf")).toHaveCSS("background-color", "rgb(185, 28, 28)");
  await expect(dot(pane, "security")).toHaveAttribute("data-label-color", "default");

  await page.goto("/issues/API-12");
  await expect(dot(page.locator("body"), "perf")).toHaveCSS("background-color", "rgb(185, 28, 28)");
  await expect(page.getByRole("button", { name: "ラベル perf を外す" })).toBeVisible();

  // 定義の色を変えると表示も変わる
  await nod.me.updateWorkspaceLabel("API", "perf", { color: "#0D9768" });
  await page.reload();
  await expect(dot(page.locator("body"), "perf")).toHaveCSS("background-color", "rgb(13, 151, 104)");
});
