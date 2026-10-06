import { expect, test } from "bun:test";
import { ApiError } from "../api/client";
import type { LeakFinding } from "../api/types";
import { canSend, checkReducer, findingLocation, githubLinkLabel, initialCheck, recordFailedUrl, splitBlockers, unlinkConfirmText } from "./github-publish";

const finding: LeakFinding = { field: "body", line: 2, column: 3, text: "NOD-1", rule: "issue_id", reason: "r" };
const ok = { sending: false, repo: "example/api-server", ghLogin: "alice", blocked: false };

test("編集すると検査待ちになり、その版の結果が届くまで送れない", () => {
  let s = initialCheck([]);
  expect(canSend(s, ok)).toBe(true);
  s = checkReducer(s, { type: "edited" });
  expect(s.status).toBe("checking");
  expect(canSend(s, ok)).toBe(false);
  s = checkReducer(s, { type: "result", revision: s.revision, findings: [] });
  expect(canSend(s, ok)).toBe(true);
});

test("古い版の結果は捨てる", () => {
  let s = checkReducer(initialCheck([]), { type: "edited" }); // revision 1
  const old = s.revision;
  s = checkReducer(s, { type: "edited" }); // revision 2
  s = checkReducer(s, { type: "result", revision: old, findings: [] });
  expect(s.status).toBe("checking");
  expect(canSend(s, ok)).toBe(false);
});

test("検出あり・検査失敗・送信中・宛先やアカウントがない・公開できないときは送れない", () => {
  expect(canSend(initialCheck([finding]), ok)).toBe(false);
  let s = checkReducer(initialCheck([]), { type: "edited" });
  s = checkReducer(s, { type: "failed", revision: s.revision, error: "x" });
  expect(s.status).toBe("error");
  expect(canSend(s, ok)).toBe(false);
  expect(canSend(initialCheck([]), { ...ok, sending: true })).toBe(false);
  expect(canSend(initialCheck([]), { ...ok, repo: null })).toBe(false);
  expect(canSend(initialCheck([]), { ...ok, ghLogin: null })).toBe(false);
  expect(canSend(initialCheck([]), { ...ok, blocked: true })).toBe(false);
});

test("表示用の文字列", () => {
  expect(findingLocation(finding)).toBe("本文 2 行 3 桁");
  expect(findingLocation({ ...finding, field: "title", line: 1, column: 1 })).toBe("タイトル 1 行 1 桁");
  expect(githubLinkLabel({ repo: "example/api-server", number: 41 })).toBe("example/api-server#41");
});

test("下見の文面が長すぎるときは検査失敗から始め、直して検査が通れば送れる", () => {
  let s = initialCheck([], "タイトルは 256 文字までです");
  expect(s.status).toBe("error");
  expect(canSend(s, ok)).toBe(false);
  s = checkReducer(s, { type: "edited" });
  s = checkReducer(s, { type: "result", revision: s.revision, findings: [] });
  expect(canSend(s, ok)).toBe(true);
});

test("文面の長さの理由（INVALID_ARGS）は編集で直せるため、ほかの公開できない理由と分ける", () => {
  const closed = { code: "ISSUE_CLOSED", message: "閉じています" };
  expect(splitBlockers([closed])).toEqual({ text: null, others: [closed] });
  expect(splitBlockers([{ code: "INVALID_ARGS", message: "タイトルは 256 文字までです" }, closed, { code: "INVALID_ARGS", message: "本文は 65536 文字までです" }])).toEqual({
    text: "タイトルは 256 文字までです。本文は 65536 文字までです",
    others: [closed],
  });
});

test("GITHUB_RECORD_FAILED のときだけ、作成済みの URL を取り出す", () => {
  const url = "https://github.com/example/api-server/issues/41";
  expect(recordFailedUrl(new ApiError(500, "GITHUB_RECORD_FAILED", "m", { url }))).toBe(url);
  expect(recordFailedUrl(new ApiError(500, "GITHUB_RECORD_FAILED", "m"))).toBe(null);
  expect(recordFailedUrl(new ApiError(500, "GITHUB_RECORD_FAILED", "m", { url: "javascript:alert(1)" }))).toBe(null);
  expect(recordFailedUrl(new ApiError(502, "GITHUB_RESULT_UNKNOWN", "m", { url }))).toBe(null);
  expect(recordFailedUrl(new Error("x"))).toBe(null);
});

test("解除の確認文は、作成した試行があるときだけ再公開できないと伝える", () => {
  expect(unlinkConfirmText(true)).toContain("外しても再公開はできません");
  expect(unlinkConfirmText(false)).not.toContain("再公開はできません");
});
