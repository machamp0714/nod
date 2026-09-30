import { describe, expect, test } from "bun:test";
import { RULE_STATUSES, transitionRulesEditState, type TransitionRulesDraft } from "./transition-rules";

const saved = { workspaceKey: "API", forbidden: [{ from: "backlog" as const, to: "done" as const }], presets: [] };
const draftOf = (d: Partial<TransitionRulesDraft>): TransitionRulesDraft => ({ forbidden: [], reviewBeforeDone: false, ...d });

describe("遷移ルールの編集状態（#73）", () => {
  test("選べるステータスは needs_clarification を除く7つ", () => {
    expect(RULE_STATUSES).toEqual(["triage", "backlog", "todo", "in_progress", "in_review", "done", "canceled"]);
  });

  test("保存済みと同じなら保存できず、変えると保存できる", () => {
    expect(transitionRulesEditState(draftOf({ forbidden: [{ from: "backlog", to: "done" }] }), saved)).toMatchObject({
      changed: false,
      canSave: false,
      error: null,
    });
    const added = transitionRulesEditState(draftOf({ forbidden: [{ from: "backlog", to: "done" }], reviewBeforeDone: true }), saved);
    expect(added).toMatchObject({ changed: true, canSave: true });
    expect(added.input).toEqual({ forbidden: [{ from: "backlog", to: "done" }], presets: ["review_before_done"] });
    // すべて外すのも変更
    expect(transitionRulesEditState(draftOf({}), saved)).toMatchObject({ changed: true, canSave: true, empty: true });
  });

  test("同じステータスへの遷移・重複・禁止できない遷移はエラーで保存できない", () => {
    const same = transitionRulesEditState(draftOf({ forbidden: [{ from: "todo", to: "todo" }] }), saved);
    expect(same).toMatchObject({ canSave: false, invalidRows: [0] });
    expect(same.error).toContain("同じステータス");
    const dup = transitionRulesEditState(
      draftOf({ forbidden: [{ from: "todo", to: "done" }, { from: "todo", to: "done" }] }),
      saved,
    );
    expect(dup).toMatchObject({ canSave: false, invalidRows: [1] });
    expect(dup.error).toContain("重なっています");
    const guarded = transitionRulesEditState(draftOf({ forbidden: [{ from: "in_review", to: "done" }] }), saved);
    expect(guarded).toMatchObject({ canSave: false, invalidRows: [0] });
    expect(guarded.error).toBe("In Review → Done は禁止できません（レビュー承認に必要）");
  });

  test("エラーのステータス名は Workspace の表示名を使う", () => {
    const r = transitionRulesEditState(draftOf({ forbidden: [{ from: "triage", to: "todo" }] }), saved, { todo: "着手可" });
    expect(r.error).toBe("Triage → 着手可 は禁止できません（Triage の受け入れに必要）");
  });
});
