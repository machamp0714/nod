import { describe, expect, test } from "bun:test";
import { archiveIssue, completeIssue, createIssue, createProject, findIssueRow, initWorkspace, startIssue, updateIssue } from "@nod/core";
import { call, setup } from "./helpers";

function seed() {
  const s = setup();
  const other = initWorkspace(s.db, { path: "/tmp/repos/web-app" }).workspace;
  createProject(s.me, { name: "検索" });
  const a = createIssue(s.me, { workspaceId: s.ws.id, title: "a", projectRef: "検索" });
  const b = createIssue(s.me, { workspaceId: s.ws.id, title: "b" });
  createIssue(s.me, { workspaceId: other.id, title: "c" });
  startIssue(s.llm, a.id);
  archiveIssue(s.me, b.id);
  return { ...s, other, a, b };
}

const count = (json: any, kind: string) => json.sections.find((x: any) => x.kind === kind).total;

describe("GET /api/summary", () => {
  test("直近24時間の動きを種類ごとに返す", async () => {
    const { app, a } = seed();
    const r = await call(app, "GET", "/api/summary");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ limit: 20, includeArchived: false });
    expect(Date.parse(r.json.until) - Date.parse(r.json.since)).toBe(24 * 3_600_000);
    expect(count(r.json, "created")).toBe(2); // アーカイブ済みの b は既定で除く
    expect(count(r.json, "archived")).toBe(1);
    expect(r.json.sections.find((x: any) => x.kind === "started").items[0]).toMatchObject({
      issueId: a.id, actor: "claude-code", actorKind: "llm",
    });
  });

  test("since・workspace（複数可）・project・limit・includeArchived で絞り込める", async () => {
    const { app, ws, other } = seed();
    const get = async (q: string) => (await call(app, "GET", `/api/summary?${q}`)).json;
    expect(count(await get("since=7d&includeArchived=true"), "created")).toBe(3);
    expect(count(await get(`workspace=${ws.key}`), "created")).toBe(1);
    expect(count(await get(`workspace=${ws.key},${other.key}`), "created")).toBe(2);
    expect(count(await get("project=%E6%A4%9C%E7%B4%A2"), "created")).toBe(1);
    const limited = (await get("limit=1")).sections.find((x: any) => x.kind === "created");
    expect([limited.items.length, limited.more]).toEqual([1, 1]);
  });

  test("不正な指定は 400 INVALID_ARGS、ない Project は 404", async () => {
    const { app } = seed();
    for (const q of ["since=1y", "since=91d", "limit=0", "limit=abc", "limit=201", "includeArchived=yes", "since=1d&since=2d", "by=day"]) {
      const r = await call(app, "GET", `/api/summary?${q}`);
      expect([q, r.status, r.json.error.code]).toEqual([q, 400, "INVALID_ARGS"]);
    }
    const missing = await call(app, "GET", "/api/summary?project=ない");
    expect([missing.status, missing.json.error.code]).toEqual([404, "NOT_FOUND"]);
  });
});


test("新しいレビュー入りと再提出は完了報告に数えず、旧レビュー提出とDoneの意味を保つ", async () => {
  const { app, db, ws, me, llm } = setup();
  try {
    const legacy = createIssue(me, { workspaceId: ws.id, title: "旧レビュー提出" });
    // 移行前のレビュー提出履歴。新しいレビュー入りの識別子を持たない。
    db.query("INSERT INTO events (issue_id, actor, type, data, created_at) VALUES (?, ?, 'status_changed', ?, ?)")
      .run(findIssueRow(db, legacy.id).id, llm.actor, JSON.stringify({ from: "in_progress", to: "in_review" }), new Date().toISOString());
    const fresh = createIssue(me, { workspaceId: ws.id, title: "PRレビューを繰り返す" });
    startIssue(llm, fresh.id);
    for (let n = 0; n < 2; n++) {
      updateIssue(llm, fresh.id, { status: "in_review" });
      const summary = await call(app, "GET", "/api/summary");
      expect(summary.status).toBe(200);
      expect(count(summary.json, "submitted")).toBe(1);
      expect(summary.json.sections.find((section: any) => section.kind === "submitted").items.map((item: any) => item.issueId)).toEqual([legacy.id]);
      expect(count(summary.json, "completed")).toBe(0);
      if (n === 0) startIssue(llm, fresh.id);
    }
    completeIssue(llm, fresh.id, { summary: "mergeと完了条件を確認" });
    const summary = (await call(app, "GET", "/api/summary")).json;
    expect(count(summary, "completed")).toBe(1);
    expect(count(summary, "submitted")).toBe(1);
    expect(summary.sections.find((section: any) => section.kind === "completed").items[0].issueId).toBe(fresh.id);
  } finally {
    db.close();
  }
});
