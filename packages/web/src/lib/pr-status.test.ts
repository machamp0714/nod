import { describe, expect, test } from "bun:test";
import type { PrStatus } from "../api/types";
import { ciPill, prStatePill, reviewPill, safeCheckUrl } from "./pr-status";

function status(over: Partial<PrStatus> = {}): PrStatus {
  return {
    prUrl: "https://github.com/o/r/pull/1",
    number: 1,
    title: "t",
    state: "OPEN",
    isDraft: false,
    reviewDecision: null,
    mergedAt: null,
    headSha: null,
    checks: [],
    checkSummary: { success: 0, failure: 0, pending: 0, skipped: 0 },
    fetchedAt: "2026-09-30T00:00:00Z",
    fetchedBy: "me",
    ...over,
  };
}

describe("PR 状態の表示", () => {
  test("状態ピル: Open・Draft・Merged・Closed", () => {
    expect(prStatePill(status())).toEqual({ label: "Open", icon: "git-pull-request", tone: "ready" });
    expect(prStatePill(status({ isDraft: true }))).toEqual({ label: "Draft", icon: "git-pull-request-draft", tone: "gate" });
    expect(prStatePill(status({ state: "MERGED" }))).toEqual({ label: "Merged", icon: "git-merge", tone: "accent" });
    expect(prStatePill(status({ state: "CLOSED", isDraft: true }))).toEqual({ label: "Closed", icon: "git-pull-request-closed", tone: "fail" });
  });

  test("レビューピル: 承認済み・変更要求・レビュー待ち。レビュー不要は出さない", () => {
    expect(reviewPill(status({ reviewDecision: "APPROVED" }))).toEqual({ label: "承認済み", icon: "check", tone: "ready" });
    expect(reviewPill(status({ reviewDecision: "CHANGES_REQUESTED" }))).toEqual({ label: "変更要求", icon: "file-diff", tone: "ask" });
    expect(reviewPill(status({ reviewDecision: "REVIEW_REQUIRED" }))).toEqual({ label: "レビュー待ち", icon: "eye", tone: "gate" });
    expect(reviewPill(status())).toBeNull();
  });

  test("CI ピル: 0 件の区分は省き、失敗があれば赤、実行中だけなら黄、成功だけなら緑。チェックなしは出さない", () => {
    const failing = status({
      checks: [{ name: "a", state: "failure", url: null }],
      checkSummary: { success: 5, failure: 1, pending: 2, skipped: 1 },
    });
    expect(ciPill(failing)).toEqual({ text: "✓5 ✗1 ⋯2", tone: "fail", title: "成功 5 / 失敗 1 / 実行中 2 / スキップ 1" });
    const pending = status({ checks: [{ name: "a", state: "pending", url: null }], checkSummary: { success: 1, failure: 0, pending: 1, skipped: 0 } });
    expect(ciPill(pending)?.tone).toBe("ask");
    expect(ciPill(pending)?.text).toBe("✓1 ⋯1");
    const green = status({ checks: [{ name: "a", state: "success", url: null }], checkSummary: { success: 7, failure: 0, pending: 0, skipped: 0 } });
    expect(ciPill(green)).toMatchObject({ text: "✓7", tone: "ready" });
    expect(ciPill(status())).toBeNull();
    const skipped = status({ checks: [{ name: "a", state: "skipped", url: null }], checkSummary: { success: 0, failure: 0, pending: 0, skipped: 2 } });
    expect(ciPill(skipped)).toMatchObject({ text: "スキップ 2", tone: "ready" });
  });
});

describe("PR 状態の不正な値", () => {
  test("未知の reviewDecision はピルを出さず落ちない", () => {
    expect(reviewPill(status({ reviewDecision: "SOMETHING_NEW" as never }))).toBeNull();
    expect(reviewPill(status({ reviewDecision: "APPROVED" }))?.label).toBe("承認済み");
  });

  test("チェックの URL は http(s) だけリンクにする", () => {
    expect(safeCheckUrl("https://ci.example/1")).toBe("https://ci.example/1");
    expect(safeCheckUrl("http://ci.example/1")).toBe("http://ci.example/1");
    expect(safeCheckUrl("javascript:alert(1)")).toBeNull();
    expect(safeCheckUrl("data:text/html,x")).toBeNull();
    expect(safeCheckUrl(null)).toBeNull();
  });
});
