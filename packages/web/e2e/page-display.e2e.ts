import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { chooseDisplay, columnChip, displaySelect, openDisplay, setColumn, setDirection, setLayout } from "./support/issue-list";

test.use({ dataset: "issue-list" });

const nav = (page: Page) => page.getByRole("navigation", { name: "メイン" });
const layoutTab = async (page: Page, name: "List" | "Board") => (await openDisplay(page)).getByRole("tab", { name, exact: true });
const savedDisplays = async (page: Page) => (await (await page.request.get("/api/page-displays")).json()) as Record<string, unknown>;

test("Issues で Board・グループ化 Project にすると、別ページから Sidebar で開き直しても同じ表示。My issues には漏れない", async ({ page }) => {
  await page.goto("/issues");
  await setLayout(page, "Board");
  await chooseDisplay(page, "グループ化", "Project");
  await expect.poll(() => savedDisplays(page)).toEqual({ issues: { layout: "board", groupBy: "project" } });

  await nav(page).getByRole("link", { name: "My issues", exact: true }).click();
  await expect(await layoutTab(page, "List")).toHaveAttribute("aria-selected", "true");
  await nav(page).getByRole("link", { name: "Issues", exact: true }).click();
  await expect(page).toHaveURL(/\/issues$/);
  await expect(await layoutTab(page, "Board")).toHaveAttribute("aria-selected", "true");
  await expect(await displaySelect(page, "グループ化")).toHaveAttribute("data-value", "project");
});

test("Project ごとに別の表示を覚える", async ({ page }) => {
  await page.goto("/projects/1");
  await setLayout(page, "Board");
  await expect.poll(async () => (await savedDisplays(page))["project:1"]).toEqual({ layout: "board" });
  await page.goto("/projects/2");
  await expect(await layoutTab(page, "List")).toHaveAttribute("aria-selected", "true");
  expect((await savedDisplays(page))["project:2"]).toBeUndefined();
  await page.goto("/projects/1");
  await expect(await layoutTab(page, "Board")).toHaveAttribute("aria-selected", "true");
  await page.goto("/projects/2");
  await expect(await layoutTab(page, "List")).toHaveAttribute("aria-selected", "true");
});

test("並び順・昇降順・完了済み・子 Issue・表示列も保存して復元する", async ({ page }) => {
  await page.goto("/issues");
  await chooseDisplay(page, "並び順", "タイトル");
  await setDirection(page, "desc");
  const popover = await openDisplay(page);
  await popover.getByRole("switch", { name: "完了済み Issue を表示" }).click();
  await popover.getByRole("switch", { name: "子 Issue を表示" }).click();
  await setColumn(page, "担当", false);
  await expect.poll(async () => (await savedDisplays(page)).issues).toMatchObject({ sort: "title", direction: "desc", showCompleted: false, showChildren: false });

  await page.goto("/issues");
  const reopened = await openDisplay(page);
  await expect(await displaySelect(page, "並び順")).toHaveAttribute("data-value", "title");
  await expect(reopened.getByRole("button", { name: "並び順の方向", exact: true })).toHaveAttribute("data-value", "desc");
  await expect(reopened.getByRole("switch", { name: "完了済み Issue を表示" })).toHaveAttribute("aria-checked", "false");
  await expect(reopened.getByRole("switch", { name: "子 Issue を表示" })).toHaveAttribute("aria-checked", "false");
  await expect(await columnChip(page, "担当")).toHaveAttribute("aria-pressed", "false");
});

test("My issues で「なし」を選ぶと、開き直してもフラットのまま", async ({ page }) => {
  await page.goto("/my-issues");
  await chooseDisplay(page, "グループ化", "なし");
  await expect.poll(async () => (await savedDisplays(page))["my-issues"]).toEqual({ groupBy: "none" });
  await page.goto("/my-issues");
  await expect(await displaySelect(page, "グループ化")).toHaveAttribute("data-value", "none");
});

test("URL で明示すると URL が優先され、保存は変わらない", async ({ page }) => {
  await page.goto("/issues");
  await setLayout(page, "Board");
  await expect.poll(() => savedDisplays(page)).toEqual({ issues: { layout: "board" } });
  await page.goto("/issues?layout=list");
  await expect(await layoutTab(page, "List")).toHaveAttribute("aria-selected", "true");
  await nav(page).getByRole("link", { name: "Issues", exact: true }).click();
  await expect(await layoutTab(page, "Board")).toHaveAttribute("aria-selected", "true");
  expect(await savedDisplays(page)).toEqual({ issues: { layout: "board" } });
});

