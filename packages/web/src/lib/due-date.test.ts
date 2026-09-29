import { describe, expect, test } from "bun:test";
import { formatDueDate, formatEstimate, parseEstimateInput } from "./due-date";

describe("formatDueDate", () => {
  test("今年は「10月1日」、ほかの年は年を付ける。タイムゾーンで日付をずらさない", () => {
    expect(formatDueDate("2026-10-01", "2026-09-29")).toBe("10月1日");
    expect(formatDueDate("2027-01-05", "2026-09-29")).toBe("2027年1月5日");
    expect(formatDueDate("2025-12-31", "2026-01-01")).toBe("2025年12月31日");
  });
  test("未設定や読めない値は null", () => {
    expect(formatDueDate(null, "2026-09-29")).toBeNull();
    expect(formatDueDate("bad", "2026-09-29")).toBeNull();
  });
});

describe("formatEstimate", () => {
  test("ポイントとして表示し、未設定は null", () => {
    expect(formatEstimate(3)).toBe("3 pt");
    expect(formatEstimate(null)).toBeNull();
  });
});

describe("parseEstimateInput", () => {
  test("空は解除、1〜100 の整数だけを受け付ける", () => {
    expect(parseEstimateInput(" ")).toBeNull();
    expect(parseEstimateInput("3")).toBe(3);
    expect(parseEstimateInput(" 100 ")).toBe(100);
    for (const bad of ["0", "101", "1.5", "-1", "abc"]) expect(parseEstimateInput(bad)).toBeUndefined();
  });
});
