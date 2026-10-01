import { describe, expect, test } from "bun:test";
import { archiveIssue, completeIssue, createIssue, getIssue, type GhRunResult, type OrcaRunner, startIssue } from "@nod/core";
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

describe("Orca で作業を始める API（#210）", () => {
  const NEW_WT = "/tmp/orca/workspaces/api/API-1-search-n1";
  const created = ok({ worktree: { path: NEW_WT, branch: "refs/heads/machamp0714/API-1-search-n1" }, agentTerminalHandle: "term_new" });

  function recording(result: GhRunResult = created) {
    const calls: string[][] = [];
    const orca: OrcaRunner = async (args) => {
      calls.push(args);
      return result;
    };
    return { orca, calls };
  }

  test("POST orca-worktree は orca worktree create を1回呼び、worktree とブランチを記録する", async () => {
    const { orca, calls } = recording();
    const { app, db, ref } = withOrca(orca, null);
    const before = getIssue(db, ref);
    const res = await call(app, "POST", `/api/issues/${ref}/orca-worktree`, { feature: "search-n1" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ issueId: ref, created: true, worktree: NEW_WT, branch: "machamp0714/API-1-search-n1", failure: null });
    expect(calls).toEqual([
      ["worktree", "create", "--repo", "path:/tmp/repos/api-server", "--name", "API-1+search-n1", "--no-parent", "--agent", "claude",
        "--prompt", "nod の Issue API-1 に着手してください", "--activate", "--json"],
    ]);
    expect(getIssue(db, ref)).toMatchObject({ worktree: NEW_WT, branch: "machamp0714/API-1-search-n1", status: before.status, assignee: before.assignee });
  });

  test("NOD_ORCA_AGENT で起動するエージェントを変える", async () => {
    const { orca, calls } = recording();
    const { app, ref } = withOrca(orca, null);
    const saved = process.env.NOD_ORCA_AGENT;
    process.env.NOD_ORCA_AGENT = "codex";
    try {
      await call(app, "POST", `/api/issues/${ref}/orca-worktree`, { feature: "x" });
    } finally {
      if (saved === undefined) delete process.env.NOD_ORCA_AGENT;
      else process.env.NOD_ORCA_AGENT = saved;
    }
    expect(calls[0]?.slice(7, 9)).toEqual(["--agent", "codex"]);
  });

  test("実行場所が記録済みなら orca を呼ばず、200 で failure を返す", async () => {
    const { orca, calls } = recording();
    const { app, db, ref } = withOrca(orca);
    const res = await call(app, "POST", `/api/issues/${ref}/orca-worktree`, { feature: "search-n1" });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ created: false, worktree: WT, failure: { code: "WORKTREE_ALREADY_RECORDED" } });
    expect(calls).toHaveLength(0);
    expect(getIssue(db, ref).worktree).toBe(WT);
  });

  test("NOD_ORCA=0・orca が無い・時間切れ・orca の失敗は 200 で理由を返し、Issue を変えない", async () => {
    const cases: [OrcaRunner | null, string][] = [
      [null, "DISABLED"],
      [recording({ kind: "not_found" }).orca, "ORCA_NOT_INSTALLED"],
      [recording({ kind: "timeout" }).orca, "TIMEOUT"],
      [recording({ kind: "exited", exitCode: 1, stdout: "", stderr: "boom\n" }).orca, "ORCA_ERROR"],
    ];
    for (const [orca, code] of cases) {
      const { app, db, ref } = withOrca(orca, null);
      const before = getIssue(db, ref);
      const res = await call(app, "POST", `/api/issues/${ref}/orca-worktree`, { feature: "search-n1" });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ created: false, worktree: null, branch: null, failure: { code } });
      expect(getIssue(db, ref)).toMatchObject({ worktree: null, branch: null, status: before.status, assignee: before.assignee });
    }
  });

  test("orca を待つ間にアーカイブされたら、200 で作られた worktree のパスを含む failure を返す", async () => {
    const s = withOrca(async () => {
      archiveIssue(s.me, s.ref);
      return created;
    }, null);
    const res = await call(s.app, "POST", `/api/issues/${s.ref}/orca-worktree`, { feature: "search-n1" });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ created: false, failure: { code: "WORKTREE_NOT_RECORDED" } });
    expect(res.json.failure.message).toContain(NEW_WT);
  });

  test("feature が使えない文字を含む・空・無い・文字列でない要求は 400 で、orca を呼ばない。存在しない Issue は 404", async () => {
    const { orca, calls } = recording();
    const { app, ref } = withOrca(orca, null);
    for (const body of [{ feature: "Bad_Name" }, { feature: "a b" }, { feature: "" }, {}, { feature: 1 }, { feature: "x", agent: "codex" }]) {
      const res = await call(app, "POST", `/api/issues/${ref}/orca-worktree`, body);
      expect([body, res.status, res.json.error?.code]).toEqual([body, 400, "INVALID_ARGS"]);
    }
    expect((await call(app, "POST", "/api/issues/API-999/orca-worktree", { feature: "x" })).status).toBe(404);
    expect(calls).toHaveLength(0);
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
