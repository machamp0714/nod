import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import type { NodData } from "./support/nod";
import { chooseDisplay, closeDisplay, displaySelect, displaySwitch, openDisplay } from "./support/issue-list";

// issue-list に私の担当を足す：API-4・NOD-5（Todo）を me に、API-9（Needs Clarification）を一覧にない担当 gemini に割り当てる。
// LLM の担当は claude-code の API-12・API-7・BLOG-2・NOD-3（done）、codex の API-8、gemini の API-9
test.use({ dataset: "issue-list" });

async function assign(nod: NodData) {
  await nod.me.updateIssue("API-4", { assignee: "me" });
  await nod.me.updateIssue("NOD-5", { assignee: "me" });
  await nod.me.updateIssue("API-9", { assignee: "gemini" });
}

const LLM_ISSUES = ["API-12", "API-7", "BLOG-2", "NOD-3", "API-8"];

const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const tableRows = (page: Page) => page.locator("tbody tr");
const chips = (page: Page) => page.getByRole("group", { name: "絞り込み条件" });

test.describe("My issues", () => {
  test("Sidebar から開くと担当が me と LLM の Issue をまとめて Status ごとに出し、担当の条件は外せない", async ({ page, nod }) => {
    await assign(nod);
    await page.goto("/inbox");
    const nav = page.getByRole("navigation", { name: "メイン" });
    await nav.getByRole("link", { name: "My issues" }).click();
    await expect(page).toHaveURL(/\/my-issues$/);
    await expect(page.getByRole("heading", { level: 1, name: "My issues" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "My issues" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "My issues" })).toHaveText("My issues");

    // 委任中タブはなく、担当タブだけ
    await expect(page.getByRole("tab")).toHaveText(["担当 8"]);
    await expect(page.getByRole("tab", { name: "担当 8", exact: true })).toHaveAttribute("aria-selected", "true");
    // List と Board の切り替えとグループ化は Display のポップオーバーにある
    const popover = await openDisplay(page);
    await expect(popover.getByRole("tablist", { name: "表示" }).getByRole("tab")).toHaveText(["List", "Board"]);
    await expect(await displaySelect(page, "グループ化")).toHaveAttribute("data-value", "status");
    await closeDisplay(page);
    await expect(tableRows(page)).toHaveCount(8);
    await expect(region(page, "Status Todo").locator("tbody tr")).toContainText(["NOD-5", "API-4"]);
    for (const id of ["API-9", ...LLM_ISSUES]) await expect(page.locator(`[data-issue-row="${id}"]`).first()).toBeVisible();
    // 行ごとに担当が違うため、担当の列を既定で出す
    await expect(page.getByRole("columnheader", { name: "担当", exact: true }).first()).toBeVisible();

    await expect(chips(page)).toContainText(/担当\s*is\s*me, LLM/);
    await expect(chips(page).getByRole("button", { name: "担当 の条件を外す" })).toHaveCount(0);
    // 件数カードと「View として保存」は置かない
    await expect(page.getByRole("button", { name: /^Ready/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "View として保存" })).toHaveCount(0);
  });

  test("URL に残った委任中タブは使わず、担当タブを出す", async ({ page, nod }) => {
    await assign(nod);
    await page.goto("/my-issues?tab=delegated");
    await expect(page.getByRole("tab")).toHaveText(["担当 8"]);
    await expect(await displaySelect(page, "グループ化")).toHaveAttribute("data-value", "status");
    await closeDisplay(page);
    await expect(tableRows(page)).toHaveCount(8);
    // 固定チップも担当タブと同じ（旧仕様の委任中タブの「担当 is LLM」にはしない）
    await expect(chips(page)).toContainText(/担当\s*is\s*me, LLM/);
    await page.reload();
    await expect(page.getByRole("tab", { name: "担当 8", exact: true })).toHaveAttribute("aria-selected", "true");
    await chooseDisplay(page, "グループ化", "なし");
    await expect(page).not.toHaveURL(/tab=/);
  });

  test("ほかの条件で絞り込め、URL に残る。担当の条件と Issues のタブは URL にあっても使わない", async ({ page, nod }) => {
    await assign(nod);
    await page.goto(`/my-issues?assignee=${encodeURIComponent(JSON.stringify(["codex"]))}&tab=ready`);
    await expect(page.getByRole("tab", { name: "担当 8", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(tableRows(page)).toHaveCount(8);

    await page.getByText("Filter", { exact: true }).click();
    await expect(page.getByRole("group", { name: "担当", exact: true })).toHaveCount(0);
    await page.getByRole("group", { name: "Workspace" }).getByRole("checkbox", { name: "nod", exact: true }).check();
    await expect(page).toHaveURL(/workspace=/);
    await expect(page).not.toHaveURL(/assignee=|tab=/);
    await expect(page.getByRole("tab")).toHaveText(["担当 2"]);
    await expect(tableRows(page)).toHaveCount(2);
    await expect(tableRows(page)).toContainText(["NOD-5", "NOD-3"]);

    await page.reload();
    await expect(tableRows(page)).toHaveCount(2);
  });

  test("「なし」を選ぶとフラットに出し、再読み込みしても保つ。完了済みは表示設定に従う", async ({ page, nod }) => {
    await assign(nod);
    await nod.me.updateIssue("NOD-5", { status: "done" });
    await page.goto("/my-issues");
    await expect(region(page, "Status Done").locator("tbody tr")).toHaveCount(2);
    await chooseDisplay(page, "グループ化", "なし");
    await expect(page).toHaveURL(/groupBy=none/);
    await expect(page.getByRole("region", { name: /^Status / })).toHaveCount(0);
    await expect(tableRows(page)).toHaveCount(8);
    await page.reload();
    await expect(await displaySelect(page, "グループ化")).toHaveAttribute("data-value", "none");

    await (await displaySwitch(page, "完了済み Issue を表示")).click();
    await expect(tableRows(page)).toHaveCount(6);
    await expect(tableRows(page)).not.toContainText(["NOD-5"]);
  });

  test("担当が me でも LLM でもなければ空の状態を出す", async ({ page, nod }) => {
    for (const id of LLM_ISSUES) await nod.me.updateIssue(id, { assignee: null });
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
    // タブの件数も担当の範囲で数える
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
