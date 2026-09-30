import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { openDb, SCHEMA_VERSION, schemaVersion } from "../src/db";
import { bulkUpdateIssues } from "../src/ops/bulk-update";
import { createCycle, cycleToday, deleteCycle, getCycle, listCycles, moveOpenIssues, resolveCycle, updateCycle } from "../src/ops/cycles";
import { archiveIssue, copyIssue, createIssue, getIssue, queryIssues, updateIssue } from "../src/ops/issues";
import { initWorkspace } from "../src/ops/workspaces";
import { completionStats, statsQueryFromParams } from "../src/ops/stats";
import { recentSummary, summaryQueryFromParams } from "../src/ops/summary";
import { MIGRATIONS } from "../src/schema";
import { codeOf, eventsOf, setup, tempDbPath } from "./helpers";

const today = "2026-10-05";
const clock = { today };

function sprints(me: Parameters<typeof createCycle>[0], workspaceId: number) {
  const past = createCycle(me, { workspaceId, name: "Sprint 1", startDate: "2026-09-21", endDate: "2026-10-04" }, clock);
  const current = createCycle(me, { workspaceId, name: "Sprint 2", startDate: "2026-10-05", endDate: "2026-10-18" }, clock);
  const next = createCycle(me, { workspaceId, name: "Sprint 3", startDate: "2026-10-19", endDate: "2026-11-01" }, clock);
  return { past, current, next };
}