test("続けて変えても、最後の表示で開く", async ({ page }) => {
  await page.goto("/issues");
  await setLayout(page, "Board");
  await chooseDisplay(page, "グループ化", "Workspace");
  await chooseDisplay(page, "並び順", "優先度");
  await setLayout(page, "List");
  await expect.poll(async () => (await savedDisplays(page)).issues).toEqual({ groupBy: "workspace", sort: "priority" });
  await page.goto("/issues");
  await expect(await layoutTab(page, "List")).toHaveAttribute("aria-selected", "true");
  await expect(await displaySelect(page, "グループ化")).toHaveAttribute("data-value", "workspace");
});

test("「既定に戻す」で既定の表示に戻り、開き直しても既定のまま。何も保存していなければ押せない", async ({ page }) => {
  await page.goto("/issues");
  const reset = (await openDisplay(page)).getByRole("button", { name: "既定に戻す", exact: true });
  await expect(reset).toBeDisabled();
  await setLayout(page, "Board");
  await chooseDisplay(page, "並び順", "タイトル");
  await reset.click();
  await expect(await layoutTab(page, "List")).toHaveAttribute("aria-selected", "true");
  await expect(await displaySelect(page, "並び順")).toHaveAttribute("data-value", "default");
  await expect(page).toHaveURL(/\/issues$/);
  await expect.poll(() => savedDisplays(page)).toEqual({});
  await page.goto("/issues");
  await expect(await layoutTab(page, "List")).toHaveAttribute("aria-selected", "true");
  await expect((await openDisplay(page)).getByRole("button", { name: "既定に戻す", exact: true })).toBeDisabled();
});

test("View の表示設定は自動保存せず、「変更を保存」を押すまで View に反映しない", async ({ page }) => {
  const before = await (await page.request.get("/api/views/1")).json();
  await page.goto("/views/1");
  await setLayout(page, "Board");
  await expect(page.getByRole("button", { name: "変更を保存", exact: true })).toBeVisible();
  await expect((await openDisplay(page)).getByRole("button", { name: "既定に戻す" })).toHaveCount(0);
  // クエリなしで開き直すと View 本来の表示（List）に戻る。保存されていれば Board になる
  await page.goto("/views/1");
  await expect(await layoutTab(page, "List")).toHaveAttribute("aria-selected", "true");
  expect((await (await page.request.get("/api/views/1")).json()).display).toEqual(before.display);
  expect(await savedDisplays(page)).toEqual({});
});

test("Cycle の表示を保存したあと Cycle を消しても、エラーにならない", async ({ page, nod }) => {
  const workspaces = (await (await page.request.get("/api/workspaces")).json()) as { id: number; key: string }[];
  const api = workspaces.find((w) => w.key === "API")!;
  const cycle = (await nod.me.createCycle({ workspaceId: api.id, name: "Sprint 1", startDate: "2026-10-01", endDate: "2026-10-14" })) as { id: number };
  await page.goto(`/cycles/${cycle.id}`);
  await setLayout(page, "Board");
  await expect.poll(async () => (await savedDisplays(page))[`cycle:${cycle.id}`]).toEqual({ layout: "board" });
  await nod.me.deleteCycle(api.id, String(cycle.id));
  await page.goto(`/cycles/${cycle.id}`);
  await expect(page.getByText("Cycle が見つかりません")).toBeVisible();
  await page.goto("/issues");
  await expect(page.getByRole("table")).toBeVisible();
});

test.describe("表示設定の取得失敗", () => {
  test.use({ allowedConsoleErrors: [/Failed to load resource.*status of 500/] });
  test("取得に失敗しても既定の表示で開ける", async ({ page }) => {
    await page.route(/\/api\/page-displays$/, (route) => route.fulfill({ status: 500, json: { error: { code: "INTERNAL_ERROR", message: "失敗" } } }));
    await page.goto("/issues");
    // 5xx は3回再試行されるため、表示まで約7秒かかる（display-options.e2e.ts の取得失敗と同じ）
    await expect(page.getByRole("table")).toBeVisible({ timeout: 15_000 });
    await expect(await layoutTab(page, "List")).toHaveAttribute("aria-selected", "true");

    // 取得に失敗している間は、表示を変えても保存の要求（PUT・DELETE）を送らない
    let writes = 0;
    page.on("request", (req) => {
      if (req.url().includes("/api/page-displays/") && req.method() !== "GET") writes++;
    });
    await setLayout(page, "Board");
    await expect(await layoutTab(page, "Board")).toHaveAttribute("aria-selected", "true");
    expect(writes).toBe(0);
  });
});
