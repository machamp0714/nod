import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askQuestion, createIssue, getIssue, updateIssue } from "@nod/core";
import { call, setup } from "./helpers";

test("acceptは許可属性だけ受け取り、失敗は原子的で空本文も互換", async () => {
  const { db, app, ws, llm } = setup();
  const i = createIssue(llm, { workspaceId: ws.id, title: "判断" });
  expect((await call(app, "POST", `/api/issues/${i.id}/accept`, { priority: 1, projectRef: "存在しない" })).status).toBe(404);
  expect(getIssue(db, i.id)).toMatchObject({ status: "triage", priority: 0 });
  for (const body of [{ status: "done" }, { priority: 9 }, { addLabels: [5] }, { projectRef: 1 }]) {
    expect((await call(app, "POST", `/api/issues/${i.id}/accept`, body)).status).toBe(400);
  }
  expect((await call(app, "POST", `/api/issues/${i.id}/accept`, { priority: 2, addLabels: ["bug"] })).json).toMatchObject({ status: "todo", priority: 2, labels: ["bug"] });
  const second = createIssue(llm, { workspaceId: ws.id, title: "空" });
  expect((await call(app, "POST", `/api/issues/${second.id}/accept`)).status).toBe(200);
  db.close();
});
test("includeAnsweredは終端も含むLLM履歴を返し、boolean以外を拒否する", async () => {
  const { db, app, ws, me, llm } = setup();
  const i = createIssue(me, { workspaceId: ws.id, title: "履歴" });
  askQuestion(llm, i.id, "残る質問");
  askQuestion(me, i.id, "私の未決");
  updateIssue(me, i.id, { status: "done" });
  expect((await call(app, "GET", "/api/inbox")).json.questions).toHaveLength(0);
  expect((await call(app, "GET", "/api/inbox?includeAnswered=true")).json.questions).toHaveLength(1);
  expect((await call(app, "GET", "/api/inbox?includeAnswered=no")).status).toBe(400);
  db.close();
});
test("doc-addは絶対Markdownパスを添付しactorと時刻を詳細に返す", async () => {
  const { db, app, ws, me } = setup();
  const i = createIssue(me, { workspaceId: ws.id, title: "添付" });
  const path = join(mkdtempSync(join(tmpdir(), "nod-doc-api-")), "日本語.md");
  writeFileSync(path, "# 設計\n本文");
  for (const body of [{ path: "relative.md" }, { path, kind: "bad" }, { path, title: 1 }]) {
    expect((await call(app, "POST", `/api/issues/${i.id}/doc-add`, body)).status).toBe(400);
  }
  expect((await call(app, "POST", `/api/issues/${i.id}/doc-add`, { path, title: " ", kind: "spec" })).status).toBe(201);
  const doc = getIssue(db, i.id).documents[0]!;
  expect(doc).toMatchObject({ title: "設計", kind: "spec", attachedBy: "me" });
  expect(doc.attachedAt).toBeString();
  expect((await call(app, "POST", `/api/issues/${i.id}/doc-add`, { path })).status).toBe(201);
  expect(getIssue(db, i.id).documents).toHaveLength(1);
  db.close();
});
