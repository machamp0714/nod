import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import type { NodData } from "./support/nod";

// issue-list に私の担当を足す：API-4・NOD-5（Todo）を me に、API-9（Needs Clarification）を一覧にない担当 gemini に割り当てる。
// 委任中は claude-code の API-12・API-7・BLOG-2、codex の API-8、gemini の API-9。NOD-3 は claude-code の担当だが done
test.use({ dataset: "issue-list" });

async function assign(nod: NodData) {
  await nod.me.updateIssue("API-4", { assignee: "me" });
  await nod.me.updateIssue("NOD-5", { assignee: "me" });
  await nod.me.updateIssue("API-9", { assignee: "gemini" });
}

const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const tableRows = (page: Page) => page.locator("tbody tr");
const chips = (page: Page) => page.getByRole("group", { name: "絞り込み条件" });

test.describe("My issues", () => {
  test("Sidebar から開くと担当タブに私の担当だけを Status でまとめて出し、担当の条件は外せない", async ({ page, nod }) => {
    await assign(nod);
    await page.goto("/inbox");
    const nav = page.getByRole("navigation", { name: "メイン" });
    await nav.getByRole("link", { name: "My issues" }).click();
    await expect(page).toHaveURL(/\/my-issues$/);
    await expect(page.getByRole("heading", { level: 1, name: "My issues" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "My issues" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "My issues" })).toHaveText("My issues");

    await expect(page.getByRole("tab")).toHaveText(["担当 2", "委任中 5", "List", "Board"]);
    await expect(page.getByRole("tab", { name: "担当 2", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("グループ化", { exact: true })).toHaveValue("status");
    await expect(region(page, "Status Todo").locator("tbody tr")).toHaveCount(2);
    await expect(tableRows(page)).toHaveCount(2);
    await expect(tableRows(page)).toContainText(["NOD-5", "API-4"]);

    await expect(chips(page)).toContainText(/担当\s*is\s*me/);
    await expect(chips(page).getByRole("button", { name: "担当 の条件を外す" })).toHaveCount(0);
    // 件数カードと「View として保存」は置かない
    await expect(page.getByRole("button", { name: /^Ready/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "View として保存" })).toHaveCount(0);
  });

  test("委任中タブは LLM ごとに担当でまとめ、URL で復元し、担当タブに戻ると URL から消す", async ({ page, nod }) => {
    await assign(nod);
    await page.goto("/my-issues");
    await page.getByRole("tab", { name: "委任中 5", exact: true }).click();
    await expect(page).toHaveURL(/tab=delegated/);
    await expect(page).not.toHaveURL(/groupBy=/);
    await expect(page.getByLabel("グループ化", { exact: true })).toHaveValue("assignee");
    await expect(region(page, "担当 claude-code").locator("tbody tr")).toHaveCount(3);
    await expect(region(page, "担当 claude-code").getByRole("heading").getByLabel("作業状況の内訳")).toHaveText("入力待ち 2完了 1");
    await expect(region(page, "担当 codex").locator("tbody tr")).toHaveCount(1);
    await expect(region(page, "担当 gemini").locator("tbody tr")).toHaveCount(1);
    await expect(tableRows(page)).toHaveCount(5);

    await page.reload();
    await expect(page.getByRole("tab", { name: "委任中 5", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(region(page, "担当 codex").locator("tbody tr")).toHaveCount(1);

    await page.getByRole("tab", { name: "担当 2", exact: true }).click();
    await expect(page).not.toHaveURL(/tab=/);
    await expect(tableRows(page)).toHaveCount(2);
  });

  test("ほかの条件で絞り込め、URL に残る。担当の条件と Issues のタブは URL にあっても使わない", async ({ page, nod }) => {
    await assign(nod);
    await page.goto(`/my-issues?assignee=${encodeURIComponent(JSON.stringify(["codex"]))}&tab=ready`);
    await expect(page.getByRole("tab", { name: "担当 2", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(tableRows(page)).toHaveCount(2);

    await page.getByText("Filter", { exact: true }).click();
    await expect(page.getByRole("group", { name: "担当", exact: true })).toHaveCount(0);
    await page.getByRole("group", { name: "Workspace" }).getByRole("checkbox", { name: "nod", exact: true }).check();
    await expect(page).toHaveURL(/workspace=/);
    await expect(page).not.toHaveURL(/assignee=|tab=/);
    await expect(page.getByRole("tab")).toContainText(["担当 1", "委任中 0"]);
    await expect(tableRows(page)).toHaveCount(1);
    await expect(tableRows(page)).toContainText("NOD-5");

    await page.reload();
    await expect(tableRows(page)).toHaveCount(1);
    await page.getByRole("tab", { name: "委任中 0", exact: true }).click();
    await expect(page.getByText("LLM に委任中の Issue はありません", { exact: true })).toBeVisible();
  });

  test("「なし」を選ぶとフラットに出し、再読み込みしても保つ。完了済みは表示設定に従う", async ({ page, nod }) => {
    await assign(nod);
    await nod.me.updateIssue("NOD-5", { status: "done" });
    await page.goto("/my-issues");
    await expect(region(page, "Status Done").locator("tbody tr")).toHaveCount(1);
    await page.getByLabel("グループ化", { exact: true }).selectOption("none");
    await expect(page).toHaveURL(/groupBy=none/);
    await expect(page.getByRole("region", { name: /^Status / })).toHaveCount(0);
    await expect(tableRows(page)).toHaveCount(2);
    await page.reload();
    await expect(page.getByLabel("グループ化", { exact: true })).toHaveValue("none");

    await page.getByText("表示設定", { exact: true }).click();
    await page.getByRole("checkbox", { name: "完了済みIssueを表示" }).uncheck();
    await expect(tableRows(page)).toHaveCount(1);
    await expect(tableRows(page)).toContainText("API-4");
  });

  test("私の担当がなければ空の状態を出す", async ({ page }) => {
    await page.goto("/my-issues");
    await expect(page.getByRole("tab", { name: "担当 0", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("担当している Issue はありません", { exact: true })).toBeVisible();
    await expect(tableRows(page)).toHaveCount(0);
  });
});

test.describe("Issues の担当フィルタ", () => {
  test("担当を選ぶとどれかに合う Issue に絞り、チップと URL に残し、外せる", async ({ page, nod }) => {
    await assign(nod);
    await page.goto("/issues");
    await expect(tableRows(page)).toHaveCount(13);
    await page.getByText("Filter", { exact: true }).click();
    const group = page.getByRole("group", { name: "担当", exact: true });
    // me・claude-code・codex に続けて、Issue に現れるほかの担当と「未割り当て」を出す
    await expect(group.getByRole("checkbox")).toHaveCount(5);
    await expect(group.locator("label > span:last-of-type")).toHaveText(["me", "claude-code", "codex", "gemini", "未割り当て"]);

    await group.getByRole("checkbox", { name: "me", exact: true }).check();
    await expect(tableRows(page)).toHaveCount(2);
    await expect(chips(page)).toContainText(/担当\s*is\s*me/);
    expect(new URL(page.url()).searchParams.get("assignee")).toBe(JSON.stringify(["me"]));
    // 件数カードとタブの件数も担当の範囲で数える
    await expect(page.getByRole("tab", { name: "All 2", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Ready 2", exact: true })).toBeVisible();

    await group.getByRole("checkbox", { name: "claude-code", exact: true }).check();
    await expect(tableRows(page)).toHaveCount(6);
    await expect(chips(page)).toContainText(/担当\s*is\s*me, claude-code/);

    await page.reload();
    await expect(tableRows(page)).toHaveCount(6);
    await expect(chips(page)).toContainText(/担当\s*is\s*me, claude-code/);
    await chips(page).getByRole("button", { name: "担当 の条件を外す" }).click();
    await expect(tableRows(page)).toHaveCount(13);
    await expect(page).not.toHaveURL(/assignee=/);
  });

  test("手で書いたカンマ区切りの assignee も、API と同じく分けてチップとパネルに出す（#166）", async ({ page, nod }) => {
    await assign(nod);
    await page.goto("/issues?assignee=me,claude-code");
    await expect(tableRows(page)).toHaveCount(6);
    await expect(chips(page)).toContainText(/担当\s*is\s*me, claude-code/);
    await page.getByText("Filter", { exact: true }).click();
    const group = page.getByRole("group", { name: "担当", exact: true });
    await expect(group.getByRole("checkbox", { name: "me", exact: true })).toBeChecked();
    await expect(group.getByRole("checkbox", { name: "claude-code", exact: true })).toBeChecked();
    // カンマ入りの名前の選択肢は足さない
    await expect(group.getByRole("checkbox")).toHaveCount(5);
    await group.getByRole("checkbox", { name: "me", exact: true }).uncheck();
    await expect(tableRows(page)).toHaveCount(4);
    expect(new URL(page.url()).searchParams.get("assignee")).toBe(JSON.stringify(["claude-code"]));
  });

  test("未割り当てと一覧にない担当でも絞り込め、ほかの条件と組み合わせられる", async ({ page, nod }) => {
    await assign(nod);
    await page.goto(`/issues?assignee=${encodeURIComponent(JSON.stringify(["none"]))}`);
    await expect(tableRows(page)).toHaveCount(5);
    await expect(chips(page)).toContainText(/担当\s*is\s*未割り当て/);
    await page.getByText("Filter", { exact: true }).click();
    const group = page.getByRole("group", { name: "担当", exact: true });
    await expect(group.getByRole("checkbox", { name: "未割り当て", exact: true })).toBeChecked();
    await group.getByRole("checkbox", { name: "gemini", exact: true }).check();
    await expect(tableRows(page)).toHaveCount(6);
    await page.getByRole("group", { name: "Workspace" }).getByRole("checkbox", { name: "api-server", exact: true }).check();
    await expect(tableRows(page)).toHaveCount(4);
    await expect(tableRows(page)).toContainText(["API-9"]);
  });

  test("担当の条件を View として保存でき、View でもチップから外せる", async ({ page, nod }) => {
    await assign(nod);
    await page.goto(`/issues?assignee=${encodeURIComponent(JSON.stringify(["me"]))}`);
    await expect(tableRows(page)).toHaveCount(2);
    await page.getByRole("button", { name: "View として保存" }).click();
    const dialog = page.getByRole("dialog", { name: "View として保存" });
    await dialog.getByRole("textbox", { name: "名前" }).fill("私の担当");
    await dialog.getByRole("button", { name: "保存" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "私の担当" })).toBeVisible();
    await expect(tableRows(page)).toHaveCount(2);
    const views = (await (await page.request.get("/api/views")).json()) as unknown[];
    expect(views.at(-1)).toMatchObject({ name: "私の担当", filter: { assignee: ["me"] } });

    await chips(page).getByRole("button", { name: "担当 の条件を外す" }).click();
    await expect(tableRows(page)).toHaveCount(13);
    await expect(page.getByRole("button", { name: "変更を保存" })).toBeVisible();
  });
});
