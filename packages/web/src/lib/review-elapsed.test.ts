import { expect, test } from "bun:test";
import { formatReviewElapsed } from "./review-elapsed";

test("待機込み経過時間の境界とoffsetを解釈する", () => {
  const start = "2026-09-28T00:00:00Z";
  for (const [end, expected] of [[start, "1分未満"], ["2026-09-28T00:00:59Z", "1分未満"], ["2026-09-28T00:01:00Z", "1分"], ["2026-09-28T01:00:00Z", "1時間0分"], ["2026-09-29T01:12:59Z", "25時間12分"], ["2026-09-28T10:12:00+09:00", "1時間12分"]] as const) {
    expect(formatReviewElapsed(start, end)).toBe(expected);
  }
});
test("欠損、不正、負の差をゼロと偽らない", () => {
  for (const bad of [null, "", "1", "bad", "2026-02-30T00:00:00Z", "2026-09-28", "2026-09-28T25:00:00Z"]) {
    expect(formatReviewElapsed(bad, "2026-10-01T00:00:00Z")).toBe("記録なし");
    expect(formatReviewElapsed("2026-01-01T00:00:00Z", bad)).toBe("記録なし");
  }
  expect(formatReviewElapsed("2026-09-29T00:00:00Z", "2026-09-28T00:00:00Z")).toBe("記録なし");
});
