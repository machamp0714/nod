import { expect, test } from "./fixtures";

// 全画面の枠。後の Task で画面を作り替えても、この見出しは保つ。
// View と Project は E のデータセットに、Issue 詳細と Document は G のデータセットにある。
const GROUPS = [
  {
    dataset: "issue-list",
    screens: [
      { path: "/inbox", heading: "Inbox" },
      { path: "/reviews", heading: "Reviews" },
      { path: "/triage", heading: "Triage" },
      { path: "/issues", heading: "Issues" },
      { path: "/views/1", heading: "仕事" },
      { path: "/projects", heading: "Projects" },
      { path: "/projects/1", heading: "検索 API の高速化" },
    ],
  },
  {
    dataset: "issue-detail",
    screens: [
      { path: "/issues/API-12", heading: "検索 API の N+1 を解消" },
      { path: "/documents/1", heading: "検索 API の高速化 設計" },
    ],
  },
] as const;

for (const group of GROUPS) {
  test.describe(`データセット ${group.dataset}`, () => {
    test.use({ dataset: group.dataset });

    for (const screen of group.screens) {
      test(`${screen.path} を開くと Sidebar と見出し「${screen.heading}」が出る`, async ({ page }) => {
        await page.goto(screen.path);
        await expect(page.getByRole("navigation", { name: "メイン" })).toBeVisible();
        await expect(page.getByRole("heading", { level: 1, name: screen.heading })).toBeVisible();
      });
    }
  });
}
