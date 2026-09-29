import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { createIssue, getIssue, listIssues, updateIssue, validateDueDate, validateEstimate } from "../src/ops/issues";
import { isOverdue, localToday } from "../src/due-date";
import { codeOf, eventsOf, setup, tempDbPath } from "./helpers";

describe("見積もり（estimate）", () => {
  test("既定は未設定（null）で、起票時と更新時に 1〜100 の整数を設定できる", () => {
    const { db, ws, me } = setup();
    const plain = createIssue(me, { workspaceId: ws.id, title: "a" });
    expect(plain.estimate).toBeNull();
    const withEstimate = createIssue(me, { workspaceId: ws.id, title: "b", estimate: 3 });
    expect(withEstimate.estimate).toBe(3);
    expect(updateIssue(me, plain.id, { estimate: 100 }).estimate).toBe(100);
    expect(getIssue(db, plain.id).estimate).toBe(100);
  });

  test("LLM も設定・変更・解除でき、estimate_changed を記録する", () => {
    const { db, ws, llm } = setup();
    const i = createIssue(llm, { workspaceId: ws.id, title: "a" });
    updateIssue(llm, i.id, { estimate: 5 });
    updateIssue(llm, i.id, { estimate: 8 });
    expect(updateIssue(llm, i.id, { estimate: null }).estimate).toBeNull();
    expect(eventsOf(db, i.id).filter((e) => e.type === "estimate_changed")).toEqual([
      { type: "estimate_changed", actor: "claude-code", data: { from: null, to: 5 } },
      { type: "estimate_changed", actor: "claude-code", data: { from: 5, to: 8 } },
      { type: "estimate_changed", actor: "claude-code", data: { from: 8, to: null } },
    ]);
  });

  test("同じ値への更新は event を残さない", () => {
    const { db, ws, me } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "a", estimate: 2 });
    updateIssue(me, i.id, { estimate: 2 });
    expect(eventsOf(db, i.id).some((e) => e.type === "estimate_changed")).toBe(false);
  });

  test("0・負数・小数・101 以上は INVALID_ARGS で、部分更新を残さない", () => {
    const { db, ws, me } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "a" });
    for (const bad of [0, -1, 1.5, 101, Number.NaN]) {
      expect(codeOf(() => validateEstimate(bad))).toBe("INVALID_ARGS");
      expect(codeOf(() => updateIssue(me, i.id, { title: "変更", estimate: bad }))).toBe("INVALID_ARGS");
      expect(codeOf(() => createIssue(me, { workspaceId: ws.id, title: "x", estimate: bad }))).toBe("INVALID_ARGS");
    }
    expect(getIssue(db, i.id)).toMatchObject({ title: "a", estimate: null });
    expect(listIssues(db).length).toBe(1);
  });
});

describe("期限（dueDate）", () => {
  test("YYYY-MM-DD の暦日をそのまま保存し、解除できる", () => {
    const { db, ws, me } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "a", dueDate: "2026-10-01" });
    expect(i.dueDate).toBe("2026-10-01");
    expect(updateIssue(me, i.id, { dueDate: "2024-02-29" }).dueDate).toBe("2024-02-29");
    expect(updateIssue(me, i.id, { dueDate: null }).dueDate).toBeNull();
    expect(eventsOf(db, i.id).filter((e) => e.type === "due_date_changed").map((e) => e.data)).toEqual([
      { from: "2026-10-01", to: "2024-02-29" },
      { from: "2024-02-29", to: null },
    ]);
  });

  test("LLM も期限を設定できる", () => {
    const { ws, llm } = setup();
    const i = createIssue(llm, { workspaceId: ws.id, title: "a" });
    expect(updateIssue(llm, i.id, { dueDate: "2026-12-31" }).dueDate).toBe("2026-12-31");
  });

  test("時刻付き・存在しない日付・形式違いは INVALID_ARGS", () => {
    const { ws, me } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "a" });
    for (const bad of ["2026-02-29", "2026-13-01", "2026-10-1", "2026/10/01", "2026-10-01T09:00:00+09:00", "", " 2026-10-01", "明日"]) {
      expect(codeOf(() => validateDueDate(bad))).toBe("INVALID_ARGS");
      expect(codeOf(() => updateIssue(me, i.id, { dueDate: bad }))).toBe("INVALID_ARGS");
    }
  });
});

describe("移行と DB の制約", () => {
  test("既存の Issue は estimate・due_date が NULL のまま読める", () => {
    const { db, ws, me } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "a" });
    const row = db.query("SELECT estimate, due_date FROM issues").get() as { estimate: unknown; due_date: unknown };
    expect(row).toEqual({ estimate: null, due_date: null });
    expect(getIssue(db, i.id)).toMatchObject({ estimate: null, dueDate: null });
  });

  test("DB も範囲外の見積もりと不正な期限を拒否する", () => {
    const { db, ws, me } = setup();
    createIssue(me, { workspaceId: ws.id, title: "a" });
    expect(() => db.exec("UPDATE issues SET estimate = 0")).toThrow();
    expect(() => db.exec("UPDATE issues SET estimate = 101")).toThrow();
    expect(() => db.exec("UPDATE issues SET estimate = 2.5")).toThrow();
    expect(() => db.exec("UPDATE issues SET due_date = '2026-02-30'")).toThrow();
    expect(() => db.exec("UPDATE issues SET due_date = '2026-10-01T00:00:00Z'")).toThrow();
  });

  test("旧版（見積もり・期限なし）の DB を開くと列が足され、既存データを保つ", () => {
    const path = tempDbPath();
    const first = openDb(path);
    const version = (first.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    first.close();
    // 1つ前の版に戻した DB を作り直す：列を落として版を下げる
    const raw = new Database(path);
    raw.exec("ALTER TABLE issues DROP COLUMN estimate");
    raw.exec("ALTER TABLE issues DROP COLUMN due_date");
    raw.exec(`PRAGMA user_version = ${version - 1}`);
    raw.close();
    const reopened = openDb(path);
    const cols = (reopened.query("PRAGMA table_info(issues)").all() as { name: string; notnull: number }[])
      .filter((c) => c.name === "estimate" || c.name === "due_date");
    expect(cols.map((c) => [c.name, c.notnull])).toEqual([["estimate", 0], ["due_date", 0]]);
  });
});

describe("期限超過", () => {
  test("done / canceled 以外で期限が今日より前なら超過、当日と未設定は超過にしない", () => {
    const today = "2026-10-01";
    expect(isOverdue({ dueDate: "2026-09-30", status: "todo" }, today)).toBe(true);
    expect(isOverdue({ dueDate: "2026-09-30", status: "in_review" }, today)).toBe(true);
    expect(isOverdue({ dueDate: "2026-10-01", status: "todo" }, today)).toBe(false);
    expect(isOverdue({ dueDate: "2026-10-02", status: "todo" }, today)).toBe(false);
    expect(isOverdue({ dueDate: null, status: "todo" }, today)).toBe(false);
    expect(isOverdue({ dueDate: "2026-09-30", status: "done" }, today)).toBe(false);
    expect(isOverdue({ dueDate: "2026-09-30", status: "canceled" }, today)).toBe(false);
  });

  test("今日はローカル日付で YYYY-MM-DD にする", () => {
    expect(localToday(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(localToday(new Date(2026, 11, 31, 0, 0))).toBe("2026-12-31");
  });
});
