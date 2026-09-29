import { expect, test } from "./fixtures";

// issue-list の委任中：claude-code に API-12・BLOG-2（入力待ち）と API-7（In Review・完了）、codex に API-8（入力待ち）。
// NOD-3 は claude-code の担当だが done なので出さない
test.use({ dataset: "issue-list" });

const region = (page: import("@playwright/test").Page, name: string) => page.getByRole("region", { name, exact: true });

test("委任中タブは LLM ごとに担当でまとめ、作業状況の内訳を出し、URL で復元する", async ({ page }) => {
  await page.goto("/issues?sort=title");
  await page.getByRole("tab", { name: "委任中 4", exact: true }).click();
  await expect(page).toHaveURL(/tab=delegated/);
  // 担当でのまとめは委任中タブの既定の表示で、URL には書かない（タブを離れると元に戻る）
  await expect(page).not.toHaveURL(/groupBy=/);
  await expect(page.getByLabel("グループ化", { exact: true })).toHaveValue("assignee");

  const claude = region(page, "担当 claude-code");
  await expect(claude.locator("tbody tr")).toHaveCount(3);
  const breakdown = claude.getByRole("heading").getByLabel("作業状況の内訳");
  await expect(breakdown).toHaveText("入力待ち 2完了 1");
  await expect(claude.getByRole("row").filter({ hasText: "API-7" })).toContainText("完了");
  const codex = region(page, "担当 codex");
  await expect(codex.locator("tbody tr")).toHaveCount(1);
  await expect(codex.getByRole("heading").getByLabel("作業状況の内訳")).toHaveText("入力待ち 1");
  await expect(page.getByRole("link", { name: "nod issue next の取り合いを防ぐ", exact: true })).toHaveCount(0);
  await expect(region(page, "担当 未割り当て")).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("tab", { name: "委任中 4", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(region(page, "担当 claude-code").locator("tbody tr")).toHaveCount(3);
  await expect(page).toHaveURL(/sort=title/);

  // 利用者が選んだグループ化はタブを選び直しても上書きしない
  await page.getByLabel("グループ化", { exact: true }).selectOption("workspace");
  await page.getByRole("tab", { name: /^All / }).click();
  await page.getByRole("tab", { name: "委任中 4", exact: true }).click();
  await expect(page).toHaveURL(/groupBy=workspace/);
  await expect(region(page, "担当 claude-code")).toHaveCount(0);
});

test("直リンクの委任中タブは担当でまとめ、タブを離れると元のフラットな一覧に戻る", async ({ page }) => {
  await page.goto("/issues?tab=delegated");
  await expect(region(page, "担当 claude-code").locator("tbody tr")).toHaveCount(3);
  await expect(region(page, "担当 codex").locator("tbody tr")).toHaveCount(1);

  await page.getByRole("tab", { name: /^All / }).click();
  await expect(page).not.toHaveURL(/tab=|groupBy=/);
  await expect(page.getByLabel("グループ化", { exact: true })).toHaveValue("none");
  await expect(page.getByRole("region", { name: /^担当 / })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "nod issue next の取り合いを防ぐ", exact: true })).toBeVisible();
});

test("委任中タブで「なし」を選ぶとフラットに出し、再読み込みしても保ち、タブを離れると URL から消す", async ({ page }) => {
  await page.goto("/issues?tab=delegated");
  await expect(region(page, "担当 claude-code")).toBeVisible();
  await page.getByLabel("グループ化", { exact: true }).selectOption("none");
  await expect(page).toHaveURL(/groupBy=none/);
  await expect(page.getByRole("region", { name: /^担当 / })).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: "API-8" })).toHaveCount(1);

  await page.reload();
  await expect(page.getByLabel("グループ化", { exact: true })).toHaveValue("none");
  await expect(page.getByRole("row").filter({ hasText: "API-8" })).toHaveCount(1);
  await expect(page.getByRole("region", { name: /^担当 / })).toHaveCount(0);

  await page.getByRole("tab", { name: /^All / }).click();
  await expect(page).not.toHaveURL(/groupBy=/);
});

test("委任中タブで View として保存すると、その View は委任中だけを出す", async ({ page }) => {
  await page.goto("/issues?tab=delegated&groupBy=assignee");
  await page.getByRole("button", { name: "View として保存" }).click();
  const dialog = page.getByRole("dialog", { name: "View として保存" });
  await dialog.getByRole("textbox", { name: "名前" }).fill("委任中");
  await dialog.getByRole("button", { name: "保存" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "委任中" })).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(4);
  const views = (await (await page.request.get("/api/views")).json()) as unknown[];
  expect(views.at(-1)).toMatchObject({ name: "委任中", filter: { delegated: true } });
});

test("委任中の Issue がなければ空の状態を出す", async ({ page }) => {
  await page.goto("/issues?tab=delegated&workspace=NOD");
  await expect(page.getByText("LLM に委任中の Issue はありません", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "委任中 0", exact: true })).toBeVisible();
});
