import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { completeIssue, startIssue } from "../src/ops/agent";
import { createIssue, updateIssue } from "../src/ops/issues";
import { createProject, listProjects } from "../src/ops/projects";
import { completionStats } from "../src/ops/stats";
import { initWorkspace } from "../src/ops/workspaces";
import { findIssueRow } from "../src/issue-query";
import { codeOf, setup } from "./helpers";

// ops は現在時刻で記録するため、テストでは記録済みの時刻を書き換えて期間を作る
function stamp(db: Database, ref: string, at: { started?: string | null; closed?: string; submitted?: string }): void {
  const row = findIssueRow(db, ref);
  if (at.started !== undefined) db.query("UPDATE issues SET started_at = ? WHERE id = ?").run(at.started, row.id);
  if (at.closed !== undefined) db.query("UPDATE issues SET closed_at = ? WHERE id = ?").run(at.closed, row.id);
  if (at.submitted !== undefined) {
    db.query(`UPDATE events SET created_at = ? WHERE issue_id = ? AND type = 'status_changed'
      AND json_extract(data, '$.to') = 'in_review'`).run(at.submitted, row.id);
  }
}

const UTC = { tz: "UTC" };

describe("completionStats（完了数・作業時間の推移）", () => {
  test("日ごとに done の件数を closed_at の日付で数え、件数0の日も0で埋める", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    const c = createIssue(me, { workspaceId: ws.id, title: "c" });
    for (const i of [a, b, c]) updateIssue(me, i.id, { status: "done" });
    stamp(db, a.id, { closed: "2026-09-01T10:00:00.000Z" });
    stamp(db, b.id, { closed: "2026-09-01T23:59:59.000Z" });
    stamp(db, c.id, { closed: "2026-09-03T00:00:00.000Z" });

    const s = completionStats(db, { ...UTC, by: "day", from: "2026-09-01", to: "2026-09-04" });
    expect(s).toMatchObject({ by: "day", from: "2026-09-01", to: "2026-09-04", tz: "UTC" });
    expect(s.buckets.map((x) => [x.start, x.completed])).toEqual([
      ["2026-09-01", 2],
      ["2026-09-02", 0],
      ["2026-09-03", 1],
      ["2026-09-04", 0],
    ]);
    expect(s.totals.completed).toBe(3);
  });

  test("週は月曜始まりで、from をその週の月曜へ広げる", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    updateIssue(me, a.id, { status: "done" });
    updateIssue(me, b.id, { status: "done" });
    stamp(db, a.id, { closed: "2026-09-06T12:00:00.000Z" }); // 日曜 → 8/31 の週
    stamp(db, b.id, { closed: "2026-09-07T00:00:00.000Z" }); // 月曜 → 9/7 の週

    const s = completionStats(db, { ...UTC, by: "week", from: "2026-09-02", to: "2026-09-13" });
    expect(s.from).toBe("2026-08-31");
    expect(s.buckets.map((x) => [x.start, x.end, x.completed])).toEqual([
      ["2026-08-31", "2026-09-06", 1],
      ["2026-09-07", "2026-09-13", 1],
    ]);
  });

  test("期間の境界は指定したタイムゾーンの日付で決める", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    updateIssue(me, a.id, { status: "done" });
    stamp(db, a.id, { closed: "2026-09-01T15:30:00.000Z" }); // 東京では 9/2 00:30

    const tokyo = completionStats(db, { tz: "Asia/Tokyo", by: "day", from: "2026-09-01", to: "2026-09-02" });
    expect(tokyo.buckets.map((x) => x.completed)).toEqual([0, 1]);
    const utc = completionStats(db, { ...UTC, by: "day", from: "2026-09-01", to: "2026-09-02" });
    expect(utc.buckets.map((x) => x.completed)).toEqual([1, 0]);
  });

  test("canceled は完了数・作業時間に含めず、別系列で数える", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    updateIssue(me, a.id, { status: "canceled" });
    updateIssue(me, b.id, { status: "done" });
    stamp(db, a.id, { started: "2026-09-01T00:00:00.000Z", closed: "2026-09-01T05:00:00.000Z" });
    stamp(db, b.id, { started: "2026-09-01T00:00:00.000Z", closed: "2026-09-01T01:00:00.000Z" });

    const [day] = completionStats(db, { ...UTC, by: "day", from: "2026-09-01", to: "2026-09-01" }).buckets;
    expect(day).toMatchObject({ completed: 1, canceled: 1, work: { measured: 1, medianMinutes: 60, totalMinutes: 60 } });
  });

  test("作業時間は Reviews と同じく着手から最後のレビュー提出まで。提出がなければ完了時刻まで", () => {
    const { db, ws, me, llm } = setup();
    const reviewed = createIssue(me, { workspaceId: ws.id, title: "reviewed" });
    startIssue(llm, reviewed.id);
    completeIssue(llm, reviewed.id, { summary: "できました" });
    updateIssue(me, reviewed.id, { status: "done" });
    stamp(db, reviewed.id, {
      started: "2026-09-01T00:00:00.000Z",
      submitted: "2026-09-01T02:00:00.000Z",
      closed: "2026-09-01T09:00:00.000Z",
    });
    const direct = createIssue(me, { workspaceId: ws.id, title: "direct" });
    updateIssue(me, direct.id, { status: "in_progress" });
    updateIssue(me, direct.id, { status: "done" });
    stamp(db, direct.id, { started: "2026-09-01T00:00:00.000Z", closed: "2026-09-01T06:00:00.000Z" });
    const extra = createIssue(me, { workspaceId: ws.id, title: "extra" });
    updateIssue(me, extra.id, { status: "done" });
    stamp(db, extra.id, { started: "2026-09-01T00:00:00.000Z", closed: "2026-09-01T10:00:00.000Z" });

    const [day] = completionStats(db, { ...UTC, by: "day", from: "2026-09-01", to: "2026-09-01" }).buckets;
    // 2時間・6時間・10時間 → 中央値6時間、合計18時間
    expect(day!.work).toEqual({ measured: 3, unrecorded: 0, medianMinutes: 360, totalMinutes: 1080 });
  });

  test("着手時刻がない・終了が着手より前の Issue は作業時間の記録なしとして数える", () => {
    const { db, ws, me } = setup();
    const noStart = createIssue(me, { workspaceId: ws.id, title: "a" });
    const reversed = createIssue(me, { workspaceId: ws.id, title: "b" });
    updateIssue(me, noStart.id, { status: "done" });
    updateIssue(me, reversed.id, { status: "done" });
    stamp(db, noStart.id, { started: null, closed: "2026-09-01T01:00:00.000Z" });
    stamp(db, reversed.id, { started: "2026-09-01T05:00:00.000Z", closed: "2026-09-01T01:00:00.000Z" });

    const s = completionStats(db, { ...UTC, by: "day", from: "2026-09-01", to: "2026-09-01" });
    expect(s.buckets[0]).toMatchObject({ completed: 2, work: { measured: 0, unrecorded: 2, medianMinutes: null, totalMinutes: 0 } });
    expect(s.totals).toMatchObject({ completed: 2, work: { unrecorded: 2, medianMinutes: null } });
  });

  test("中央値は偶数件なら中央2件の平均（分未満切り捨て）で、合計欄は全期間の値", () => {
    const { db, ws, me } = setup();
    const minutes = [[1, "2026-09-01"], [4, "2026-09-01"], [10, "2026-09-02"]] as const;
    for (const [m, d] of minutes) {
      const i = createIssue(me, { workspaceId: ws.id, title: `${m}` });
      updateIssue(me, i.id, { status: "done" });
      stamp(db, i.id, { started: `${d}T00:00:00.000Z`, closed: `${d}T00:${String(m).padStart(2, "0")}:30.000Z` });
    }
    const s = completionStats(db, { ...UTC, by: "day", from: "2026-09-01", to: "2026-09-02" });
    expect(s.buckets[0]!.work).toMatchObject({ medianMinutes: 2, totalMinutes: 5 });
    expect(s.totals.work).toMatchObject({ measured: 3, medianMinutes: 4, totalMinutes: 15 });
  });

  test("全期間の完了数の合計は Project の Done 数と一致し、再オープン後の再完了は1回だけ数える", () => {
    const { db, ws, me } = setup();
    createProject(me, { name: "検索" });
    const a = createIssue(me, { workspaceId: ws.id, title: "a", projectRef: "検索" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b", projectRef: "検索" });
    createIssue(me, { workspaceId: ws.id, title: "other" });
    updateIssue(me, a.id, { status: "done" });
    updateIssue(me, a.id, { status: "todo" });
    updateIssue(me, a.id, { status: "done" });
    updateIssue(me, b.id, { status: "done" });
    const today = new Date().toISOString().slice(0, 10);
    const s = completionStats(db, { ...UTC, by: "week", to: today, project: "検索" });
    expect(s.totals.completed).toBe(listProjects(db)[0]!.done);
    expect(s.totals.completed).toBe(2);
  });

  test("Workspace と Project で絞り込める", () => {
    const { db, ws, me } = setup();
    const other = initWorkspace(db, { path: "/tmp/repos/web-app" }).workspace;
    const p = createProject(me, { name: "検索" });
    const a = createIssue(me, { workspaceId: ws.id, title: "a", projectRef: "検索" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    const c = createIssue(me, { workspaceId: other.id, title: "c" });
    for (const i of [a, b, c]) {
      updateIssue(me, i.id, { status: "done" });
      stamp(db, i.id, { closed: "2026-09-01T00:00:00.000Z" });
    }
    const q = { ...UTC, by: "day" as const, from: "2026-09-01", to: "2026-09-01" };
    expect(completionStats(db, q).totals.completed).toBe(3);
    expect(completionStats(db, { ...q, workspace: [ws.key] }).totals.completed).toBe(2);
    expect(completionStats(db, { ...q, workspace: [ws.key.toLowerCase(), other.key] }).totals.completed).toBe(3);
    expect(completionStats(db, { ...q, project: "検索" }).totals.completed).toBe(1);
    expect(completionStats(db, { ...q, project: String(p.id), workspace: [other.key] }).totals.completed).toBe(0);
  });

  test("既定の範囲は 日=直近30日、週=直近12週（今日を含む）", () => {
    const { db } = setup();
    const at = new Date("2026-09-29T12:00:00.000Z"); // 火曜
    const day = completionStats(db, { ...UTC, by: "day", now: at });
    expect([day.from, day.to, day.buckets.length]).toEqual(["2026-08-31", "2026-09-29", 30]);
    const week = completionStats(db, { ...UTC, now: at });
    expect(week.by).toBe("week");
    expect([week.from, week.to, week.buckets.length]).toEqual(["2026-07-13", "2026-09-29", 12]);
    expect(week.buckets.at(-1)).toMatchObject({ start: "2026-09-28", end: "2026-09-29" });
  });

  test("不正な指定は INVALID_ARGS、ない Project・Workspace は NOT_FOUND", () => {
    const { db } = setup();
    const bad = (q: Parameters<typeof completionStats>[1]) => codeOf(() => completionStats(db, q));
    expect(bad({ by: "month" as never })).toBe("INVALID_ARGS");
    expect(bad({ from: "2026-02-30" })).toBe("INVALID_ARGS");
    expect(bad({ to: "2026/09/01" })).toBe("INVALID_ARGS");
    expect(bad({ from: "2026-09-02", to: "2026-09-01" })).toBe("INVALID_ARGS");
    expect(bad({ by: "day", from: "2020-01-01", to: "2026-09-01" })).toBe("INVALID_ARGS");
    expect(bad({ tz: "Mars/Olympus" })).toBe("INVALID_ARGS");
    expect(bad({ project: "ない" })).toBe("NOT_FOUND");
    expect(bad({ workspace: ["NOPE"] })).toBe("NOT_FOUND");
  });

  test("読み取り専用で DB を変更しない", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    updateIssue(me, a.id, { status: "done" });
    const before = db.query("SELECT total_changes() AS n").get() as { n: number };
    completionStats(db, { ...UTC, by: "day" });
    expect(db.query("SELECT total_changes() AS n").get()).toEqual(before);
  });
});
