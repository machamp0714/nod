import { describe, expect, test } from "bun:test";
import { findIssueRow } from "../src/issue-query";
import { cycleAnalytics } from "../src/ops/cycle-analytics";
import { createCycle, deleteCycle } from "../src/ops/cycles";
import { archiveIssue, createIssue, updateIssue } from "../src/ops/issues";
import { createProject } from "../src/ops/projects";
import { initWorkspace } from "../src/ops/workspaces";
import { setup } from "./helpers";

const clock = { today: "2026-10-08", tz: "Asia/Tokyo" };

// その Issue のまだ日時を固定していない event を、東京の date の正午（03:00Z）にする。1回の操作で複数の event が出ても揃う
function stamp(db: Parameters<typeof findIssueRow>[0], ref: string, date: string) {
  db.query("UPDATE events SET created_at = ? WHERE issue_id = ? AND created_at NOT LIKE '%T03:00:00.000Z'").run(`${date}T03:00:00.000Z`, findIssueRow(db, ref).id);
}

describe("cycleAnalytics", () => {
  test("Scope・Started・Completed、開始後の増減、日ごとの推移", () => {
    const { db, ws, me } = setup();
    const web = initWorkspace(db, { path: "/tmp/repos/web" }).workspace;
    createCycle(me, { name: "S", startDate: "2026-10-05", endDate: "2026-10-11" }, clock);
    createCycle(me, { name: "T", startDate: "2026-10-12", endDate: "2026-10-18" }, clock);
    const a = createIssue(me, { workspaceId: ws.id, title: "作成時に指定", cycleRef: "S" }); stamp(db, a.id, "2026-10-05");
    const b = createIssue(me, { workspaceId: web.id, title: "途中で入る" }); stamp(db, b.id, "2026-10-05");
    updateIssue(me, b.id, { cycleRef: "S" }); stamp(db, b.id, "2026-10-06");
    updateIssue(me, b.id, { status: "in_progress" }); stamp(db, b.id, "2026-10-07");
    updateIssue(me, a.id, { status: "done" }); stamp(db, a.id, "2026-10-07");
    const d = createIssue(me, { workspaceId: ws.id, title: "出て戻る", cycleRef: "S" }); stamp(db, d.id, "2026-10-05");
    updateIssue(me, d.id, { cycleRef: "T" }); stamp(db, d.id, "2026-10-06");
    updateIssue(me, d.id, { cycleRef: "S" }); stamp(db, d.id, "2026-10-07");
    const e = createIssue(me, { workspaceId: ws.id, title: "中止", cycleRef: "S" }); stamp(db, e.id, "2026-10-05");
    updateIssue(me, e.id, { status: "canceled" }); stamp(db, e.id, "2026-10-06");
    const f = createIssue(me, { workspaceId: ws.id, title: "アーカイブ", cycleRef: "S" }); stamp(db, f.id, "2026-10-05");
    archiveIssue(me, f.id);

    const r = cycleAnalytics(db, "S", clock);
    expect(r).toMatchObject({ scope: 3, started: 1, completed: 1, scopeAdded: 0 });
    expect(r.completedRate).toBeCloseTo(1 / 3);
    expect(r.startedRate).toBeCloseTo(1 / 3);
    expect(r.burnup).toEqual([
      { date: "2026-10-05", scope: 3, started: 0, completed: 0 }, // a, d, e（f はアーカイブ済みで除く）
      { date: "2026-10-06", scope: 2, started: 0, completed: 0 }, // a, b（d は出た、e は canceled）
      { date: "2026-10-07", scope: 3, started: 1, completed: 1 }, // a(done), b(in_progress), d（戻った）
      { date: "2026-10-08", scope: 3, started: 1, completed: 1 },
    ]);
    expect(r.statuses.find((s) => s.status === "canceled")!.count).toBe(1);
    expect(r.statuses.find((s) => s.status === "todo")!.count).toBe(1);
  });

  test("内訳: 担当・ラベル・Project・Workspace ごとの total と done。なしも1行、多い順", () => {
    const { db, ws, me } = setup();
    const web = initWorkspace(db, { path: "/tmp/repos/web" }).workspace;
    createProject(me, { name: "決済" });
    createCycle(me, { name: "S", startDate: "2026-10-05", endDate: "2026-10-11" }, clock);
    const a = createIssue(me, { workspaceId: ws.id, title: "a", cycleRef: "S", projectRef: "決済", labels: ["bug", "api"] });
    updateIssue(me, a.id, { assignee: "me", status: "done" });
    const b = createIssue(me, { workspaceId: web.id, title: "b", cycleRef: "S", labels: ["bug"] });
    updateIssue(me, b.id, { assignee: "me" });
    createIssue(me, { workspaceId: web.id, title: "c", cycleRef: "S" });
    const r = cycleAnalytics(db, "S", clock).breakdown;
    expect(r.assignees).toEqual([{ key: "me", label: "me", total: 2, done: 1 }, { key: "", label: "担当なし", total: 1, done: 0 }]);
    expect(r.labels).toEqual([{ key: "bug", label: "bug", total: 2, done: 1 }, { key: "api", label: "api", total: 1, done: 1 }]);
    expect(r.projects.map((p) => [p.label, p.total, p.done])).toEqual([["Project なし", 2, 0], ["決済", 1, 1]]);
    expect(r.workspaces.map((w) => [w.key, w.total, w.done])).toEqual([[web.key, 2, 0], [ws.key, 1, 1]]);
  });

  test("予定の Cycle は推移が空で率は null。開始後に増えた分を scopeAdded に出す", () => {
    const { db, ws, me } = setup();
    createCycle(me, { name: "未来", startDate: "2026-11-01", endDate: "2026-11-07" }, clock);
    expect(cycleAnalytics(db, "未来", clock)).toMatchObject({ burnup: [], completedRate: null, startedRate: null, scope: 0, scopeAdded: 0 });
    createCycle(me, { name: "S", startDate: "2026-10-05", endDate: "2026-10-11" }, clock);
    const a = createIssue(me, { workspaceId: ws.id, title: "最初から", cycleRef: "S" }); stamp(db, a.id, "2026-10-05");
    const b = createIssue(me, { workspaceId: ws.id, title: "後から", cycleRef: "S" }); stamp(db, b.id, "2026-10-07");
    expect(cycleAnalytics(db, "S", clock).scopeAdded).toBe(1);
  });

  test("記録に ID がないのに所属している Issue は開始日から所属とみなす", () => {
    const { db, ws, me } = setup();
    createCycle(me, { name: "S", startDate: "2026-10-05", endDate: "2026-10-11" }, clock);
    createIssue(me, { workspaceId: ws.id, title: "旧", cycleRef: "S" });
    db.query("UPDATE events SET data = json_remove(data, '$.cycle_id'), created_at = '2026-10-01T03:00:00.000Z'").run();
    expect(cycleAnalytics(db, "S", clock).burnup[0]).toEqual({ date: "2026-10-05", scope: 1, started: 0, completed: 0 });
  });

  test("ID のない旧記録の Issue が開始前に done になっていたら、開始日から done として数える", () => {
    const { db, ws, me } = setup();
    createCycle(me, { name: "S", startDate: "2026-10-05", endDate: "2026-10-11" }, clock);
    const a = createIssue(me, { workspaceId: ws.id, title: "旧", cycleRef: "S" });
    updateIssue(me, a.id, { status: "done" });
    const row = findIssueRow(db, a.id).id;
    db.query("UPDATE events SET data = json_remove(data, '$.cycle_id') WHERE issue_id = ?").run(row);
    db.query("UPDATE events SET created_at = '2026-10-01T03:00:00.000Z' WHERE issue_id = ? AND type = 'created'").run(row);
    db.query("UPDATE events SET created_at = '2026-10-02T03:00:00.000Z' WHERE issue_id = ? AND type <> 'created'").run(row);
    expect(cycleAnalytics(db, "S", clock).burnup.map((d) => d.completed)).toEqual([1, 1, 1, 1]);
  });

  test("最大の ID の Cycle を消して作り直しても ID を使い回さず、消した Cycle の Issue を推移に含めない", () => {
    const { db, ws, me } = setup();
    const old = createCycle(me, { name: "S", startDate: "2026-10-05", endDate: "2026-10-11" }, clock);
    const a = createIssue(me, { workspaceId: ws.id, title: "旧", cycleRef: "S" }); stamp(db, a.id, "2026-10-05");
    deleteCycle(me, "S", clock);
    const fresh = createCycle(me, { name: "T", startDate: "2026-10-05", endDate: "2026-10-11" }, clock);
    expect(fresh.id).not.toBe(old.id);
    expect(cycleAnalytics(db, "T", clock).burnup.map((d) => d.scope)).toEqual([0, 0, 0, 0]);
  });

  test("日の区切りは clock の tz。UTC では前日でも東京の翌日に入った Issue はその日から数える", () => {
    const { db, ws, me } = setup();
    createCycle(me, { name: "S", startDate: "2026-10-05", endDate: "2026-10-11" }, clock);
    const a = createIssue(me, { workspaceId: ws.id, title: "a", cycleRef: "S" });
    db.query("UPDATE events SET created_at = '2026-10-05T16:00:00.000Z' WHERE issue_id = ?").run(findIssueRow(db, a.id).id);
    expect(cycleAnalytics(db, "S", clock).burnup.map((d) => d.scope)).toEqual([0, 1, 1, 1]);
    expect(cycleAnalytics(db, "S", { today: "2026-10-08", tz: "UTC" }).burnup.map((d) => d.scope)).toEqual([1, 1, 1, 1]);
  });
});
