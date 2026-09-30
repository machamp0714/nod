import { describe, expect, test } from "bun:test";
import { createIssue, type GhRunResult, type OrcaRunner, startIssue } from "@nod/core";
import { createApp } from "../src/app";
import { call, setup } from "./helpers";

const WT = "/tmp/orca/workspaces/api/feat-search";
const ok = (result: unknown): GhRunResult => ({ kind: "exited", exitCode: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" });

// 実際の orca は起動しない
function withOrca(orca: OrcaRunner | null, worktree: string | null = WT) {
  const s = setup();
  const app = createApp({ db: s.db, orcaRunner: orca });
  const issue = createIssue(s.me, { workspaceId: s.ws.id, title: "検索" });
  startIssue(s.llm, issue.id, { location: worktree ? { worktree, branch: "feat-search" } : null });
  return { ...s, app, ref: issue.id };
}

describe("Orca で開く API（#52）", () => {
  test("POST orca-open は worktree の LLM の端末を前面に出す", async () => {
    const calls: string[][] = [];
    const { app, ref } = withOrca(async (args) => {
      calls.push(args);
      return args[1] === "list"
        ? ok({ terminals: [{ handle: "term_a", title: "claude", worktreePath: WT, connected: true, writable: true, agentIdentity: "claude" }] })
        : ok({});
    });
    const res = await call(app, "POST", `/api/issues/${ref}/orca-open`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ issueId: ref, opened: true, worktree: WT, terminal: { handle: "term_a" }, failure: null });
    expect(calls.map((a) => a.slice(0, 2).join(" "))).toEqual(["terminal list", "terminal switch"]);
  });

  test("orca が無いときは 200 で理由とコピー用のパス・コマンドを返す", async () => {
    const { app, ref } = withOrca(async () => ({ kind: "not_found" }));
    const res = await call(app, "POST", `/api/issues/${ref}/orca-open`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ opened: false, worktree: WT, copyCommand: `cd '${WT}'`, failure: { code: "ORCA_NOT_INSTALLED" } });
  });

  test("orcaRunner: null（NOD_ORCA=0 相当）なら DISABLED、存在しない Issue は 404", async () => {
    const { app, ref } = withOrca(null);
    expect((await call(app, "POST", `/api/issues/${ref}/orca-open`)).json.failure.code).toBe("DISABLED");
    expect((await call(app, "POST", "/api/issues/API-999/orca-open")).status).toBe(404);
  });

  test("外部サイトからの POST は拒否する", async () => {
    const { app, ref } = withOrca(null);
    const res = await app.request(`/api/issues/${ref}/orca-open`, { method: "POST", headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
});
