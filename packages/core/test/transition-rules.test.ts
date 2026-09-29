import { describe, expect, test } from "bun:test";
import { NodError } from "../src/errors";
import { askQuestion, completeIssue, startIssue } from "../src/ops/agent";
import { bulkUpdateIssues } from "../src/ops/bulk-update";
import { acceptTriage, approveReview, declineTriage, rejectReview } from "../src/ops/human";
import { createIssue, updateIssue } from "../src/ops/issues";
import { setStatusNames } from "../src/status-names";
import { answerQuestion } from "../src/ops/human";
import {
  getTransitionRules,
  resetTransitionRules,
  setTransitionRules,
  transitionViolation,
} from "../src/transition-rules";
import { codeOf, eventsOf, setup } from "./helpers";

function errorOf(fn: () => unknown): NodError {
  try {
    fn();
  } catch (e) {
    return e as NodError;
  }
  throw new Error("エラーになりませんでした");
}

describe("ステータスの遷移ルールの設定", () => {
  test("未設定なら制限なし", () => {
    const { db, ws } = setup();
    expect(getTransitionRules(db, ws.key)).toEqual({ workspaceKey: ws.key, forbidden: [], presets: [] });
  });

  test("人が設定すると全体を置き換え、重複は1件にまとめて状態の順に並べる", () => {
    const { db, ws, me } = setup();
    setTransitionRules(me, ws.key, { forbidden: [{ from: "todo", to: "done" }], presets: [] });
    const saved = setTransitionRules(me, ws.key, {
      forbidden: [
        { from: "todo", to: "in_review" },
        { from: "backlog", to: "done" },
        { from: "backlog", to: "done" },
      ],
      presets: ["review_before_done", "review_before_done"],
    });
    expect(saved).toEqual({
      workspaceKey: ws.key,
      forbidden: [
        { from: "backlog", to: "done" },
        { from: "todo", to: "in_review" },
      ],
      presets: ["review_before_done"],
    });
    expect(getTransitionRules(db, ws.key)).toEqual(saved);
  });

  test("reset ですべて解除する", () => {
    const { db, ws, me } = setup();
    setTransitionRules(me, ws.key, { forbidden: [{ from: "backlog", to: "done" }], presets: ["review_before_done"] });
    expect(resetTransitionRules(me, ws.key)).toEqual({ workspaceKey: ws.key, forbidden: [], presets: [] });
    expect(getTransitionRules(db, ws.key).forbidden).toEqual([]);
  });

  test("LLM は設定・解除できないが、読める", () => {
    const { ws, me, llm } = setup();
    setTransitionRules(me, ws.key, { forbidden: [{ from: "backlog", to: "done" }] });
    expect(codeOf(() => setTransitionRules(llm, ws.key, { forbidden: [] }))).toBe("FORBIDDEN_FOR_LLM");
    expect(codeOf(() => resetTransitionRules(llm, ws.key))).toBe("FORBIDDEN_FOR_LLM");
    expect(getTransitionRules(llm.db, ws.key).forbidden).toEqual([{ from: "backlog", to: "done" }]);
  });

  test("不正な指定は INVALID_ARGS", () => {
    const { ws, me } = setup();
    const bad = [
      { forbidden: [{ from: "backlog", to: "nope" }] },
      { forbidden: [{ from: "needs_clarification", to: "todo" }] },
      { forbidden: [{ from: "todo", to: "needs_clarification" }] },
      { forbidden: [{ from: "todo", to: "todo" }] },
      { presets: ["nope"] },
      // レビュー承認の経路は塞げない
      { forbidden: [{ from: "in_review", to: "done" }] },
      // Triage の判断（受け入れ・却下）の経路は塞げない
      { forbidden: [{ from: "triage", to: "todo" }] },
      { forbidden: [{ from: "triage", to: "canceled" }] },
    ];
    for (const input of bad) {
      expect(codeOf(() => setTransitionRules(me, ws.key, input as never))).toBe("INVALID_ARGS");
    }
    expect(getTransitionRules(me.db, ws.key).forbidden).toEqual([]);
  });

  test("未登録の Workspace は NOT_FOUND", () => {
    const { me } = setup();
    expect(codeOf(() => setTransitionRules(me, "NOPE", { forbidden: [] }))).toBe("NOT_FOUND");
  });
});

