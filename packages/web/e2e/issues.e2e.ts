import type { Page } from "@playwright/test";
import { expect, test, waitForServerEvents } from "./fixtures";

test.use({ dataset: "issue-list" });

const tableRows = (page: Page) => page.getByRole("table").locator("tbody tr");
const json = (value: unknown) => encodeURIComponent(JSON.stringify(value));

test("データセット issue-list は A のダミーデータと同じ Workspace、Issue、件数、View を持つ", async ({ request }) => {
  const workspaces = (await (await request.get("/api/workspaces")).json()) as { key: string; name: string; path: string }[];
  expect(workspaces.map((w) => [w.key, w.name])).toEqual([
    ["API", "api-server"],
    ["BLOG", "blog"],
    ["NOD", "nod"],
  ]);
  for (const w of workspaces) expect(w.path).toContain("nod-e2e-");
  const list = (await (await request.get("/api/issues")).json()) as { issues: { id: string }[]; counts: unknown };
  expect(list.issues).toHaveLength(13);
  expect(list.counts).toEqual({ ready: 2, needsClarification: 1 });
  const views = (await (await request.get("/api/views")).json()) as unknown[];
  expect(views).toMatchObject([
    { id: 1, name: "仕事", color: "#7C5CFF", filter: { workspace: ["API"] } },
    { id: 2, name: "プライベート", color: "#DB2777", filter: { workspace: ["BLOG"] } },
  ]);
  const documents = (await (await request.get("/api/projects/1")).json()) as { documents: { id: number; title: string }[] };
  expect(documents.documents).toEqual([expect.objectContaining({ id: 1, title: "検索 API の高速化 設計" })]);
});

test("Issues は API から全 Workspace の Issue を読み、nod で起票した Issue も再読み込みなしで出す", async ({ page, nod }) => {
  await page.goto("/issues");
  await expect(tableRows(page)).toHaveCount(13);
  await expect(page.getByRole("tab", { name: "Ready 2", exact: true })).toBeVisible();
  await expect(page.getByRole("row", { name: /API-9/ })).toContainText("2 / 6");
  // ready の前に書くと、ready による読み直しで出てしまい、change の経路を試せない
  await waitForServerEvents(page);
  await nod.claude.createIssue({ workspaceId: 1, title: "LLM が起票した Issue" });
  await expect(page.getByRole("row", { name: /LLM が起票した Issue/ })).toBeVisible();
  await expect(tableRows(page)).toHaveCount(14);
});

test("URL の絞り込み条件で API に問い合わせ、不正な値は捨てる", async ({ page }) => {
  await page.goto(`/issues?workspace=${json(["blog"])}`);
  await expect(tableRows(page)).toHaveCount(1);
  await expect(tableRows(page)).toContainText("BLOG-2");
  await page.goto(`/issues?status=${json(["wip"])}&project=abc`);
  await expect(tableRows(page)).toHaveCount(13);
});

test("存在しない Project の条件は、API を呼ばずにメッセージを出す", async ({ page }) => {
  await page.goto("/issues?project=999");
  await expect(page.getByRole("alert")).toHaveText("条件の Project（999）が見つかりません");
});

test("Filter で Workspace、Status、Project、Label を選ぶと絞り込み、条件を URL に残す", async ({ page }) => {
  await page.goto("/issues");
  await page.getByText("Filter", { exact: true }).click();
  await page.getByRole("group", { name: "Workspace" }).getByRole("checkbox", { name: "nod", exact: true }).check();
  await expect(tableRows(page)).toHaveCount(4);
  await page.getByRole("group", { name: "Status" }).getByRole("checkbox", { name: "Todo", exact: true }).check();
  await expect(tableRows(page)).toHaveCount(1);
  await expect(tableRows(page)).toContainText("NOD-5");

  await page.reload();
  await expect(tableRows(page)).toHaveCount(1);
  const chips = page.getByRole("group", { name: "絞り込み条件" });
  await expect(chips).toContainText(/Workspace\s*is\s*nod/);
  await chips.getByRole("button", { name: "Status の条件を外す" }).click();
  await expect(tableRows(page)).toHaveCount(4);
  await chips.getByRole("button", { name: "Workspace の条件を外す" }).click();
  await expect(tableRows(page)).toHaveCount(13);
  await expect(page).not.toHaveURL(/workspace=|status=/);

  await page.getByText("Filter", { exact: true }).click();
  await page.getByRole("combobox", { name: "Project" }).selectOption({ label: "決済まわり" });
  await expect(tableRows(page)).toHaveCount(2);
  // TanStack Router は JSON として読める文字列を引用符つきで URL に書く（project=%222%22）ため、値で確かめる
  expect(new URL(page.url()).searchParams.get("project")).toMatch(/^"?2"?$/);
  await page.getByRole("combobox", { name: "Project" }).selectOption({ label: "すべて" });
  await page.getByRole("group", { name: "Label" }).getByRole("checkbox", { name: "perf", exact: true }).check();
  await expect(tableRows(page)).toHaveCount(1);
  await expect(tableRows(page)).toContainText("API-12");
});
