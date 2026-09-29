import { describe, expect, test } from "bun:test";
import { NodError } from "../src/errors";
import { BULK_UPDATE_LIMIT, bulkUpdateIssues } from "../src/ops/bulk-update";
import { archiveIssue, createIssue, getIssue } from "../src/ops/issues";
import { subscribeIssue } from "../src/ops/notifications";
import { createProject } from "../src/ops/projects";
import { codeOf, eventsOf, setup } from "./helpers";

function errorOf(fn: () => unknown): NodError {
  try {
    fn();
  } catch (e) {
    return e as NodError;
  }
  throw new Error("エラーになりませんでした");
}

describe("bulkUpdateIssues", () => {
  test("複数 Issue の状態・優先度・担当・Project・ラベル・見積もり・期限をまとめて変え、各 Issue に event を残す", () => {
    const { db, ws, me } = setup();
    createProject(me, { name: "Alpha" });
    const a = createIssue(me, { workspaceId: ws.id, title: "a", labels: ["old"] });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    const updated = bulkUpdateIssues(me, [a.id, b.id], {
      status: "in_progress",
      priority: 2,
      assignee: "claude-code",
      projectRef: "Alpha",
      estimate: 3,
      dueDate: "2026-10-01",
      addLabels: ["bulk"],
      removeLabels: ["old"],
    });
    expect(updated.map((i) => i.id)).toEqual([a.id, b.id]);
    for (const id of [a.id, b.id]) {
      const i = getIssue(db, id);
      expect(i).toMatchObject({ status: "in_progress", priority: 2, assignee: "claude-code", project: { name: "Alpha" }, estimate: 3, dueDate: "2026-10-01" });
      expect(i.labels).toEqual(["bulk"]);
      const types = eventsOf(db, id).map((e) => e.type);
      for (const t of ["status_changed", "priority_changed", "assignee_changed", "project_changed", "estimate_changed", "due_date_changed"]) {
        expect(types.filter((x) => x === t)).toHaveLength(1);
      }
    }
  });

  test("null で担当・Project・見積もり・期限を解除できる", () => {
    const { db, ws, me } = setup();
    createProject(me, { name: "Alpha" });
    const a = createIssue(me, { workspaceId: ws.id, title: "a", projectRef: "Alpha", estimate: 2, dueDate: "2026-10-01" });
    bulkUpdateIssues(me, [a.id], { assignee: null, projectRef: null, estimate: null, dueDate: null });
    expect(getIssue(db, a.id)).toMatchObject({ assignee: null, project: null, estimate: null, dueDate: null });
  });

  test("重複した ID は1件として扱う", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    expect(bulkUpdateIssues(me, [a.id, a.id], { priority: 1 })).toHaveLength(1);
    expect(eventsOf(db, a.id).filter((e) => e.type === "priority_changed")).toHaveLength(1);
  });

  test("大文字小文字だけ違う ID も解決後の Issue で1件として扱い、上限も1件と数える（#121）", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    expect(bulkUpdateIssues(me, [a.id, a.id.toLowerCase(), ` ${a.id}`], { priority: 1 })).toHaveLength(1);
    expect(eventsOf(db, a.id).filter((e) => e.type === "priority_changed")).toHaveLength(1);
    const others = Array.from({ length: BULK_UPDATE_LIMIT - 1 }, (_, n) => createIssue(me, { workspaceId: ws.id, title: `x${n}` }).id);
    expect(bulkUpdateIssues(me, [a.id, a.id.toLowerCase(), ...others], { priority: 2 })).toHaveLength(BULK_UPDATE_LIMIT);
    // 見つからない ID も表記ゆれは1件として失敗一覧に出す
    const e = errorOf(() => bulkUpdateIssues(me, ["API-999", "api-999"], { priority: 1 }));
    expect(e.details).toEqual({ failures: [{ id: "API-999", code: "NOT_FOUND", message: expect.any(String) }] });
  });

  test("失敗したら購読者の通知も残さない（#121）", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    subscribeIssue(me, a.id);
    const count = () => (db.query("SELECT count(*) AS n FROM notifications").get() as { n: number }).n;
    expect(codeOf(() => bulkUpdateIssues(llm, [a.id, "API-999"], { status: "in_progress", priority: 1 }))).toBe("BULK_UPDATE_FAILED");
    expect(count()).toBe(0);
    // 成功すれば同じ変更で通知が届く（上の 0 件が変更の取り消しによるものであることの確認）
    bulkUpdateIssues(llm, [a.id], { status: "in_progress", priority: 1 });
    expect(count()).toBeGreaterThan(0);
  });

  test("1件でも失敗したら何も書かず、失敗した全 Issue の理由を BULK_UPDATE_FAILED で返す", () => {
    const { db, ws, me, llm } = setup();
    const ok = createIssue(me, { workspaceId: ws.id, title: "ok" });
    const triage = createIssue(llm, { workspaceId: ws.id, title: "triage" });
    const e = errorOf(() => bulkUpdateIssues(me, [ok.id, triage.id, "API-999"], { status: "todo", priority: 1 }));
    expect(e.code).toBe("BULK_UPDATE_FAILED");
    expect(e.details).toEqual({
      failures: [
        { id: triage.id, code: "TRIAGE_DECISION_REQUIRED", message: expect.any(String) },
        { id: "API-999", code: "NOT_FOUND", message: expect.any(String) },
      ],
    });
    expect(getIssue(db, ok.id)).toMatchObject({ status: "todo", priority: 0 });
    expect(eventsOf(db, ok.id).map((ev) => ev.type)).toEqual(["created"]);
  });

  test("LLM が done にすると FORBIDDEN_FOR_LLM で、1件も書かない", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    const e = errorOf(() => bulkUpdateIssues(llm, [a.id, b.id], { status: "done", priority: 1 }));
    expect(e.code).toBe("BULK_UPDATE_FAILED");
    expect((e.details as { failures: { code: string }[] }).failures.map((f) => f.code)).toEqual(["FORBIDDEN_FOR_LLM", "FORBIDDEN_FOR_LLM"]);
    expect(getIssue(db, a.id).priority).toBe(0);
  });

  test("Triage の Issue の状態変更と、状態を triage にする変更は拒否する（人でも）", () => {
    const { db, ws, me, llm } = setup();
    const triage = createIssue(llm, { workspaceId: ws.id, title: "t" });
    const todo = createIssue(me, { workspaceId: ws.id, title: "u" });
    const e = errorOf(() => bulkUpdateIssues(me, [todo.id], { status: "triage" }));
    expect((e.details as { failures: { code: string }[] }).failures.map((f) => f.code)).toEqual(["TRIAGE_DECISION_REQUIRED"]);
    expect(codeOf(() => bulkUpdateIssues(me, [triage.id], { status: "canceled" }))).toBe("BULK_UPDATE_FAILED");
    expect(getIssue(db, triage.id).status).toBe("triage");
    // 状態以外は Triage の Issue でも変えられる
    bulkUpdateIssues(me, [triage.id], { priority: 3, addLabels: ["x"] });
    expect(getIssue(db, triage.id)).toMatchObject({ status: "triage", priority: 3, labels: ["x"] });
  });

  test("アーカイブ済みの Issue を含めると ISSUE_ARCHIVED で、1件も書かない", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const archived = createIssue(me, { workspaceId: ws.id, title: "b" });
    archiveIssue(me, archived.id);
    const e = errorOf(() => bulkUpdateIssues(me, [a.id, archived.id], { priority: 1 }));
    expect(e.code).toBe("BULK_UPDATE_FAILED");
    expect((e.details as { failures: unknown[] }).failures).toEqual([
      { id: archived.id, code: "ISSUE_ARCHIVED", message: expect.any(String) },
    ]);
    expect(getIssue(db, a.id).priority).toBe(0);
  });

  test("上限を超える件数・0件・変更項目なしは INVALID_ARGS", () => {
    const { ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const ids = Array.from({ length: BULK_UPDATE_LIMIT + 1 }, (_, n) => `API-${n + 1}`);
    expect(BULK_UPDATE_LIMIT).toBe(100);
    expect(codeOf(() => bulkUpdateIssues(me, ids, { priority: 1 }))).toBe("INVALID_ARGS");
    expect(codeOf(() => bulkUpdateIssues(me, [], { priority: 1 }))).toBe("INVALID_ARGS");
    expect(codeOf(() => bulkUpdateIssues(me, [a.id], {}))).toBe("INVALID_ARGS");
    expect(codeOf(() => bulkUpdateIssues(me, [a.id], { addLabels: [], removeLabels: [] }))).toBe("INVALID_ARGS");
  });

  test("値そのものが不正なら件数に関係なく INVALID_ARGS をそのまま返す", () => {
    const { ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    expect(codeOf(() => bulkUpdateIssues(me, [a.id], { priority: 9 }))).toBe("INVALID_ARGS");
    expect(codeOf(() => bulkUpdateIssues(me, [a.id], { status: "needs_clarification" }))).toBe("INVALID_ARGS");
  });
});
