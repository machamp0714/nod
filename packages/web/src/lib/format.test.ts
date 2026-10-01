import { describe, expect, test } from "bun:test";
import { countQuestions, formatDateTime, formatOpenQuestions, formatQuestionCount, formatRelative, formatUpdated, prLabel } from "./format";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const before = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

describe("formatRelative", () => {
  test("分、時間、日で表す", () => {
    expect(formatRelative(before(0), NOW)).toBe("たった今");
    expect(formatRelative(before(12), NOW)).toBe("12分前");
    expect(formatRelative(before(125), NOW)).toBe("2時間前");
    expect(formatRelative(before(60 * 24 * 3), NOW)).toBe("3日前");
  });

  test("未来の時刻は「たった今」にする", () => {
    expect(formatRelative(before(-5), NOW)).toBe("たった今");
  });
});

// design/nod.pen「11 Issues」（O7KCp3）の行の右端：「12分前」「1時間前」「9月26日」
describe("formatUpdated", () => {
  const now = new Date(2026, 8, 28, 12, 0, 0);
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  test("24時間以内は相対、それより前はローカルの月日で表す", () => {
    expect(formatUpdated(ago(0), now)).toBe("たった今");
    expect(formatUpdated(ago(12), now)).toBe("12分前");
    expect(formatUpdated(ago(60 * 23 + 59), now)).toBe("23時間前");
    expect(formatUpdated(ago(60 * 24), now)).toBe("9月27日");
    expect(formatUpdated(new Date(2026, 0, 5, 9, 0).toISOString(), now)).toBe("1月5日");
  });
  test("年が違えば年を付け、読めない値は空にする", () => {
    expect(formatUpdated(new Date(2025, 11, 31, 23, 0).toISOString(), now)).toBe("2025年12月31日");
    expect(formatUpdated("bad", now)).toBe("");
  });
});

describe("未決事項の数", () => {
  test("回答のある質問を決定済みとして数える", () => {
    expect(countQuestions([{ answer: "はい" }, { answer: null }, { answer: null }])).toEqual({ decided: 1, total: 3 });
  });

  test("「決定数 / 総数」で表し、質問がなければ — にする", () => {
    expect(formatQuestionCount({ decided: 2, total: 6 })).toBe("2 / 6");
    expect(formatQuestionCount({ decided: 0, total: 0 })).toBe("—");
  });

  // design/nod.pen「11 Issues｜行：未決ピル」（a21Zf）：未回答があるときだけ「未決 決定数/総数」
  test("一覧の行の未決ピルは、未回答があるときだけ出す", () => {
    expect(formatOpenQuestions({ decided: 0, total: 2 })).toBe("未決 0/2");
    expect(formatOpenQuestions({ decided: 1, total: 3 })).toBe("未決 1/3");
    expect(formatOpenQuestions({ decided: 2, total: 2 })).toBeNull();
    expect(formatOpenQuestions({ decided: 0, total: 0 })).toBeNull();
  });
});

describe("prLabel", () => {
  test("GitHub の PR の URL から番号を取り出す", () => {
    expect(prLabel("https://github.com/example/api-server/pull/128")).toBe("#128");
    expect(prLabel("https://example.com/merge/7")).toBe("PR");
  });
});

test("formatDateTime はローカル時刻の YYYY-MM-DD HH:mm にし、読めない値はそのまま返す", () => {
  const d = new Date(2026, 8, 29, 23, 40, 12);
  expect(formatDateTime(d.toISOString())).toBe("2026-09-29 23:40");
  expect(formatDateTime("bad")).toBe("bad");
});
