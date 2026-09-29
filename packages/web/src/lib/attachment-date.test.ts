import { expect, test } from "bun:test";
import { attachmentDate } from "../components/issue-detail/DocumentsSection";

test("添付日とCreatedは欠損・非ISO・存在しない暦日を記録なしにする", () => {
  for (const bad of [null, "", "bad", "2026-02-30T00:00:00Z", "2026-02-29T00:00:00Z", "2026-09-28", "2026-09-28T24:00:00Z"]) {
    expect(attachmentDate(bad)).toBe("記録なし");
  }
  for (const valid of ["2024-02-29T00:00:00Z", "2026-09-28T09:00:00+09:00", "2026-09-28T00:00:00.123Z"]) {
    expect(attachmentDate(valid)).toBe(new Date(valid).toLocaleDateString("ja-JP", { month: "long", day: "numeric" }));
  }
});
