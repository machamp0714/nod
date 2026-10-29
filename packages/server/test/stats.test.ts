import { describe, expect, test } from "bun:test";
import { completeIssue, createIssue, createMilestone, createProject, findIssueRow, initWorkspace, llmStats, startIssue, updateIssue } from "@nod/core";
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
  return { ...s, other, issues };
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

  test("milestone で絞り込め、ない Milestone は 404、名前だけ・別 Project の Milestone は 400", async () => {
    const { app, me, issues } = seed();
    const alpha = createMilestone(me, "検索", { name: "α" });
    createProject(me, { name: "決済" });
    updateIssue(me, issues[0]!.id, { milestoneRef: "α" });
    const get = (q: string) => call(app, "GET", `/api/stats?${RANGE}&${q}`);
    expect((await get(`milestone=${alpha.id}`)).json.totals.completed).toBe(1);
    expect((await get(`project=%E6%A4%9C%E7%B4%A2&milestone=%CE%B1`)).json.totals.completed).toBe(1);
    expect((await call(app, "GET", `/api/stats/llm?${RANGE}&milestone=${alpha.id}`)).status).toBe(200);
    for (const q of ["milestone=%CE%B1", `project=%E6%B1%BA%E6%B8%88&milestone=${alpha.id}`, "milestone=1&milestone=2"]) {
      const r = await get(q);
      expect([q, r.status, r.json.error.code]).toEqual([q, 400, "INVALID_ARGS"]);
    }
    const missing = await get("milestone=999");
    expect([missing.status, missing.json.error.code]).toEqual([404, "NOT_FOUND"]);
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


test("旧レビュー提出を保ち、新しいレビュー提出と再開は完了報告に重複計上しない", async () => {
  const { app, db, ws, me, llm } = setup();
  const old = createIssue(me, { workspaceId: ws.id, title: "旧レビュー提出" });
  startIssue(llm, old.id);
  updateIssue(me, old.id, { status: "done" });
  // 移行前の提出履歴を再現する。識別子のない旧履歴は旧完了提出の意味を持つ。
  db.query("INSERT INTO events (issue_id, actor, type, data, created_at) VALUES (?, ?, 'status_changed', ?, ?)")
    .run(findIssueRow(db, old.id).id, llm.actor, JSON.stringify({ from: "in_progress", to: "in_review" }), "2026-09-01T01:00:00.000Z");
  const fresh = createIssue(me, { workspaceId: ws.id, title: "修正と再提出" });
  startIssue(llm, fresh.id);
  for (let n = 0; n < 2; n++) {
    updateIssue(llm, fresh.id, { status: "in_review" });
    startIssue(llm, fresh.id);
  }
  updateIssue(llm, fresh.id, { status: "in_review" });
  const query = `/api/stats/llm?${RANGE}`;
  db.query("UPDATE events SET created_at = '2026-09-01T01:00:00.000Z'").run();
  expect((await call(app, "GET", query)).json.llms[0].totals.submitted).toBe(1);
  completeIssue(llm, fresh.id, { summary: "mergeと完了条件を確認" });
  db.query("UPDATE events SET created_at = '2026-09-01T02:00:00.000Z' WHERE issue_id = ? AND json_extract(data, '$.report_comment_id') IS NOT NULL")
    .run(findIssueRow(db, fresh.id).id);
  db.query("UPDATE issues SET started_at = '2026-09-01T00:00:00.000Z', closed_at = '2026-09-01T03:00:00.000Z'").run();
  expect((await call(app, "GET", query)).json.llms[0].totals).toMatchObject({ submitted: 2, completed: 2, work: { measured: 2, totalMinutes: 180 } });
  expect((await call(app, "GET", `/api/stats?${RANGE}`)).json.totals).toMatchObject({ completed: 2, work: { totalMinutes: 180 } });
  expect((await call(app, "GET", `/api/issues/${old.id}`)).json.activity).toContainEqual(expect.objectContaining({
    type: "status_changed", data: { from: "in_progress", to: "in_review" },
  }));
  updateIssue(llm, fresh.id, { status: "in_review" });
  expect((await call(app, "GET", `/api/stats?${RANGE}`)).json.totals.completed).toBe(1);
  startIssue(llm, fresh.id);
  updateIssue(llm, fresh.id, { status: "in_review" });
  completeIssue(llm, fresh.id, { summary: "追加修正を完了" });
  db.query("UPDATE events SET created_at = '2026-09-01T04:00:00.000Z' WHERE created_at > '2026-09-02'").run();
  db.query("UPDATE issues SET closed_at = '2026-09-01T04:00:00.000Z' WHERE id = ?").run(findIssueRow(db, fresh.id).id);
  expect((await call(app, "GET", query)).json.llms[0].totals).toMatchObject({ submitted: 3, completed: 2, work: { totalMinutes: 300 } });
});


test("新しいレビュー入りを作業時間の終点にせず、報告なしのDoneは完了日時まで測る", async () => {
  const { app, db, ws, me, llm } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "レビュー後に直接Done" });
  startIssue(llm, issue.id);
  updateIssue(llm, issue.id, { status: "in_review" });
  updateIssue(me, issue.id, { status: "done" });
  db.query("UPDATE events SET created_at = '2026-09-01T01:00:00.000Z'").run();
  db.query("UPDATE issues SET started_at = '2026-09-01T00:00:00.000Z', closed_at = '2026-09-01T03:00:00.000Z'").run();
  expect((await call(app, "GET", `/api/stats?${RANGE}`)).json.totals).toMatchObject({ completed: 1, work: { measured: 1, totalMinutes: 180 } });
  expect((await call(app, "GET", `/api/stats/llm?${RANGE}`)).json.llms[0].totals).toMatchObject({ submitted: 0, completed: 1, work: { totalMinutes: 180 } });
});
