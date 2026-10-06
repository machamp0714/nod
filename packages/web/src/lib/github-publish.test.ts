import { expect, test } from "bun:test";
import type { LeakFinding } from "../api/types";
import { canSend, checkReducer, findingLocation, githubLinkLabel, initialCheck } from "./github-publish";

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
