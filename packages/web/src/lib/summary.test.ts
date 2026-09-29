import { describe, expect, test } from "bun:test";
import type { Summary, SummaryItem, SummaryKind } from "../api/types";
import {
  actorLabel,
  cleanSummarySearch,
  parseSummarySearch,
  SECTION_ORDER,
  summaryGroups,
  summaryNote,
  summaryQueryString,
  summaryTime,
  workspaceKeyOf,
} from "./summary";

function item(kind: SummaryKind, at: string, extra: Partial<SummaryItem> = {}): SummaryItem {
  return {
    kind, at, issueId: "API-1", title: "t", status: "in_progress", assignee: null, archived: false,
    actor: "me", actorKind: "human", recordedBy: "me", from: null, to: null, detail: null, ...extra,
  };
}

function summary(sections: Partial<Record<SummaryKind, SummaryItem[]>>, totals: Partial<Record<SummaryKind, number>> = {}): Summary {
  const kinds: SummaryKind[] = ["completed", "submitted", "rejected", "started", "blocker", "asked", "answered", "created", "canceled", "archived"];
  return {
    since: "", until: "", limit: 10, includeArchived: false, totals: { total: 0, human: 0, llm: 0 },
    sections: kinds.map((kind) => {
      const items = sections[kind] ?? [];
      const total = totals[kind] ?? items.length;
      return { kind, label: kind, total, human: items.filter((x) => x.actorKind === "human").length, llm: items.filter((x) => x.actorKind === "llm").length, more: total - items.length, items };
    }),
  };
}

describe("summary search", () => {
  test("知らない値は捨て、既定値は URL に残さない", () => {
    expect(parseSummarySearch({ since: "7d", workspace: " api ", project: "3", archived: "true" }))
      .toEqual({ since: "7d", workspace: "API", project: "3", archived: true });
    expect(parseSummarySearch({ since: "1y", project: "x", archived: "no" }))
      .toEqual({ since: undefined, project: undefined, archived: undefined });
    expect(cleanSummarySearch({ since: "24h", archived: false })).toEqual({});
    expect(cleanSummarySearch({ since: "30d", workspace: "API", archived: true })).toEqual({ since: "30d", workspace: "API", archived: true });
  });

  test("API のクエリ文字列にする", () => {
    expect(summaryQueryString({}, 10)).toBe("since=24h&limit=10");
    expect(summaryQueryString({ since: "7d", workspace: "API", project: "2", archived: true }, 200))
      .toBe("since=7d&limit=200&workspace=API&project=2&includeArchived=true");
  });
});

describe("summaryGroups", () => {
  test("質問と回答を新しい順にまとめ、件数を足す", () => {
    const s = summary({
      asked: [item("asked", "2026-09-30T10:00:00Z", { actor: "codex", actorKind: "llm" })],
      answered: [item("answered", "2026-09-30T11:00:00Z")],
    });
    const qa = summaryGroups(s).get("qa")!;
    expect(qa.items.map((x) => x.kind)).toEqual(["answered", "asked"]);
    expect([qa.label, qa.total, qa.human, qa.llm, qa.more]).toEqual(["質問/回答", 2, 1, 1, 0]);
  });

  test("広げていない区分は10件に切り詰め、残りを more に数える", () => {
    const many = Array.from({ length: 12 }, (_, n) => item("created", `2026-09-30T${String(n).padStart(2, "0")}:00:00Z`));
    const s = summary({ created: many }, { created: 30 });
    expect([summaryGroups(s).get("created")!.items.length, summaryGroups(s).get("created")!.more]).toEqual([10, 20]);
    const open = summaryGroups(s, new Set(["created"])).get("created")!;
    expect([open.items.length, open.more]).toEqual([12, 18]);
  });

  test("一覧は人の対応が要る区分から並べる", () => {
    expect(SECTION_ORDER.slice(0, 3)).toEqual(["blocker", "rejected", "qa"]);
  });
});

describe("行の表示", () => {
  test("今日は時刻だけ、前日以前は日付も付ける", () => {
    const now = new Date(2026, 8, 30, 12, 0);
    expect(summaryTime(new Date(2026, 8, 30, 9, 5).toISOString(), now)).toBe("09:05");
    expect(summaryTime(new Date(2026, 8, 28, 23, 59).toISOString(), now)).toBe("9/28 23:59");
  });

  test("補足は種類ごとに前置きや遷移を付ける", () => {
    const label = (s: string) => s.toUpperCase();
    expect(summaryNote(item("rejected", "", { detail: "テスト不足" }), label)).toBe("理由: テスト不足");
    expect(summaryNote(item("asked", "", { detail: "どれ？" }), label)).toBe("質問: どれ？");
    expect(summaryNote(item("answered", "", { detail: "A" }), label)).toBe("回答: A");
    expect(summaryNote(item("completed", "", { from: "in_review", to: "done" }), label)).toBe("IN_REVIEW → DONE");
    expect(summaryNote(item("blocker", "", { detail: "権限がない" }), label)).toBe("権限がない");
    expect(summaryNote(item("created", ""), label)).toBe("");
  });

  test("人は「人 · me」、LLM は名前で出す", () => {
    expect(actorLabel({ actor: "me", actorKind: "human" })).toBe("人 · me");
    expect(actorLabel({ actor: "codex", actorKind: "llm" })).toBe("codex");
    expect(workspaceKeyOf("MY-API-12")).toBe("MY-API");
  });
});
