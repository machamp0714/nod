import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createIssue, getIssue, HUMAN_ACTOR, initWorkspace, openDb } from "@nod/core";
import { createApp } from "../src/app";
import { call, tempDir } from "./helpers";

function setupDocs() {
  const db = openDb(join(tempDir(), "nod.db"));
  const ws = initWorkspace(db, { path: "/tmp/repos/api-server" }).workspace;
  const me = { db, actor: HUMAN_ACTOR };
  const docsDir = tempDir("nod-docs-");
  return { db, ws, me, docsDir, app: createApp({ db, docsDir }) };
}

describe("Documents API", () => {
  test("POST /api/documents は許可ルートに作って 201、Issue にリンクし、一覧と詳細に出る", async () => {
    const { app, db, me, ws, docsDir } = setupDocs();
    const i = createIssue(me, { workspaceId: ws.id, title: "検索" });
    const r = await call(app, "POST", "/api/documents", { path: "a/memo.md", title: "メモ", kind: "doc", body: "本文\n", issueRef: i.id });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ path: join(docsDir, "a", "memo.md"), title: "メモ", kind: "doc" });
    expect(readFileSync(join(docsDir, "a", "memo.md"), "utf8")).toBe("# メモ\n\n本文\n");
    expect(getIssue(db, i.id).documents).toMatchObject([{ id: r.json.id, attachedBy: "me" }]);

    const list = await call(app, "GET", "/api/documents");
    expect(list.json).toMatchObject([{ id: r.json.id, title: "メモ", issues: [i.id], projects: [] }]);
    const detail = await call(app, "GET", `/api/documents/${r.json.id}`);
    expect(detail.json).toMatchObject({ id: r.json.id, content: "# メモ\n\n本文\n", issues: [{ id: i.id, title: "検索" }], projects: [] });
  });

  test("GET /api/documents/root は作成先を返し、issueRefs で複数の Issue にリンクして作れる", async () => {
    const { app, me, ws, docsDir } = setupDocs();
    expect((await call(app, "GET", "/api/documents/root")).json).toEqual({ docsDir });
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    const r = await call(app, "POST", "/api/documents", { path: "m.md", issueRefs: [a.id, b.id] });
    expect(r.status).toBe(201);
    expect((await call(app, "GET", `/api/documents/${r.json.id}`)).json.issues.map((i: { id: string }) => i.id)).toEqual([a.id, b.id]);
    expect((await call(app, "POST", "/api/documents", { path: "n.md", issueRefs: "API-1" })).status).toBe(400);
  });

  test("ルートの外・既存ファイル・不正な入力は 4xx でファイルを書かない", async () => {
    const { app, docsDir } = setupDocs();
    writeFileSync(join(docsDir, "x.md"), "元\n");
    const cases: [unknown, number, string][] = [
      [{ path: "../x.md" }, 400, "INVALID_ARGS"],
      [{ path: "/tmp/x.md" }, 400, "INVALID_ARGS"],
      [{ path: "a\u0000b.md" }, 400, "INVALID_ARGS"],
      [{ path: "x.md" }, 409, "FILE_EXISTS"],
      [{ path: "y.md", kind: "memo" }, 400, "INVALID_ARGS"],
      [{ path: "y.md", issueRef: "API-9" }, 404, "NOT_FOUND"],
      [{ path: "y.md", issueRef: "API-1", projectRef: "p" }, 400, "INVALID_ARGS"],
      [{ path: "y.md", content: "x" }, 400, "INVALID_ARGS"],
      [{}, 400, "INVALID_ARGS"],
    ];
    for (const [body, status, code] of cases) {
      const r = await call(app, "POST", "/api/documents", body);
      expect([JSON.stringify(body), r.status, r.json.error.code]).toEqual([JSON.stringify(body), status, code]);
    }
    expect(readFileSync(join(docsDir, "x.md"), "utf8")).toBe("元\n");
    expect(existsSync(join(docsDir, "y.md"))).toBe(false);
  });

  test("Document 側から link / unlink し、詳細を返す", async () => {
    const { app, db, me, ws } = setupDocs();
    const i = createIssue(me, { workspaceId: ws.id, title: "a" });
    const id = (await call(app, "POST", "/api/documents", { path: "x.md" })).json.id;
    const linked = await call(app, "POST", `/api/documents/${id}/link`, { issueRef: i.id });
    expect(linked.status).toBe(200);
    expect(linked.json.issues).toMatchObject([{ id: i.id }]);
    const unlinked = await call(app, "POST", `/api/documents/${id}/unlink`, { issueRef: i.id });
    expect(unlinked.status).toBe(200);
    expect(unlinked.json.issues).toEqual([]);
    expect(getIssue(db, i.id).activity.map((a) => ("type" in a ? a.type : null))).toContain("document_detached");
    expect((await call(app, "POST", `/api/documents/${id}/unlink`, { issueRef: i.id })).status).toBe(404);
    expect((await call(app, "POST", `/api/documents/999/link`, { issueRef: i.id })).status).toBe(404);
    expect((await call(app, "POST", `/api/documents/${id}/link`, {})).status).toBe(400);
  });

  test("Issue 側の doc-remove は Document id でリンクを外す", async () => {
    const { app, db, me, ws } = setupDocs();
    const i = createIssue(me, { workspaceId: ws.id, title: "a" });
    const id = (await call(app, "POST", "/api/documents", { path: "x.md", issueRef: i.id })).json.id;
    const r = await call(app, "POST", `/api/issues/${i.id}/doc-remove`, { documentId: id });
    expect(r.status).toBe(200);
    expect(getIssue(db, i.id).documents).toEqual([]);
    expect((await call(app, "POST", `/api/issues/${i.id}/doc-remove`, { documentId: id })).status).toBe(404);
    expect((await call(app, "POST", `/api/issues/${i.id}/doc-remove`, { documentId: "x" })).status).toBe(400);
  });

  test("PUT /api/documents/:id/content は mtime が合えば保存し、違えば 409", async () => {
    const { app, docsDir } = setupDocs();
    const id = (await call(app, "POST", "/api/documents", { path: "e.md", title: "元" })).json.id;
    const { mtime } = (await call(app, "GET", `/api/documents/${id}`)).json;
    expect(typeof mtime).toBe("number");

    const ok = await call(app, "PUT", `/api/documents/${id}/content`, { content: "# 新\n\n本文\n", mtime });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ id, title: "新", content: "# 新\n\n本文\n" });
    expect(readFileSync(join(docsDir, "e.md"), "utf8")).toBe("# 新\n\n本文\n");

    const stale = await call(app, "PUT", `/api/documents/${id}/content`, { content: "x", mtime });
    expect([stale.status, stale.json.error.code]).toEqual([409, "CONFLICT"]);

    for (const body of [{ content: 1, mtime }, { content: "x" }, { content: "x", mtime: "1" }, { content: "x", mtime, extra: 1 }]) {
      expect((await call(app, "PUT", `/api/documents/${id}/content`, body)).status).toBe(400);
    }
    expect((await call(app, "PUT", "/api/documents/999/content", { content: "x", mtime })).status).toBe(404);
  });
});
