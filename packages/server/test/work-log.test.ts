import { describe, expect, test } from "bun:test";
import { commentIssue, createIssue, logWork } from "@nod/core";
import { call, setup } from "./helpers";

describe("GET /api/issues/:id の作業ログ", () => {
  test("Activity のコメントに logKind を返し、通常のコメントは null", async () => {
    const s = setup();
    const issue = createIssue(s.me, { workspaceId: s.ws.id, title: "a" });
    logWork(s.llm, issue.id, "IN 句にした理由", { kind: "rationale" });
    commentIssue(s.me, issue.id, "ふつうのコメント");
    const r = await call(s.app, "GET", `/api/issues/${issue.id}`);
    expect(r.status).toBe(200);
    const comments = r.json.activity.filter((a: { kind: string }) => a.kind === "comment");
    expect(comments.map((c: { body: string; logKind: string | null }) => [c.body, c.logKind])).toEqual([
      ["IN 句にした理由", "rationale"],
      ["ふつうのコメント", null],
    ]);
  });
});
