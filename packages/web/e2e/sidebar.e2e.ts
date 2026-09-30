import { seedApiWorkspace } from "./decision-data";
import { expect, test } from "./fixtures";

test.use({ dataset: "issue-list" });

test("/ は /inbox に移る", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/inbox$/);
});

const LINKS = [
  { name: /^Inbox/, url: /\/inbox$/, heading: "Inbox" },
  { name: /^Reviews/, url: /\/reviews$/, heading: "Reviews" },
  { name: /^Triage/, url: /\/triage$/, heading: "Triage" },
  { name: "Issues", url: /\/issues$/, heading: "Issues" },
  { name: "My issues", url: /\/my-issues$/, heading: "My issues" },
  { name: "Projects", url: /\/projects$/, heading: "Projects" },
  { name: "Documents", url: /\/documents$/, heading: "Documents" },
  { name: "仕事", url: /\/views\/1$/, heading: "仕事" },
];

for (const link of LINKS) {
  test(`Sidebar の ${link.heading} を押すとその画面に移り、項目が選択中になる`, async ({ page }) => {
    await page.goto(link.heading === "Inbox" ? "/issues" : "/inbox");
    const nav = page.getByRole("navigation", { name: "メイン" });
    await nav.getByRole("link", { name: link.name, exact: true }).click();
    await expect(page).toHaveURL(link.url);
    await expect(page.getByRole("heading", { level: 1, name: link.heading })).toBeVisible();
    await expect(nav.getByRole("link", { name: link.name, exact: true })).toHaveAttribute("aria-current", "page");
  });
}

// 件数を正確に数えるため、このテストだけ空の DB から始める。
test.describe("件数", () => {
  test.use({ dataset: "empty" });

  test("Inbox、Reviews、Triage の件数を API から出す", async ({ page, nod }) => {
    const api = await seedApiWorkspace(nod);
    const a = await api.startedIssue("検索 API の N+1 を解消");
    await api.ask(a.id, "複合インデックスにしてよいですか？");
    await api.ask(a.id, "既存のインデックスは消してよいですか？");
    await api.inReview("決済 Webhook の署名検証を追加", "署名を検証した");
    await api.triageIssue("検索結果のページングが 1 件ずれる");
    await page.goto("/issues");
    const nav = page.getByRole("navigation", { name: "メイン" });
    await expect(nav.getByRole("link", { name: /^Inbox/ })).toContainText("2");
    await expect(nav.getByRole("link", { name: /^Reviews/ })).toContainText("1");
    await expect(nav.getByRole("link", { name: /^Triage/ })).toContainText("1");
  });
});

test("準備中の項目はリンクにせず Soon と出し、準備中のボタンは押せず、View を追加は押せる", async ({ page }) => {
  await page.goto("/inbox");
  const nav = page.getByRole("navigation", { name: "メイン" });
  await expect(nav.getByText("Favorites")).toBeVisible();
  await expect(nav.getByRole("link", { name: "Favorites" })).toHaveCount(0);
  await expect(nav.getByText("Soon")).toHaveCount(1);
  await expect(nav.getByRole("button", { name: "検索" })).toBeDisabled();
  await expect(nav.getByRole("button", { name: "New Issue" })).toBeDisabled();
  await expect(nav.getByRole("button", { name: "View を追加" })).toBeEnabled();
});

test.describe("Issue 詳細", () => {
  test.use({ dataset: "issue-detail" });

  test("Issue 詳細を開いているときは Issues を選択中にする", async ({ page }) => {
    await page.goto("/issues/API-12");
    const nav = page.getByRole("navigation", { name: "メイン" });
    await expect(nav.getByRole("link", { name: "Issues", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "My issues" })).not.toHaveAttribute("aria-current", "page");
  });
});

test("存在しないパスではページが見つかりませんと出す", async ({ page }) => {
  await page.goto("/nope");
  await expect(page.getByRole("heading", { level: 1, name: "ページが見つかりません" })).toBeVisible();
  await page.getByRole("link", { name: "Inbox に戻る" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
});
