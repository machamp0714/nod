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
