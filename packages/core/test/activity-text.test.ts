import { describe, expect, test } from "bun:test";
import { type ActivityLabels, describeEvent } from "../src/activity-text";

const labels: ActivityLabels = {
  status: (v) => `S:${String(v)}`,
  priority: (v) => `P${String(v)}`,
  agentState: (v) => `A:${String(v)}`,
};

const event = (type: string, data: Record<string, unknown>, actor = "me") =>
  describeEvent({ kind: "event", at: "2026-10-01T00:00:00.000Z", actor, type, data }, labels);

describe("describeEvent（#198）", () => {
  test("起票は由来を文にし、状態と起票元・取り込み元を補足に残す", () => {
    expect(event("created", { status: "todo" })).toEqual({ text: "me が起票した", detail: ["状態: S:todo"] });
    expect(event("created", { status: "triage", discovered_from: "TS-1" }, "claude-code")).toEqual({
      text: "claude-code が起票した",
      detail: ["状態: S:triage", "起票元: TS-1"],
    });
    expect(event("created", { status: "todo", copied_from: "TS-3" })).toEqual({ text: "me が TS-3 から複製した", detail: ["状態: S:todo"] });
    expect(event("created", { status: "todo", recurring_id: 3, occurrence: "2026-10-01" })).toEqual({
      text: "me が定期Issue #3（2026-10-01 分）から起票した",
      detail: ["状態: S:todo"],
    });
    expect(event("created", { status: "done", imported_from: "https://github.com/o/r/issues/12", github_created_at: "2026-01-01T00:00:00Z" })).toEqual({
      text: "me が起票した",
      detail: ["状態: S:done", "取り込み元: https://github.com/o/r/issues/12"],
    });
  });

  test("ステータスの変更は理由を文に、自動化のルールと報告のコメントを補足に残す", () => {
    expect(event("status_changed", { from: "todo", to: "in_progress" })).toEqual({
      text: "me がステータスを S:todo から S:in_progress に変えた",
      detail: [],
    });
    expect(event("status_changed", { from: "in_progress", to: "in_review", reason: "PR が open", automation: "pr_review" })).toEqual({
      text: "me がステータスを S:in_progress から S:in_review に変えた：PR が open",
      detail: ["自動化: pr_review"],
    });
    expect(event("status_changed", { from: "in_progress", to: "in_review", report_comment_id: 7 }, "codex")?.detail).toEqual(["報告: #7"]);
    expect(event("archived", { reason: "30 日動きなし", automation: "auto_archive" })).toEqual({
      text: "me がアーカイブした：30 日動きなし",
      detail: ["自動化: auto_archive"],
    });
  });

  test("作業状況は入力待ちの理由（質問文）を出さず、エラーの理由だけを補足に残す", () => {
    expect(event("agent_state_changed", { from: "working", to: "awaiting_input", agent: "codex", reason: "A か B か" }, "codex")).toEqual({
      text: "codex の作業状況が A:awaiting_input になった",
      detail: [],
    });
    expect(event("agent_state_changed", { from: "working", to: "error", agent: "codex", reason: "ビルドが通らない" }, "codex")).toEqual({
      text: "codex の作業状況が A:error になった",
      detail: ["理由: ビルドが通らない"],
    });
    expect(event("agent_state_changed", { from: "awaiting_input", to: "working", agent: "codex", trigger: "answer" })?.text).toBe(
      "me の回答で codex の作業状況が A:working になった",
    );
    expect(event("agent_state_changed", { from: "done", to: null, agent: "codex" })?.text).toBe("me が codex の作業状況を解除した");
  });

  test("変更の中身は補足に残し、説明は全文を出さない", () => {
    expect(event("title_changed", { from: "旧", to: "新" })).toEqual({ text: "me がタイトルを変えた", detail: ["「旧」→「新」"] });
    expect(event("description_changed", { from: null, to: "長い説明" })).toEqual({ text: "me が説明を変えた", detail: [] });
    expect(event("project_changed", { from: null, to: "nod CLI" })).toEqual({ text: "me が Project を変えた", detail: ["なし → nod CLI"] });
    expect(event("parent_changed", { from: "TS-1", to: null })?.detail).toEqual(["TS-1 → なし"]);
    expect(event("priority_changed", { from: 0, to: 2 })?.text).toBe("me が優先度を P0 から P2 に変えた");
    expect(event("labels_changed", { added: ["bug"], removed: ["ui"] })?.text).toBe("me がラベルを変えた（+bug −ui）");
  });

  test("計画・Document・添付・スレッド・差し戻しの補足", () => {
    expect(event("plan_updated", { source: "docs/plan.md", tasks: 4 })).toEqual({ text: "me が計画を更新した", detail: ["取り込み: docs/plan.md", "4 Task"] });
    expect(event("plan_updated", { source: null, tasks: 3 })?.detail).toEqual(["3 Task"]);
    expect(event("plan_updated", { ref: "2.3", status: "done" })?.detail).toEqual(["2.3 → done"]);
    expect(event("document_attached", { document_id: 5 })).toEqual({ text: "me が Document を添付した", detail: ["Document 5"] });
    expect(event("attachment_added", { kind: "file", name: "log.txt", source_path: "/tmp/log.txt" })).toEqual({
      text: "me がファイルを添付した：log.txt",
      detail: ["元: /tmp/log.txt"],
    });
    expect(event("comment_thread_resolved", { comment_id: 7 })).toEqual({ text: "me がコメントのスレッドを解決済みにした", detail: ["#7"] });
    expect(event("review_rejected", { reason: "テストがない", delegate: "review_fix" })).toEqual({
      text: "me が差し戻した：テストがない",
      detail: ["対応依頼: review_fix"],
    });
    expect(event("pr_linked", { from: "https://github.com/o/r/pull/1", to: "https://github.com/o/r/pull/2" })).toEqual({
      text: "me が PR を紐付けた：https://github.com/o/r/pull/2",
      detail: ["以前: https://github.com/o/r/pull/1"],
    });
  });

  test("知らない種類は null を返す", () => {
    expect(event("snoozed", { until: "2026-10-02T00:00:00.000Z" })).toBeNull();
  });
});