describe("遷移ルールの適用", () => {
  test("禁止した組の遷移は TRANSITION_NOT_ALLOWED で、どのルールかを示し、何も変えない", () => {
    const { db, ws, me } = setup();
    const issue = createIssue(me, { workspaceId: ws.id, title: "a" });
    updateIssue(me, issue.id, { status: "backlog" });
    setTransitionRules(me, ws.key, { forbidden: [{ from: "backlog", to: "done" }] });
    setStatusNames(me, ws.key, { done: "完了" });
    const e = errorOf(() => updateIssue(me, issue.id, { status: "done", title: "b" }));
    expect(e.code).toBe("TRANSITION_NOT_ALLOWED");
    expect(e.message).toContain("Backlog → 完了");
    expect(e.message).toContain("許可しない遷移");
    expect(e.details).toEqual({ from: "backlog", to: "done", rule: { kind: "forbidden" } });
    const row = updateIssue(me, issue.id, {});
    expect(row.status).toBe("backlog");
    expect(row.title).toBe("a");
    // 禁止していない遷移は通る
    expect(updateIssue(me, issue.id, { status: "todo" }).status).toBe("todo");
    expect(updateIssue(me, issue.id, { status: "done" }).status).toBe("done");
  });

  test("プリセット『done の前に in_review 必須』は in_review 以外から done への遷移を止める", () => {
    const { ws, me, llm } = setup();
    setTransitionRules(me, ws.key, { presets: ["review_before_done"] });
    const issue = createIssue(me, { workspaceId: ws.id, title: "a" });
    const e = errorOf(() => updateIssue(me, issue.id, { status: "done" }));
    expect(e.code).toBe("TRANSITION_NOT_ALLOWED");
    expect(e.message).toContain("done の前に in_review 必須");
    expect(e.details).toEqual({ from: "todo", to: "done", rule: { kind: "preset", preset: "review_before_done" } });
    // レビュー経由なら done にできる
    startIssue(llm, issue.id);
    completeIssue(llm, issue.id, { summary: "終わりました" });
    expect(approveReview(me, issue.id).status).toBe("done");
  });

  test("人の一括編集では違反した Issue が失敗一覧に出て、何も変えない", () => {
    const { ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    updateIssue(me, b.id, { status: "in_review" });
    setTransitionRules(me, ws.key, { presets: ["review_before_done"] });
    const e = errorOf(() => bulkUpdateIssues(me, [a.id, b.id], { status: "done" }));
    expect(e.code).toBe("BULK_UPDATE_FAILED");
    expect((e.details as { failures: { id: string; code: string }[] }).failures).toEqual([
      expect.objectContaining({ id: a.id, code: "TRANSITION_NOT_ALLOWED" }),
    ]);
    expect(updateIssue(me, b.id, {}).status).toBe("in_review");
  });

  test("LLM の着手・完了報告もルールに従う", () => {
    const { ws, me, llm } = setup();
    const issue = createIssue(me, { workspaceId: ws.id, title: "a" });
    setTransitionRules(me, ws.key, { forbidden: [{ from: "todo", to: "in_progress" }] });
    expect(codeOf(() => startIssue(llm, issue.id))).toBe("TRANSITION_NOT_ALLOWED");
    setTransitionRules(me, ws.key, { forbidden: [{ from: "in_progress", to: "in_review" }] });
    startIssue(llm, issue.id);
    expect(codeOf(() => completeIssue(llm, issue.id, { summary: "終わりました" }))).toBe("TRANSITION_NOT_ALLOWED");
    expect(updateIssue(me, issue.id, {}).status).toBe("in_progress");
  });

  test("Triage の判断とレビューの差し戻しもルールに従う", () => {
    const { ws, me, llm } = setup();
    const t = createIssue(llm, { workspaceId: ws.id, title: "t" });
    setTransitionRules(me, ws.key, { forbidden: [{ from: "in_review", to: "in_progress" }] });
    expect(acceptTriage(me, t.id).status).toBe("todo");
    const t2 = createIssue(llm, { workspaceId: ws.id, title: "t2" });
    expect(declineTriage(me, t2.id).status).toBe("canceled");
    updateIssue(me, t.id, { status: "in_review" });
    expect(codeOf(() => rejectReview(me, t.id, "直して"))).toBe("TRANSITION_NOT_ALLOWED");
  });

  test("確認依頼による needs_clarification の出入りはルールの対象にしない", () => {
    const { ws, me, llm } = setup();
    const issue = createIssue(me, { workspaceId: ws.id, title: "a" });
    updateIssue(me, issue.id, { status: "backlog" });
    setTransitionRules(me, ws.key, { forbidden: [{ from: "backlog", to: "todo" }], presets: ["review_before_done"] });
    askQuestion(llm, issue.id, "どちら？");
    expect(updateIssue(me, issue.id, {}).status).toBe("needs_clarification");
    answerQuestion(me, issue.id, "こちら");
    expect(updateIssue(me, issue.id, {}).status).toBe("backlog");
  });

  test("制限なしの Workspace では従来どおり", () => {
    const { ws, me } = setup();
    const issue = createIssue(me, { workspaceId: ws.id, title: "a" });
    expect(updateIssue(me, issue.id, { status: "done" }).status).toBe("done");
    expect(eventsOf(me.db, issue.id).filter((e) => e.type === "status_changed")).toHaveLength(1);
  });

  test("transitionViolation は Workspace ごとに判定する", () => {
    const { db, ws, me } = setup();
    setTransitionRules(me, ws.key, { forbidden: [{ from: "backlog", to: "done" }] });
    expect(transitionViolation(db, ws.id, "backlog", "done")).toEqual({ kind: "forbidden" });
    expect(transitionViolation(db, ws.id, "todo", "done")).toBeNull();
    expect(transitionViolation(db, ws.id, "done", "done")).toBeNull();
  });
});

describe("LLM は Triage の Issue を updateIssue で動かせない（#134）", () => {
  test("ステータス変更は FORBIDDEN_FOR_LLM、ほかの項目の編集はできる", () => {
    const { ws, llm } = setup();
    const t = createIssue(llm, { workspaceId: ws.id, title: "t" });
    expect(codeOf(() => updateIssue(llm, t.id, { status: "todo" }))).toBe("FORBIDDEN_FOR_LLM");
    expect(codeOf(() => bulkUpdateIssues(llm, [t.id], { status: "backlog" }))).toBe("BULK_UPDATE_FAILED");
    expect(updateIssue(llm, t.id, { title: "t2", status: "triage" }).title).toBe("t2");
  });
});
