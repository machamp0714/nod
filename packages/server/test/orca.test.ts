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
      return args[0] === "worktree" ? result : args[1] === "wait" ? ok({ wait: { satisfied: true } }) : ok({ send: { accepted: true } });
    };
    return { orca, calls };
  }

  test("作成名と日本語の表示名をプレビューし、保存した正確な場所に表示名を設定する", async () => {
    const calls: string[][] = [];
    const s = withOrca(async (args) => {
      calls.push(args);
      if (args[1] === "set") expect(getIssue(s.db, s.ref).worktree).toBe(NEW_WT);
      return args[1] === "create" ? created : args[1] === "wait" ? ok({ wait: { satisfied: true } }) : ok({ send: { accepted: true } });
    }, null);
    const preview = await call(s.app, "GET", `/api/issues/${s.ref}/worktree-name?feature=search-n1`);
    expect(preview.json).toEqual({ issueId: s.ref, name: "search-n1-a67fefb7", displayName: "API-1 検索" });
    const res = await call(s.app, "POST", `/api/issues/${s.ref}/orca-worktree`, { feature: "search-n1" });
    expect(res.json.created).toBe(true);
    expect(calls[1]).toEqual(["worktree", "set", "--worktree", `path:${NEW_WT}`, "--display-name", "API-1 検索", "--json"]);
  });

  test("feature の省略と空文字で未公開・公開済みの作成名を使い、日本語表示名を保持する", async () => {
    for (const feature of [undefined, ""]) {
      for (const published of [false, true]) {
        const { orca, calls } = recording();
        const s = withOrca(orca, null);
        if (published) {
          await call(s.app, "PUT", "/api/workspaces/API/github-repo", { repo: "example/api-server" });
          // GitHub との境界は代替応答で公開済み Issue を作る。
          const app = createApp({ db: s.db, orcaRunner: orca, ghRunner: async () => ({ kind: "exited", exitCode: 0, stdout: JSON.stringify({ number: 7, html_url: "https://github.com/example/api-server/issues/7" }), stderr: "" }) });
          expect((await call(app, "POST", `/api/issues/${s.ref}/github/link`, { url: "https://github.com/example/api-server/issues/7" })).status).toBe(200);
        }
        const preview = await call(s.app, "GET", `/api/issues/${s.ref}/worktree-name?feature=`);
        expect(preview.json).toMatchObject({ name: published ? "issue-7" : "a67fefb7", displayName: "API-1 検索" });
        const res = await call(s.app, "POST", `/api/issues/${s.ref}/orca-worktree`, feature === undefined ? {} : { feature });
        expect(res.status).toBe(200);
        expect(res.json.created).toBe(true);
        expect(calls[0]?.[5]).toBe(published ? "issue-7" : "a67fefb7");
        expect(calls[1]?.[5]).toBe("API-1 検索");
      }
    }
  });

  test("表示名は長い日本語と引用符を保持し、改行・制御文字・連続空白を一行に整える", async () => {
    const { orca, calls } = recording();
    const s = withOrca(orca, null);
    const title = `通知の表示\n\tを直す\u0001  '$(echo unsafe)' ${"長い作業内容".repeat(60)} 末尾の違い`;
    const issue = createIssue(s.me, { workspaceId: s.ws.id, title });
    const expected = `API-2 通知の表示 を直す '$(echo unsafe)' ${"長い作業内容".repeat(60)} 末尾の違い`;
    const preview = await call(s.app, "GET", `/api/issues/${issue.id}/worktree-name?feature=custom-name`);
    expect(preview.json.displayName).toBe(expected);
    const res = await call(s.app, "POST", `/api/issues/${issue.id}/orca-worktree`, { feature: "custom-name" });
    expect(res.json.created).toBe(true);
    expect(calls[1]).toEqual(["worktree", "set", "--worktree", `path:${NEW_WT}`, "--display-name", expected, "--json"]);
  });

  test("POST orca-worktree は orca worktree create を1回呼び、worktree とブランチを記録する", async () => {
    const { orca, calls } = recording();
    const { app, db, ref } = withOrca(orca, null);
    const before = getIssue(db, ref);
    const res = await call(app, "POST", `/api/issues/${ref}/orca-worktree`, { feature: "search-n1" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ issueId: ref, created: true, worktree: NEW_WT, branch: "machamp0714/API-1-search-n1", failure: null });
    expect(calls).toEqual([
      ["worktree", "create", "--repo", "path:/tmp/repos/api-server", "--name", "search-n1-a67fefb7", "--no-parent", "--agent", "claude", "--activate", "--json"],
      ["worktree", "set", "--worktree", `path:${NEW_WT}`, "--display-name", "API-1 検索", "--json"],
      ["terminal", "wait", "--terminal", "term_new", "--for", "tui-idle", "--timeout-ms", "30000", "--json"],
      ["terminal", "send", "--terminal", "term_new", "--text", ref, "--json"],
    ]);
    expect(getIssue(db, ref)).toMatchObject({ worktree: NEW_WT, branch: "machamp0714/API-1-search-n1", status: before.status, assignee: before.assignee });
  });

  test("エージェントは body の agent、無ければ Workspace の既定（PUT default-agent で変える）", async () => {
    const { orca, calls } = recording();
    const s1 = withOrca(orca, null);
    const put = await call(s1.app, "PUT", `/api/workspaces/${s1.ws.key}/default-agent`, { agent: "codex" });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ key: s1.ws.key, defaultAgent: "codex" });
    expect((await call(s1.app, "GET", "/api/workspaces")).json[0].defaultAgent).toBe("codex");
    await call(s1.app, "POST", `/api/issues/${s1.ref}/orca-worktree`, { feature: "x" });
    expect(calls[0]?.slice(7, 9)).toEqual(["--agent", "codex"]);
    const s2 = withOrca(orca, null);
    await call(s2.app, "POST", `/api/issues/${s2.ref}/orca-worktree`, { feature: "x", agent: "codex" });
    expect(calls.filter((args) => args[1] === "create")[1]?.slice(7, 9)).toEqual(["--agent", "codex"]);
    expect((await call(s2.app, "GET", "/api/workspaces")).json[0].defaultAgent).toBe("claude");
  });

  test("既定エージェントの不正な値は 400、存在しない Workspace は 404", async () => {
    const { app, ws } = withOrca(null, null);
    for (const body of [{ agent: "gemini" }, { agent: 1 }, {}, { agent: "codex", extra: 1 }]) {
      const res = await call(app, "PUT", `/api/workspaces/${ws.key}/default-agent`, body);
      expect([body, res.status, res.json.error?.code]).toEqual([body, 400, "INVALID_ARGS"]);
    }
    expect((await call(app, "PUT", "/api/workspaces/NOPE/default-agent", { agent: "codex" })).status).toBe(404);
    expect((await call(app, "GET", "/api/workspaces")).json[0].defaultAgent).toBe("claude");
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

  test("ブランチだけが記録済みでも orca を呼ばず、200 で failure を返す", async () => {
    const { orca, calls } = recording();
    const { app, db, ref } = withOrca(orca, null);
    db.query("UPDATE issues SET branch = 'feat-branch-only' WHERE number = 1").run();
    const res = await call(app, "POST", `/api/issues/${ref}/orca-worktree`, { feature: "search-n1" });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ created: false, branch: "feat-branch-only", failure: { code: "WORKTREE_ALREADY_RECORDED" } });
    expect(calls).toHaveLength(0);
    expect(getIssue(db, ref)).toMatchObject({ worktree: null, branch: "feat-branch-only" });
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

  test("同じ Issue への同時の要求は、orca を1回だけ呼び、もう一方は 200 で failure を返す", async () => {
    const calls: string[][] = [];
    let release: (r: GhRunResult) => void = () => {};
    const { app, db, ref } = withOrca((args) => {
      if (args[1] !== "create") return Promise.resolve(args[1] === "wait" ? ok({ wait: { satisfied: true } }) : ok({ send: { accepted: true } }));
      calls.push(args);
      return new Promise((resolve) => { release = resolve; });
    }, null);
    const first = call(app, "POST", `/api/issues/${ref}/orca-worktree`, { feature: "a" });
    const second = await call(app, "POST", `/api/issues/${ref}/orca-worktree`, { feature: "b" });
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ created: false, failure: { code: "WORKTREE_CREATING" } });
    release(created);
    expect((await first).json).toMatchObject({ created: true, worktree: NEW_WT });
    expect(calls).toHaveLength(1);
    expect(getIssue(db, ref).worktree).toBe(NEW_WT);
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

  test("feature が使えない文字を含む・文字列でない要求は 400 で、orca を呼ばない。存在しない Issue は 404", async () => {
    const { orca, calls } = recording();
    const { app, ref } = withOrca(orca, null);
    for (const body of [{ feature: "Bad_Name" }, { feature: "a b" }, { feature: 1 }, { feature: "x", agent: "gemini" }, { feature: "x", agent: 1 }, { feature: "x", extra: 1 }]) {
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
