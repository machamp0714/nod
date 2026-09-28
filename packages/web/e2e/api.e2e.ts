import { expect, test } from "./fixtures";
import { DOC, ISSUE, MAIN_TITLE } from "./issue-detail-data";

test.use({ dataset: "issue-detail" });

test("データセット issue-detail は、一時ディレクトリの Workspace と A と同じ ID の Issue を返す", async ({ request }) => {
  const workspaces = await (await request.get("/api/workspaces")).json();
  expect(workspaces).toHaveLength(1);
  expect(workspaces[0].key).toBe("API");
  expect(workspaces[0].path).toContain("nod-e2e-");

  const res = await request.get(`/api/issues/${ISSUE.main}`);
  expect(res.ok()).toBe(true);
  const issue = await res.json();
  expect(issue.title).toBe(MAIN_TITLE);
  expect(issue.documents.map((d: { id: number }) => d.id)).toEqual([DOC.spec, DOC.plan, DOC.missing]);
});

test("ファイルを消した Document は content が null になる", async ({ request }) => {
  const doc = await (await request.get(`/api/documents/${DOC.missing}`)).json();
  expect(doc).toMatchObject({ title: "nod 設計", content: null });
});
