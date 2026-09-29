import { describe, expect, test } from "bun:test";
import { completeIssue, createIssue, type GhRunner, getPrDiff, startIssue } from "@nod/core";
import { createApp } from "../src/app";
import { call, setup } from "./helpers";

const PR_URL = "https://github.com/example/api-server/pull/128";
const HEAD = "a".repeat(40);
const BASE = "c".repeat(40);
const VIEW = JSON.stringify({ headRefOid: HEAD, baseRefOid: BASE, changedFiles: 1 });
const DIFF = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-<script>alert(1)</script>\n+ok\n";

// 実際の gh は起動しない。gh pr view と gh api compare を引数で返し分ける
const okGh: GhRunner = async (args) => ({ kind: "exited", exitCode: 0, stdout: args[0] === "pr" ? VIEW : DIFF, stderr: "" });

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

describe("PR 差分 API", () => {
  test("GET は保存済みの差分を返し、gh は実行しない", async () => {
    let calls = 0;
    const { app, ref } = withGh(async (args) => {
      calls++;
      return okGh(args, { timeoutMs: 1 });
    });
    const res = await call(app, "GET", `/api/issues/${ref}/pr-diff`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ issueId: ref, prUrl: PR_URL, diff: null, stale: null, fetchError: null });
    expect(calls).toBe(0);
  });

  test("POST refresh で gh を実行し、書き手 me で保存する。差分の本文は文字列のまま返す", async () => {
    const { app, db, ref } = withGh(okGh);
    const res = await call(app, "POST", `/api/issues/${ref}/pr-diff/refresh`);
    expect(res.status).toBe(200);
    expect(res.json.diff).toMatchObject({ headSha: HEAD, baseSha: BASE, additions: 1, deletions: 1, fetchedBy: "me" });
    expect(res.json.diff.files[0].patch).toBe("@@ -1 +1 @@\n-<script>alert(1)</script>\n+ok");
    expect(getPrDiff(db, ref).diff?.fetchedBy).toBe("me");
  });

  test("取得の失敗は 200 で fetchError を返す", async () => {
    const { app, ref } = withGh(async () => ({ kind: "exited", exitCode: 4, stdout: "", stderr: "" }));
    const res = await call(app, "POST", `/api/issues/${ref}/pr-diff/refresh`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ diff: null, fetchError: { code: "GH_AUTH" } });
  });

  test("PR の無い Issue は 400、無い Issue は 404", async () => {
    const { app, ref } = withGh(okGh, null);
    expect((await call(app, "POST", `/api/issues/${ref}/pr-diff/refresh`)).status).toBe(400);
    expect((await call(app, "GET", "/api/issues/API-999/pr-diff")).status).toBe(404);
    expect((await call(app, "POST", "/api/issues/API-999/pr-diff/refresh")).status).toBe(404);
  });

  test("外部サイトからの更新は拒む", async () => {
    const { app, ref } = withGh(okGh);
    const res = await app.request(`/api/issues/${ref}/pr-diff/refresh`, { method: "POST", headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
});