describe("Cycle", () => {
  test("名前・開始日・終了日で作り、今日の暦日から状態を求める（両端を含む）", () => {
    const { db, ws, me } = setup();
    const { past, current, next } = sprints(me, ws.id);
    expect(past).toMatchObject({ workspace: ws.key, name: "Sprint 1", state: "completed", total: 0, done: 0, open: 0, createdBy: "me" });
    expect(current.state).toBe("current");
    expect(next.state).toBe("upcoming");
    expect(listCycles(db, ws.id, { today: "2026-10-18" }).map((c) => c.state)).toEqual(["completed", "current", "upcoming"]);
    expect(listCycles(db, ws.id, { today: "2026-10-19" }).map((c) => c.state)).toEqual(["completed", "completed", "current"]);
    expect(resolveCycle(db, ws.id, "current", clock).name).toBe("Sprint 2");
    expect(codeOf(() => resolveCycle(db, ws.id, "current", { today: "2027-01-01" }))).toBe("NOT_FOUND");
  });

  test("今日は tz の暦日で決める", () => {
    // 2026-10-04T20:00Z は東京では 10-05、ロサンゼルスでは 10-04
    const now = new Date("2026-10-04T20:00:00Z");
    expect(cycleToday({ tz: "Asia/Tokyo", now })).toBe("2026-10-05");
    expect(cycleToday({ tz: "America/Los_Angeles", now })).toBe("2026-10-04");
    expect(codeOf(() => cycleToday({ tz: "+09:00" }))).toBe("INVALID_ARGS");
  });

  test("同じ Workspace で期間が重なる・名前が重なる・不正な期間と名前を拒む。別 Workspace なら重なってよい", () => {
    const { db, ws, me } = setup();
    sprints(me, ws.id);
    const other = initWorkspace(db, { path: "/tmp/repos/web" }).workspace;
    for (const [input, code] of [
      [{ name: "重なり", startDate: "2026-10-18", endDate: "2026-10-18" }, "CYCLE_OVERLAP"],
      [{ name: "包含", startDate: "2026-09-01", endDate: "2026-12-31" }, "CYCLE_OVERLAP"],
      [{ name: "Sprint 1", startDate: "2027-01-01", endDate: "2027-01-02" }, "CYCLE_EXISTS"],
      [{ name: "逆", startDate: "2027-01-02", endDate: "2027-01-01" }, "INVALID_ARGS"],
      [{ name: "不正", startDate: "2027-02-30", endDate: "2027-03-01" }, "INVALID_ARGS"],
      [{ name: " ", startDate: "2027-01-01", endDate: "2027-01-02" }, "INVALID_ARGS"],
      [{ name: "12", startDate: "2027-01-01", endDate: "2027-01-02" }, "INVALID_ARGS"],
      [{ name: "Current", startDate: "2027-01-01", endDate: "2027-01-02" }, "INVALID_ARGS"],
    ] as const) {
      expect(codeOf(() => createCycle(me, { workspaceId: ws.id, ...input }, clock))).toBe(code);
    }
    expect(listCycles(db, ws.id, clock)).toHaveLength(3);
    // 1日だけの Cycle と、別 Workspace の同じ期間・同じ名前
    expect(createCycle(me, { workspaceId: ws.id, name: "1日", startDate: "2026-11-02", endDate: "2026-11-02" }, clock).state).toBe("upcoming");
    expect(createCycle(me, { workspaceId: other.id, name: "Sprint 2", startDate: "2026-10-05", endDate: "2026-10-18" }, clock).workspace).toBe(other.key);
  });

  test("名前・期間を変えられ、自分とは重ならない。他と重なる変更は拒む", () => {
    const { db, ws, me, llm } = setup();
    const { current } = sprints(me, ws.id);
    expect(updateCycle(llm, ws.id, "Sprint 2", { name: "S2", endDate: "2026-10-17" }, clock)).toMatchObject({ name: "S2", endDate: "2026-10-17" });
    expect(updateCycle(me, ws.id, String(current.id), { startDate: "2026-10-06" }, clock).startDate).toBe("2026-10-06");
    expect(codeOf(() => updateCycle(me, ws.id, "S2", { endDate: "2026-10-19" }, clock))).toBe("CYCLE_OVERLAP");
    expect(codeOf(() => updateCycle(me, ws.id, "S2", { name: "Sprint 1" }, clock))).toBe("CYCLE_EXISTS");
    expect(codeOf(() => updateCycle(me, ws.id, "S2", { startDate: "2026-10-30" }, clock))).toBe("INVALID_ARGS");
    expect(codeOf(() => updateCycle(me, ws.id, "S2", {}, clock))).toBe("INVALID_ARGS");
    expect(codeOf(() => updateCycle(me, ws.id, "ない", { name: "x" }, clock))).toBe("NOT_FOUND");
    expect(getCycle(db, ws.id, "S2", clock)).toMatchObject({ startDate: "2026-10-06", endDate: "2026-10-17" });
  });

  test("Issue を Cycle に入れ・外し、cycle_changed を記録する。別 Workspace の Cycle は使えない", () => {
    const { db, ws, me, llm } = setup();
    const { current, next } = sprints(me, ws.id);
    const other = initWorkspace(db, { path: "/tmp/repos/web" }).workspace;
    const foreign = createCycle(me, { workspaceId: other.id, name: "外", startDate: "2026-10-05", endDate: "2026-10-18" }, clock);
    const issue = createIssue(me, { workspaceId: ws.id, title: "作業", cycleRef: String(current.id) });
    expect(issue.cycle).toEqual({ id: current.id, name: "Sprint 2" });
    // LLM も Cycle を変えられ、Triage の Issue でも状態は変わらない
    const triage = createIssue(llm, { workspaceId: ws.id, title: "未判断" });
    expect(updateIssue(llm, triage.id, { cycleRef: "Sprint 3" })).toMatchObject({ status: "triage", cycle: { id: next.id } });
    updateIssue(llm, issue.id, { cycleRef: "Sprint 3" });
    updateIssue(me, issue.id, { cycleRef: null });
    expect(getIssue(db, issue.id).cycle).toBeNull();
    expect(eventsOf(db, issue.id).filter((e) => e.type === "cycle_changed")).toEqual([
      { type: "cycle_changed", actor: "claude-code", data: { from: "Sprint 2", to: "Sprint 3" } },
      { type: "cycle_changed", actor: "me", data: { from: "Sprint 3", to: null } },
    ]);
    expect(codeOf(() => updateIssue(me, issue.id, { cycleRef: String(foreign.id) }))).toBe("NOT_FOUND");
    expect(codeOf(() => createIssue(me, { workspaceId: ws.id, title: "x", cycleRef: "外" }))).toBe("NOT_FOUND");
    // 複製は Cycle を引き継がない
    updateIssue(me, issue.id, { cycleRef: "Sprint 2" });
    expect(copyIssue(me, issue.id).cycle).toBeNull();
  });

  test("進捗は done/total（canceled・アーカイブ除く）で、未完了を open に数える", () => {
    const { db, ws, me } = setup();
    sprints(me, ws.id);
    const mk = (title: string) => createIssue(me, { workspaceId: ws.id, title, cycleRef: "Sprint 1" });
    updateIssue(me, mk("完了").id, { status: "done" });
    mk("未完1");
    updateIssue(me, mk("進行中").id, { status: "in_progress" });
    updateIssue(me, mk("中止").id, { status: "canceled" });
    archiveIssue(me, mk("アーカイブ").id);
    const detail = getCycle(db, ws.id, "Sprint 1", clock);
    expect(detail).toMatchObject({ state: "completed", total: 3, done: 1, open: 2 });
    expect(detail.issues.map((i) => i.title)).toEqual(["完了", "未完1", "進行中", "中止"]);
  });

  test("終了しても自動では移さず、move-open で未完了だけを移す", () => {
    const { db, ws, me, llm } = setup();
    sprints(me, ws.id);
    const done = createIssue(me, { workspaceId: ws.id, title: "完了", cycleRef: "Sprint 1" });
    updateIssue(me, done.id, { status: "done" });
    const canceled = createIssue(me, { workspaceId: ws.id, title: "中止", cycleRef: "Sprint 1" });
    updateIssue(me, canceled.id, { status: "canceled" });
    const open1 = createIssue(me, { workspaceId: ws.id, title: "未完1", cycleRef: "Sprint 1" });
    const open2 = createIssue(llm, { workspaceId: ws.id, title: "未完2", cycleRef: "Sprint 1" });
    const archived = createIssue(me, { workspaceId: ws.id, title: "アーカイブ", cycleRef: "Sprint 1" });
    archiveIssue(me, archived.id);
    // 終了日を過ぎて一覧を読んでも何も移らない
    expect(listCycles(db, ws.id, { today: "2026-12-01" })[0]).toMatchObject({ name: "Sprint 1", open: 2 });
    expect(getIssue(db, open1.id).cycle?.name).toBe("Sprint 1");

    const result = moveOpenIssues(llm, ws.id, "Sprint 1", "current", clock);
    expect(result.moved).toEqual([open1.id, open2.id]);
    expect(result.from).toMatchObject({ total: 1, done: 1, open: 0 });
    expect(result.to).toMatchObject({ name: "Sprint 2", total: 2, open: 2 });
    expect(getIssue(db, open2.id)).toMatchObject({ status: "triage", cycle: { name: "Sprint 2" } });
    expect(getIssue(db, done.id).cycle?.name).toBe("Sprint 1");
    expect(getIssue(db, archived.id).cycle?.name).toBe("Sprint 1");
    expect(eventsOf(db, open1.id).at(-1)).toEqual({ type: "cycle_changed", actor: "claude-code", data: { from: "Sprint 1", to: "Sprint 2" } });
    expect(codeOf(() => moveOpenIssues(me, ws.id, "Sprint 2", "Sprint 2", clock))).toBe("INVALID_ARGS");
    expect(moveOpenIssues(me, ws.id, "Sprint 1", "Sprint 3", clock).moved).toEqual([]);
  });

  test("一括編集で Cycle を変えられる", () => {
    const { db, ws, me } = setup();
    sprints(me, ws.id);
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    bulkUpdateIssues(me, [a.id, b.id], { cycleRef: "Sprint 3" });
    expect([getIssue(db, a.id).cycle?.name, getIssue(db, b.id).cycle?.name]).toEqual(["Sprint 3", "Sprint 3"]);
    bulkUpdateIssues(me, [a.id], { cycleRef: null });
    expect(getIssue(db, a.id).cycle).toBeNull();
  });

  test("Cycle を消すと Issue は Cycle なしに戻る", () => {
    const { db, ws, me } = setup();
    sprints(me, ws.id);
    const issue = createIssue(me, { workspaceId: ws.id, title: "作業", cycleRef: "Sprint 2" });
    expect(deleteCycle(me, ws.id, "Sprint 2", clock)).toMatchObject({ name: "Sprint 2", issues: 1 });
    expect(getIssue(db, issue.id).cycle).toBeNull();
    expect(listCycles(db, ws.id, clock).map((c) => c.name)).toEqual(["Sprint 1", "Sprint 3"]);
    expect(codeOf(() => deleteCycle(me, ws.id, "Sprint 2", clock))).toBe("NOT_FOUND");
  });

  test("LLM は Cycle を作成・編集・未完了の移動ができるが、削除はできない（FORBIDDEN_FOR_LLM）", () => {
    const { db, ws, llm } = setup();
    const { current } = sprints(llm, ws.id);
    expect(updateCycle(llm, ws.id, "Sprint 3", { name: "Sprint 3b" }, clock).name).toBe("Sprint 3b");
    const issue = createIssue(llm, { workspaceId: ws.id, title: "作業", cycleRef: "Sprint 1" });
    expect(moveOpenIssues(llm, ws.id, "Sprint 1", "Sprint 2", clock).moved).toEqual([issue.id]);
    expect(codeOf(() => deleteCycle(llm, ws.id, "Sprint 2", clock))).toBe("FORBIDDEN_FOR_LLM");
    expect(getIssue(db, issue.id).cycle?.id).toBe(current.id);
    expect(listCycles(db, ws.id, clock)).toHaveLength(3);
  });

  test("Issue 一覧を Cycle の ID で絞り込め、名前は Workspace を1つに絞ったときだけ使える", () => {
    const { db, ws, me } = setup();
    const { current } = sprints(me, ws.id);
    createIssue(me, { workspaceId: ws.id, title: "入り", cycleRef: "Sprint 2" });
    createIssue(me, { workspaceId: ws.id, title: "外" });
    expect(queryIssues(db, { cycle: String(current.id) }).issues.map((i) => i.title)).toEqual(["入り"]);
    expect(queryIssues(db, { cycle: "Sprint 2", workspace: [ws.key] }).issues.map((i) => i.title)).toEqual(["入り"]);
    expect(codeOf(() => queryIssues(db, { cycle: "Sprint 2" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => queryIssues(db, { cycle: "999" }))).toBe("NOT_FOUND");
  });

  test("Issue 一覧を cycle=none で Cycle のない Issue だけに絞り込める。none は Cycle の名前に使えない", () => {
    const { db, ws, me } = setup();
    sprints(me, ws.id);
    createIssue(me, { workspaceId: ws.id, title: "入り", cycleRef: "Sprint 2" });
    createIssue(me, { workspaceId: ws.id, title: "外" });
    expect(queryIssues(db, { cycle: "none" }).issues.map((i) => i.title)).toEqual(["外"]);
    expect(queryIssues(db, { cycle: "none", workspace: [ws.key] }).issues.map((i) => i.title)).toEqual(["外"]);
    expect(codeOf(() => createCycle(me, { workspaceId: ws.id, name: " None ", startDate: "2027-01-01", endDate: "2027-01-02" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => updateCycle(me, ws.id, "Sprint 3", { name: "none" }, clock))).toBe("INVALID_ARGS");
  });
});

describe("分析・要約の Cycle 絞り込み", () => {
  test("完了数と要約を Cycle の Issue だけに絞る。名前・current は Workspace を1つに絞ったときだけ", () => {
    const { db, ws, me } = setup();
    const { current } = sprints(me, ws.id);
    const inCycle = createIssue(me, { workspaceId: ws.id, title: "入り", cycleRef: "Sprint 2" });
    const outside = createIssue(me, { workspaceId: ws.id, title: "外" });
    updateIssue(me, inCycle.id, { status: "done" });
    updateIssue(me, outside.id, { status: "done" });
    const base = { by: "week" as const, from: "2026-01-01", to: "2027-06-30", tz: "UTC" };
    expect(completionStats(db, base).totals.completed).toBe(2);
    expect(completionStats(db, { ...base, cycle: String(current.id) }).totals.completed).toBe(1);
    expect(completionStats(db, { ...base, cycle: "current", workspace: [ws.key], now: new Date("2026-10-06T00:00:00Z") }).totals.completed).toBe(1);
    expect(codeOf(() => completionStats(db, { ...base, cycle: "Sprint 2" }))).toBe("INVALID_ARGS");
    expect(statsQueryFromParams(new URLSearchParams("cycle=3")).cycle).toBe("3");

    const titles = (q: Parameters<typeof recentSummary>[1]) =>
      [...new Set(recentSummary(db, { since: "7d", ...q }).sections.flatMap((sec) => sec.items.map((i) => i.title)))].sort();
    expect(titles({})).toEqual(["入り", "外"]);
    expect(titles({ cycle: String(current.id) })).toEqual(["入り"]);
    expect(titles({ cycle: "Sprint 2", workspace: [ws.key] })).toEqual(["入り"]);
    expect(summaryQueryFromParams(new URLSearchParams("cycle=Sprint%202&workspace=API")).cycle).toBe("Sprint 2");
  });
});

test("Cycle の前の版の DB を移行しても既存の Issue を保ち、Cycle なしで始まる", () => {
  const before = MIGRATIONS.findIndex((steps) => steps.some((s) => typeof s === "string" && s.includes("CREATE TABLE cycles")));
  expect(before).toBeGreaterThan(0);
  const path = tempDbPath();
  const old = new Database(path, { create: true });
  old.exec("PRAGMA foreign_keys=ON");
  for (const [v, steps] of MIGRATIONS.slice(0, before).entries()) {
    for (const step of steps) {
      if (typeof step === "string") old.exec(step);
      else step(old);
    }
    old.exec(`PRAGMA user_version=${v + 1}`);
  }
  old.exec("INSERT INTO workspaces (id,key,name,path,next_number,created_at,color) VALUES (1,'API','api','/tmp/api',2,'2026-01-01','#3B82F6')");
  old.exec("INSERT INTO issues (id,workspace_id,number,title,status,created_by,created_at,updated_at) VALUES (1,1,1,'既存','todo','me','2026-01-01','2026-01-01')");
  old.close();

  const db = openDb(path);
  expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
  expect(getIssue(db, "API-1")).toMatchObject({ title: "既存", cycle: null });
  expect(listCycles(db, 1)).toEqual([]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});
