import { describe, expect, test } from "bun:test";
import type { FetchLike } from "./client";
import { actionRequest, fetchInbox, fetchOpenQuestions, postDecision } from "./decision";

describe("actionRequest", () => {
  test("回答は質問の id と、前後の空白を除いた回答を送る", () => {
    expect(actionRequest({ op: "answer", issueId: "API-1", questionId: 3, answer: " はい \n" })).toEqual({
      path: "/issues/API-1/answer",
      body: { answer: "はい", questionId: 3 },
    });
  });

  test("承認と受け入れは空のオブジェクトを送る", () => {
    expect(actionRequest({ op: "approve", issueId: "API-1" })).toEqual({ path: "/issues/API-1/approve", body: {} });
    expect(actionRequest({ op: "accept", issueId: "API-1" })).toEqual({ path: "/issues/API-1/accept", body: {} });
  });

  test("差し戻し、重複、後回しは server のキーで送る", () => {
    expect(actionRequest({ op: "reject", issueId: "API-1", reason: "テストが足りない" }).body).toEqual({ reason: "テストが足りない" });
    expect(actionRequest({ op: "reject", issueId: "API-1", reason: " x ", delegate: "rebase" }).body).toEqual({ reason: "x", delegate: "rebase" });
    expect(actionRequest({ op: "duplicate", issueId: "API-1", original: " api-2 " }).body).toEqual({ original: "api-2" });
    expect(actionRequest({ op: "snooze", issueId: "API-1", until: "2026-10-01" }).body).toEqual({ until: "2026-10-01" });
  });

  test("却下の理由は空なら送らない", () => {
    expect(actionRequest({ op: "decline", issueId: "API-1", reason: "  " }).body).toEqual({});
    expect(actionRequest({ op: "decline", issueId: "API-1" }).body).toEqual({});
    expect(actionRequest({ op: "decline", issueId: "API-1", reason: "不要" }).body).toEqual({ reason: "不要" });
  });
});

describe("postDecision と fetchInbox", () => {
  test("POST と GET で /api を前置し、Issue の ID を URL に埋める", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    };
    await postDecision({ op: "approve", issueId: "API-1" }, fetchImpl);
    await fetchInbox(fetchImpl);
    await fetchOpenQuestions(fetchImpl);
    expect(calls.map((c) => [c.init?.method, c.url])).toEqual([
      ["POST", "/api/issues/API-1/approve"],
      ["GET", "/api/inbox"],
      ["GET", "/api/open-questions?askedBy=me"],
    ]);
    expect(calls[0]?.init?.body).toBe("{}");
  });
});

test("受け入れ属性は一回のPOSTへ含め、履歴だけ別クエリを使う", async () => {
  expect(actionRequest({ op: "accept", issueId: "API-1", input: { priority: 0, projectRef: null, addLabels: ["bug"] } }).body)
    .toEqual({ priority: 0, projectRef: null, addLabels: ["bug"] });
  const urls: string[] = [];
  await fetchInbox(async (url) => { urls.push(url); return new Response("{}"); }, { includeAnswered: true });
  expect(urls).toEqual(["/api/inbox?includeAnswered=true"]);
});
