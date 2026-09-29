import { describe, expect, test } from "bun:test";
import { createIssue, createProject, findIssueRow, initWorkspace, llmStats, startIssue, updateIssue } from "@nod/core";
import { call, setup } from "./helpers";

function seed() {
  const s = setup();
  const other = initWorkspace(s.db, { path: "/tmp/repos/web-app" }).workspace;
  createProject(s.me, { name: "検索" });
  const issues = [
    createIssue(s.me, { workspaceId: s.ws.id, title: "a", projectRef: "検索" }),
    createIssue(s.me, { workspaceId: s.ws.id, title: "b" }),
    createIssue(s.me, { workspaceId: other.id, title: "c" }),
  ];
  for (const i of issues) {
    updateIssue(s.me, i.id, { status: "done" });
    s.db.query("UPDATE issues SET started_at = ?, closed_at = ? WHERE id = ?")
      .run("2026-09-01T00:00:00.000Z", "2026-09-01T01:00:00.000Z", findIssueRow(s.db, i.id).id);
  }
  return { ...s, other };
}

const RANGE = "by=day&from=2026-09-01&to=2026-09-02&tz=UTC";

describe("GET /api/stats", () => {
  test("期間ごとの完了数と作業時間を返す", async () => {
    const { app } = seed();
    const r = await call(app, "GET", `/api/stats?${RANGE}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ by: "day", from: "2026-09-01", to: "2026-09-02", tz: "UTC" });
    expect(r.json.buckets).toEqual([
      { start: "2026-09-01", end: "2026-09-01", completed: 3, canceled: 0, work: { measured: 3, unrecorded: 0, medianMinutes: 60, totalMinutes: 180 } },
      { start: "2026-09-02", end: "2026-09-02", completed: 0, canceled: 0, work: { measured: 0, unrecorded: 0, medianMinutes: null, totalMinutes: 0 } },
    ]);
  });

  test("workspace（複数可）と project で絞り込める", async () => {
    const { app, ws, other } = seed();
    const total = async (q: string) => (await call(app, "GET", `/api/stats?${RANGE}&${q}`)).json.totals.completed;
    expect(await total(`workspace=${ws.key}`)).toBe(2);
    expect(await total(`workspace=${ws.key}&workspace=${other.key}`)).toBe(3);
    expect(await total(`workspace=${ws.key},${other.key}`)).toBe(3);
    expect(await total("project=%E6%A4%9C%E7%B4%A2")).toBe(1);
  });

  test("不正な指定は 400 INVALID_ARGS、ない Project は 404", async () => {
    const { app } = seed();
    for (const q of ["by=month", "from=2026-13-01", "tz=Nowhere/City", "tz=%2B09%3A00", "by=day&by=week", "limit=3"]) {
      const r = await call(app, "GET", `/api/stats?${q}`);
      expect([q, r.status, r.json.error.code]).toEqual([q, 400, "INVALID_ARGS"]);
    }
    const missing = await call(app, "GET", "/api/stats?project=ない");
    expect([missing.status, missing.json.error.code]).toEqual([404, "NOT_FOUND"]);
  });
});

describe("GET /api/stats/llm", () => {
  test("LLM ごとの作業量を返し、同じ絞り込みと検証を使う", async () => {
    const { app, db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    startIssue(llm, a.id);
    db.query("UPDATE events SET created_at = '2026-09-01T00:00:00.000Z'").run();
    const r = await call(app, "GET", `/api/stats/llm?${RANGE}&workspace=${ws.key}`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual(llmStats(db, { by: "day", from: "2026-09-01", to: "2026-09-02", tz: "UTC", workspace: [ws.key] }));
    expect(r.json.llms.map((l: { name: string; totals: { assigned: number } }) => [l.name, l.totals.assigned])).toEqual([["claude-code", 1]]);
    const bad = await call(app, "GET", "/api/stats/llm?by=month");
    expect([bad.status, bad.json.error.code]).toEqual([400, "INVALID_ARGS"]);
  });
});
