import { describe, expect, test } from "bun:test";
import { completeIssue, createIssue, type GhRunner, getPrStatus, startIssue } from "@nod/core";
import { createApp } from "../src/app";
import { call, setup } from "./helpers";

const PR_URL = "https://github.com/example/api-server/pull/128";
const GH_OK = JSON.stringify({
  number: 128,
  title: "検索 API の N+1 を解消",
  url: PR_URL,
  state: "OPEN",
  isDraft: true,
  reviewDecision: "REVIEW_REQUIRED",
  mergedAt: null,
  statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
});

// 実際の gh は起動しない
function withGh(gh: GhRunner, prUrl: string | null = PR_URL) {
  const s = setup();
  const app = createApp({ db: s.db, ghRunner: gh });
  const issue = createIssue(s.me, { workspaceId: s.ws.id, title: "検索 API" });
  if (prUrl) {
    startIssue(s.llm, issue.id);
    completeIssue(s.llm, issue.id, { summary: "直した", prUrl });
  }
  return { ...s, app, ref: issue.id };
}

describe("PR 状態 API", () => {
  test("GET は保存済みの状態を返し、gh は実行しない", async () => {
    let calls = 0;
    const { app, ref } = withGh(async () => {
      calls++;
      return { kind: "exited", exitCode: 0, stdout: GH_OK, stderr: "" };
    });
    const res = await call(app, "GET", `/api/issues/${ref}/pr-status`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ issueId: ref, prUrl: PR_URL, status: null, fetchError: null });
    expect(calls).toBe(0);
  });

  test("POST refresh で gh を実行し、書き手 me で保存する", async () => {
    const { app, db, ref } = withGh(async () => ({ kind: "exited", exitCode: 0, stdout: GH_OK, stderr: "" }));
    const res = await call(app, "POST", `/api/issues/${ref}/pr-status/refresh`);
    expect(res.status).toBe(200);
    expect(res.json.status).toMatchObject({ state: "OPEN", isDraft: true, reviewDecision: "REVIEW_REQUIRED", fetchedBy: "me" });
    expect(res.json.status.checkSummary).toEqual({ success: 1, failure: 0, pending: 0, skipped: 0 });
    expect(getPrStatus(db, ref).status?.fetchedBy).toBe("me");
  });

  test("取得の失敗は 200 で fetchError を返す", async () => {
    const { app, ref } = withGh(async () => ({ kind: "exited", exitCode: 4, stdout: "", stderr: "" }));
    const res = await call(app, "POST", `/api/issues/${ref}/pr-status/refresh`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: null, fetchError: { code: "GH_AUTH" } });
  });

  test("PR の無い Issue は 400、無い Issue は 404", async () => {
    const { app, ref } = withGh(async () => ({ kind: "not_found" }), null);
    expect((await call(app, "POST", `/api/issues/${ref}/pr-status/refresh`)).status).toBe(400);
    expect((await call(app, "GET", "/api/issues/API-999/pr-status")).status).toBe(404);
    expect((await call(app, "POST", "/api/issues/API-999/pr-status/refresh")).status).toBe(404);
  });

  test("外部サイトからの更新は拒む", async () => {
    const { app, ref } = withGh(async () => ({ kind: "not_found" }));
    const res = await app.request(`/api/issues/${ref}/pr-status/refresh`, { method: "POST", headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
});
