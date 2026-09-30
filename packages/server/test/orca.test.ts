import { describe, expect, test } from "bun:test";
import { completeIssue, createIssue, getIssue, type GhRunResult, type OrcaRunner, startIssue } from "@nod/core";
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

describe("追加指示 API（#51）", () => {
  const LIST = ok({ terminals: [{ handle: "term_a", title: "claude", worktreePath: WT, connected: true, writable: true, agentIdentity: "claude" }] });

  test("記録・一覧・宛先の候補・送信を書き手 me で行い、送信済みは 409 で送り直さない", async () => {
    const sends: string[][] = [];
    const { app, ref } = withOrca(async (args) => {
      if (args[1] === "list") return LIST;
      sends.push(args);
      return ok({ accepted: true });
    });
    const created = await call(app, "POST", `/api/issues/${ref}/instructions`, { body: "テストも追加して" });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ kind: "instruction", createdBy: "me", sendState: "unsent" });
    expect((await call(app, "GET", `/api/issues/${ref}/instructions`)).json).toHaveLength(1);
    const targets = await call(app, "GET", `/api/issues/${ref}/agent-targets`);
    expect(targets.json).toMatchObject({ worktree: WT, failure: null, terminals: [{ handle: "term_a", agentIdentity: "claude" }] });
    expect(sends).toEqual([]);

    const sent = await call(app, "POST", `/api/issues/${ref}/instructions/${created.json.id}/send`, { terminal: "term_a" });
    expect(sent.status).toBe(200);
    expect(sent.json).toMatchObject({ sendState: "sent", sentBy: "me", sentTerminal: "term_a" });
    const again = await call(app, "POST", `/api/issues/${ref}/instructions/${created.json.id}/send`, { terminal: "term_a" });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("INSTRUCTION_ALREADY_SENT");
    expect(sends).toHaveLength(1);
    expect((await call(app, "GET", `/api/issues/${ref}`)).json.pendingInstructions).toHaveLength(1);
  });

  test("不正な入力は 400、結果不明の送り直しは confirmResend が要る", async () => {
    const { app, ref } = withOrca(async (args) => (args[1] === "list" ? LIST : { kind: "timeout" }));
    expect((await call(app, "POST", `/api/issues/${ref}/instructions`, { body: " " })).status).toBe(400);
    expect((await call(app, "POST", `/api/issues/${ref}/instructions`, { text: "x" })).status).toBe(400);
    const created = (await call(app, "POST", `/api/issues/${ref}/instructions`, { body: "x" })).json;
    expect((await call(app, "POST", `/api/issues/${ref}/instructions/abc/send`, { terminal: "term_a" })).status).toBe(400);
    expect((await call(app, "POST", `/api/issues/${ref}/instructions/${created.id}/send`, {})).status).toBe(400);
    expect((await call(app, "POST", `/api/issues/${ref}/instructions/${created.id}/send`, { terminal: "term_a" })).json.sendState).toBe("unconfirmed");
    const blocked = await call(app, "POST", `/api/issues/${ref}/instructions/${created.id}/send`, { terminal: "term_a" });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.code).toBe("SEND_UNCONFIRMED");
    const resent = await call(app, "POST", `/api/issues/${ref}/instructions/${created.id}/send`, { terminal: "term_a", confirmResend: true });
    expect(resent.json.sendState).toBe("unconfirmed");
  });
});

describe("差し戻しの対応依頼 API（#58）", () => {
  test("reject に delegate を付けると対応依頼を記録して返し、送信 API で送れる", async () => {
    const sends: string[][] = [];
    const { app, llm, ref } = withOrca(async (args) => {
      if (args[1] === "list") return ok({ terminals: [{ handle: "term_a", title: "claude", worktreePath: WT, connected: true, writable: true, agentIdentity: "claude" }] });
      sends.push(args);
      return ok({ accepted: true });
    });
    completeIssue(llm, ref, { summary: "直した" });
    const res = await call(app, "POST", `/api/issues/${ref}/reject`, { reason: "テストが足りない", delegate: "review_fix" });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "in_progress", instruction: { kind: "review_fix", sendState: "unsent" } });
    expect(sends).toEqual([]); // 差し戻しだけでは送らない
    const sent = await call(app, "POST", `/api/issues/${ref}/instructions/${res.json.instruction.id}/send`, { terminal: "term_a" });
    expect(sent.json.sendState).toBe("sent");
    expect(sends[0]?.[5]).toContain(`nod: ${ref} が差し戻されました。対応依頼（指摘対応）: テストが足りない`);
  });

  test("delegate の不正な値は 400 で、差し戻さない", async () => {
    const { app, llm, db, ref } = withOrca(null);
    completeIssue(llm, ref, { summary: "直した" });
    const res = await call(app, "POST", `/api/issues/${ref}/reject`, { reason: "x", delegate: "instruction" });
    expect(res.status).toBe(400);
    expect(getIssue(db, ref).status).toBe("in_review");
  });
});
