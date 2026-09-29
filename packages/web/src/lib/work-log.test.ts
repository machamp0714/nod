import { describe, expect, test } from "bun:test";
import type { ActivityItem, WorkLogKind } from "../api/types";
import { filterActivity, isMonoWorkLog, WORK_LOG_FILTERS, WORK_LOG_KIND_META } from "./work-log";

const at = "2026-09-28T00:00:00.000Z";
const comment = (id: number, logKind: WorkLogKind | null): ActivityItem => ({
  kind: "comment",
  id,
  at,
  actor: "claude-code",
  body: `本文${id}`,
  replies: [],
  resolvedAt: null,
  resolvedBy: null,
  logKind,
});
const event: ActivityItem = { kind: "event", at, actor: "me", type: "created", data: {} };
const question: ActivityItem = { kind: "question", at, actor: "claude-code", question: "?", answer: null, answeredBy: null, answeredAt: null };
const items = [event, comment(1, null), comment(2, "plan"), comment(3, "blocker"), question, comment(4, "plan")];

describe("作業ログの絞り込み", () => {
  test("チップは すべて・作業ログ・6種類の順", () => {
    expect(WORK_LOG_FILTERS.map((f) => f.label)).toEqual([
      "すべて",
      "作業ログ",
      "経過",
      "方針",
      "判断根拠",
      "実行コマンド・結果",
      "テスト結果",
      "ブロッカー",
    ]);
  });

  test("すべては何も落とさない", () => {
    expect(filterActivity(items, "all")).toEqual(items);
  });

  test("作業ログは種類付きのコメントだけにし、種類なしのコメント・出来事・質問を落とす", () => {
    expect(filterActivity(items, "log").map((i) => (i.kind === "comment" ? i.id : i.kind))).toEqual([2, 3, 4]);
  });

  test("種類を選ぶと、その種類のコメントだけを時系列のまま残す", () => {
    expect(filterActivity(items, "plan").map((i) => (i.kind === "comment" ? i.id : i.kind))).toEqual([2, 4]);
    expect(filterActivity(items, "test")).toEqual([]);
  });
});

describe("種類の表示", () => {
  test("ブロッカーは警告色、判断根拠は gate、テスト結果は ready、経過は accent、方針と実行コマンドは中立色", () => {
    expect(WORK_LOG_KIND_META.blocker.tone).toBe("ask");
    expect(WORK_LOG_KIND_META.rationale.tone).toBe("gate");
    expect(WORK_LOG_KIND_META.test.tone).toBe("ready");
    expect(WORK_LOG_KIND_META.progress.tone).toBe("accent");
    expect(WORK_LOG_KIND_META.plan.tone).toBe("neutral");
    expect(WORK_LOG_KIND_META.command.tone).toBe("neutral");
  });

  test("実行コマンド・結果とテスト結果は等幅で出す", () => {
    expect(isMonoWorkLog("command")).toBe(true);
    expect(isMonoWorkLog("test")).toBe(true);
    expect(isMonoWorkLog("plan")).toBe(false);
    expect(isMonoWorkLog(null)).toBe(false);
  });
});
