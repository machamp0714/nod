import { describe, expect, test } from "bun:test";
import { countQuestions, formatDateTime, formatQuestionCount, formatRelative, prLabel } from "./format";

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

describe("未決事項の数", () => {
  test("回答のある質問を決定済みとして数える", () => {
    expect(countQuestions([{ answer: "はい" }, { answer: null }, { answer: null }])).toEqual({ decided: 1, total: 3 });
  });

  test("「決定数 / 総数」で表し、質問がなければ — にする", () => {
    expect(formatQuestionCount({ decided: 2, total: 6 })).toBe("2 / 6");
    expect(formatQuestionCount({ decided: 0, total: 0 })).toBe("—");
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
