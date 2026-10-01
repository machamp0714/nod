import { describe, expect, test } from "bun:test";
import type { OpenQuestion } from "../api/types";
import {
  filterOpenQuestionEntries,
  groupOpenQuestions,
  nextOpenQuestionEntry,
  openQuestionFilterOptions,
  openQuestionSections,
} from "./open-questions";

function q(id: number, issueId: string, over: Partial<OpenQuestion> = {}): OpenQuestion {
  return {
    id,
    issueId,
    question: `質問 ${id}`,
    askedBy: "me",
    askedAt: `2026-09-${String(id).padStart(2, "0")}T00:00:00.000Z`,
    answer: null,
    answeredBy: null,
    answeredAt: null,
    issueTitle: `${issueId} のタイトル`,
    workspace: issueId.split("-")[0]!,
    status: "needs_clarification",
    priority: 0,
    project: null,
    questionCount: { answered: 0, total: 1 },
    ...over,
  };
}

const survey = { id: 1, name: "調査票" };
const billing = { id: 2, name: "課金" };

describe("groupOpenQuestions", () => {
  test("server の順のまま Issue ごとに1項目にまとめ、最古の未回答の質問時刻を持つ", () => {
    const entries = groupOpenQuestions([
      q(5, "API-2", { project: survey, questionCount: { answered: 1, total: 3 } }),
      q(3, "API-2", { project: survey, questionCount: { answered: 1, total: 3 } }),
      q(1, "WEB-1"),
    ]);
    expect(entries.map((e) => [e.issueId, e.questions.map((x) => x.id), e.oldestAt])).toEqual([
      ["API-2", [5, 3], "2026-09-03T00:00:00.000Z"],
      ["WEB-1", [1], "2026-09-01T00:00:00.000Z"],
    ]);
    expect(entries[0]).toMatchObject({ issueTitle: "API-2 のタイトル", workspace: "API", project: survey, questionCount: { answered: 1, total: 3 } });
  });
});

describe("filterOpenQuestionEntries", () => {
  const entries = groupOpenQuestions([
    q(1, "API-1", { project: survey, question: "Q3 は必須にするか" }),
    q(2, "API-1", { project: survey, question: "回答期限はいつか" }),
    q(3, "API-2", { project: billing, issueTitle: "請求書の様式" }),
    q(4, "WEB-7", { question: "ボタンの色" }),
  ]);
  const ids = (filter: Parameters<typeof filterOpenQuestionEntries>[1]) => filterOpenQuestionEntries(entries, filter).map((e) => e.issueId);

  test("条件がなければすべて返す", () => {
    expect(ids({})).toEqual(["API-1", "API-2", "WEB-7"]);
  });

  test("Workspace と Project で絞る", () => {
    expect(ids({ workspace: "API" })).toEqual(["API-1", "API-2"]);
    expect(ids({ project: 2 })).toEqual(["API-2"]);
    expect(ids({ workspace: "WEB", project: 1 })).toEqual([]);
  });

  test("検索は質問文・タイトル・ID のどれかに合う Issue を、質問を欠かさずに返す", () => {
    expect(ids({ q: "期限" })).toEqual(["API-1"]);
    expect(filterOpenQuestionEntries(entries, { q: "期限" })[0]!.questions).toHaveLength(2);
    expect(ids({ q: "請求書" })).toEqual(["API-2"]);
    expect(ids({ q: "web-7" })).toEqual(["WEB-7"]);
    expect(ids({ q: "  " })).toEqual(["API-1", "API-2", "WEB-7"]);
    expect(ids({ q: "どれにも合わない" })).toEqual([]);
  });
});

describe("openQuestionSections", () => {
  const entries = groupOpenQuestions([
    q(1, "API-1"),
    q(2, "API-2", { project: survey }),
    q(3, "API-3", { project: billing }),
    q(4, "API-4", { project: survey }),
    q(5, "API-4", { project: survey }),
  ]);

  test("Project ごとに分け、名前順に並べて Project なしを最後にする。件数は未回答の質問の数", () => {
    expect(openQuestionSections(entries, "project").map((s) => [s.label, s.count, s.entries.map((e) => e.issueId)])).toEqual([
      ["課金", 1, ["API-3"]],
      ["調査票", 3, ["API-2", "API-4"]],
      ["Project なし", 1, ["API-1"]],
    ]);
  });

  test("グループなしは見出しのない1つの区切りにする", () => {
    expect(openQuestionSections(entries, "none")).toEqual([{ key: "all", label: null, count: 5, entries }]);
    expect(openQuestionSections([], "project")).toEqual([]);
  });
});

describe("openQuestionFilterOptions", () => {
  test("未決事項のある Workspace と Project を、重複なく名前順で返す", () => {
    const entries = groupOpenQuestions([q(1, "WEB-1", { project: survey }), q(2, "API-1", { project: billing }), q(3, "API-2", { project: survey }), q(4, "API-3")]);
    expect(openQuestionFilterOptions(entries)).toEqual({ workspaces: ["API", "WEB"], projects: [billing, survey] });
  });
});

describe("nextOpenQuestionEntry", () => {
  const order = ["API-1", "API-2", "API-3"];

  test("一覧から消えた Issue の次の位置にあった Issue を返し、末尾なら1つ前を返す", () => {
    expect(nextOpenQuestionEntry(order, ["API-1", "API-3"], "API-2")).toBe("API-3");
    expect(nextOpenQuestionEntry(order, ["API-1", "API-2"], "API-3")).toBe("API-2");
    expect(nextOpenQuestionEntry(order, ["API-2", "API-3"], "API-1")).toBe("API-2");
  });

  test("まだ一覧にあればそのまま、一覧が空なら undefined", () => {
    expect(nextOpenQuestionEntry(order, order, "API-2")).toBe("API-2");
    expect(nextOpenQuestionEntry(order, [], "API-2")).toBeUndefined();
    expect(nextOpenQuestionEntry(order, ["API-1"], undefined)).toBe("API-1");
  });
});
