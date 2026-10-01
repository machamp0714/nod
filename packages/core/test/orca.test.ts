import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveIssue, createIssue, getIssue } from "../src/ops/issues";
import { startIssue } from "../src/ops/agent";
import { cdCommand, createOrcaWorktree, defaultOrcaRunner, openInOrca, orcaCommand, type OrcaRunner, samePath } from "../src/ops/orca";
import type { GhRunResult } from "../src/ops/pr-status";
import { findWorkspace, listWorkspaces, setWorkspaceDefaultAgent } from "../src/ops/workspaces";
import { setup } from "./helpers";

const WT = "/tmp/orca/workspaces/api/feat-search";

function terminal(extra: Record<string, unknown> = {}) {
  return {
    handle: "term_a",
    title: "claude",
    worktreePath: WT,
    connected: true,
    writable: true,
    orphaned: false,
    agentIdentity: "claude",
    ...extra,
  };
}

const ok = (result: unknown): GhRunResult => ({ kind: "exited", exitCode: 0, stdout: JSON.stringify({ id: "x", ok: true, result }), stderr: "" });

// orca の代わり。サブコマンドごとの結果を返し、呼び出しを記録する（実際の orca は起動しない）
function stubOrca(results: Record<string, GhRunResult>): { run: OrcaRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: OrcaRunner = async (args) => {
    calls.push(args);
    return results[`${args[0]} ${args[1]}`] ?? { kind: "not_found" };
  };
  return { run, calls };
}

function issueWithWorktree(worktree: string | null = WT) {
  const s = setup();
  const issue = createIssue(s.me, { workspaceId: s.ws.id, title: "検索" });
  startIssue(s.llm, issue.id, { location: worktree ? { worktree, branch: "feat-search" } : null });
  return { ...s, ref: issue.id };
}

describe("orcaCommand と defaultOrcaRunner", () => {
  test("ORCA_CLI_COMMAND が無ければ orca、空白区切りなら分ける", () => {
    expect(orcaCommand(undefined)).toEqual(["orca"]);
    expect(orcaCommand("bun /x/fake.ts")).toEqual(["bun", "/x/fake.ts"]);
  });

  test("NOD_ORCA=0 なら runner を作らない", () => {
    expect(defaultOrcaRunner({ NOD_ORCA: "0" })).toBeNull();
    expect(defaultOrcaRunner({})).not.toBeNull();
  });

  test("ORCA_CLI_COMMAND の偽の orca を実行する（本物の orca は使わない）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nod-orca-"));
    const bin = join(dir, "orca");
    writeFileSync(bin, `#!/bin/sh\necho '{"ok":true,"result":{"args":"'"$*"'"}}'\n`);
    chmodSync(bin, 0o755);
    const run = defaultOrcaRunner({ ORCA_CLI_COMMAND: bin });
    const res = await run!(["terminal", "list", "--json"], { timeoutMs: 5000 });
    expect(res.kind).toBe("exited");
    expect(res.kind === "exited" && JSON.parse(res.stdout).result.args).toBe("terminal list --json");
  });
});

describe("openInOrca（#52）", () => {
  test("worktree の LLM の端末を terminal switch で前面に出す", async () => {
    const { db, ref } = issueWithWorktree();
    const { run, calls } = stubOrca({
      "terminal list": ok({ terminals: [terminal({ handle: "term_shell", agentIdentity: null }), terminal()] }),
      "terminal switch": ok({ switched: true }),
    });
    const res = await openInOrca(db, ref, run);
    expect(res).toMatchObject({ opened: true, worktree: WT, failure: null, terminal: { handle: "term_a", agentIdentity: "claude" } });
    expect(calls).toEqual([
      ["terminal", "list", "--worktree", `path:${WT}`, "--json"],
      ["terminal", "switch", "--terminal", "term_a", "--json"],
    ]);
  });

  test("LLM の端末が無ければ書き込める端末を前面に出す", async () => {
    const { db, ref } = issueWithWorktree();
    const { run, calls } = stubOrca({
      "terminal list": ok({ terminals: [terminal({ handle: "dead", agentIdentity: null, connected: false }), terminal({ handle: "sh", agentIdentity: null })] }),
      "terminal switch": ok({}),
    });
    expect((await openInOrca(db, ref, run)).terminal?.handle).toBe("sh");
    expect(calls[1]).toEqual(["terminal", "switch", "--terminal", "sh", "--json"]);
  });

  test("別の worktree の端末は選ばない", async () => {
    const { db, ref } = issueWithWorktree();
    const { run, calls } = stubOrca({ "terminal list": ok({ terminals: [terminal({ worktreePath: `${WT}/nested` })] }) });
    const res = await openInOrca(db, ref, run);
    expect(res.failure?.code).toBe("NO_TERMINAL");
    expect(calls).toHaveLength(1);
  });

  test("開けないときは理由と、パス・cd コマンドを返す", async () => {
    const cases: [Record<string, GhRunResult>, string][] = [
      [{}, "ORCA_NOT_INSTALLED"],
      [{ "terminal list": { kind: "timeout" } }, "TIMEOUT"],
      [{ "terminal list": { kind: "exited", exitCode: 1, stdout: '{"ok":false,"error":{"code":"selector_not_found","message":"no"}}', stderr: "" } }, "WORKTREE_NOT_IN_ORCA"],
      [{ "terminal list": ok({ terminals: [] }) }, "NO_TERMINAL"],
      [{ "terminal list": ok({ terminals: [terminal()] }), "terminal switch": { kind: "exited", exitCode: 1, stdout: "", stderr: "boom\n" } }, "ORCA_ERROR"],
    ];
    for (const [results, code] of cases) {
      const { db, ref } = issueWithWorktree();
      const res = await openInOrca(db, ref, stubOrca(results).run);
      expect(res).toMatchObject({ opened: false, worktree: WT, copyCommand: `cd '${WT}'`, failure: { code } });
      expect(res.failure?.message.length).toBeGreaterThan(0);
    }
  });

  test("NOD_ORCA=0（runner なし）や worktree 未記録では orca を実行しない", async () => {
    const disabled = issueWithWorktree();
    expect((await openInOrca(disabled.db, disabled.ref, null)).failure?.code).toBe("DISABLED");
    const none = issueWithWorktree(null);
    const { run, calls } = stubOrca({});
    expect(await openInOrca(none.db, none.ref, run)).toMatchObject({ opened: false, worktree: null, copyCommand: null, failure: { code: "NO_WORKTREE" } });
    expect(calls).toHaveLength(0);
  });

  test("worktree のパスはシンボリックリンクと末尾のスラッシュの違いを無視して比べる", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "nod-orca-path-")));
    const real = join(root, "real");
    mkdirSync(real);
    const link = join(root, "link");
    symlinkSync(real, link);
    expect(samePath(real, link)).toBe(true);
    expect(samePath(`${real}/`, real)).toBe(true);
    expect(samePath("/no/such/dir/", "/no/such/dir")).toBe(true);
    expect(samePath(`${real}/nested`, real)).toBe(false);

    const { db, ref } = issueWithWorktree(link);
    const { run, calls } = stubOrca({
      "terminal list": ok({ terminals: [terminal({ worktreePath: `${real}/` })] }),
      "terminal switch": ok({ terminal: { handle: "term_a" } }),
    });
    const res = await openInOrca(db, ref, run);
    expect(res.failure).toBeNull();
    expect(calls.map((c) => c[1])).toEqual(["list", "switch"]);
  });

  test("cd コマンドは単一引用符を含むパスもそのまま貼れる形にする", () => {
    expect(cdCommand("/tmp/it's")).toBe(`cd '/tmp/it'\\''s'`);
  });
});

describe("createOrcaWorktree（#210）", () => {
  const NEW_WT = "/tmp/orca/workspaces/api/API-1-search-n1";
  const created = ok({ worktree: { path: NEW_WT, branch: "refs/heads/machamp0714/API-1-search-n1" }, agentTerminalHandle: "term_new" });

  function unstarted() {
    const s = setup();
    const issue = createIssue(s.me, { workspaceId: s.ws.id, title: "検索" });
    return { ...s, ref: issue.id };
  }

  test("orca worktree create を1回呼び、結果の worktree とブランチを Issue に記録する。ステータスと担当は変えない", async () => {
    const { db, me, ref } = unstarted();
    const before = getIssue(db, ref);
    const { run, calls } = stubOrca({ "worktree create": created });
    const res = await createOrcaWorktree(me, ref, { feature: "search-n1" }, run);
    expect(res).toEqual({ issueId: "API-1", created: true, worktree: NEW_WT, branch: "machamp0714/API-1-search-n1", failure: null });
    expect(calls).toEqual([
      ["worktree", "create", "--repo", "path:/tmp/repos/api-server", "--name", "API-1+search-n1", "--no-parent", "--agent", "claude",
        "--prompt", "nod の Issue API-1 に着手してください", "--activate", "--json"],
    ]);
    const after = getIssue(db, ref);
    expect(after).toMatchObject({ worktree: NEW_WT, branch: "machamp0714/API-1-search-n1", status: before.status, assignee: before.assignee, agentState: before.agentState });
  });

  test("エージェントは作成時の指定、無ければ Workspace の既定、既定は claude。時間切れは 60 秒で打ち切る", async () => {
    const seen: { args: string[]; timeoutMs: number }[] = [];
    const run: OrcaRunner = async (args, opts) => {
      seen.push({ args, timeoutMs: opts.timeoutMs });
      return created;
    };
    const agentOf = (i: number) => seen[i]?.args.slice(7, 9);
    const a = unstarted();
    await createOrcaWorktree(a.me, a.ref, { feature: "x" }, run);
    expect(agentOf(0)).toEqual(["--agent", "claude"]);
    expect(seen[0]?.timeoutMs).toBe(60_000);
    const b = unstarted();
    setWorkspaceDefaultAgent(b.me, b.ws.key, "codex");
    await createOrcaWorktree(b.me, b.ref, { feature: "x" }, run);
    expect(agentOf(1)).toEqual(["--agent", "codex"]);
    const c = unstarted();
    setWorkspaceDefaultAgent(c.me, c.ws.key, "codex");
    await createOrcaWorktree(c.me, c.ref, { feature: "x", agent: "claude" }, run);
    expect(agentOf(2)).toEqual(["--agent", "claude"]);
  });

  test("agent が claude・codex 以外なら INVALID_ARGS で、orca を呼ばない", async () => {
    const { me, ref } = unstarted();
    const { run, calls } = stubOrca({ "worktree create": created });
    for (const agent of ["", "gemini", "Claude", "claude --dangerously"]) {
      const code = await createOrcaWorktree(me, ref, { feature: "x", agent }, run).then(() => undefined, (e) => (e as { code?: string }).code);
      expect([agent, code]).toEqual([agent, "INVALID_ARGS"]);
    }
    expect(calls).toHaveLength(0);
  });

  test("Workspace の既定エージェントは claude で始まり、人だけが claude・codex に変えられる", () => {
    const { db, me, llm, ws } = setup();
    expect(findWorkspace(db, ws.key)?.defaultAgent).toBe("claude");
    expect(setWorkspaceDefaultAgent(me, ws.key, "codex")).toMatchObject({ key: ws.key, defaultAgent: "codex" });
    expect(listWorkspaces(db)[0]?.defaultAgent).toBe("codex");
    const codeOf = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { code?: string }).code; } return undefined; };
    expect(codeOf(() => setWorkspaceDefaultAgent(me, ws.key, "gemini"))).toBe("INVALID_ARGS");
    expect(codeOf(() => setWorkspaceDefaultAgent(llm, ws.key, "claude"))).toBe("FORBIDDEN_FOR_LLM");
    expect(codeOf(() => setWorkspaceDefaultAgent(me, "NOPE", "claude"))).toBe("NOT_FOUND");
    expect(findWorkspace(db, ws.key)?.defaultAgent).toBe("codex");
  });

  test("ブランチが refs/heads/ で始まらなければそのまま、無ければ null を記録する", async () => {
    const a = unstarted();
    await createOrcaWorktree(a.me, a.ref, { feature: "x" }, stubOrca({ "worktree create": ok({ worktree: { path: NEW_WT, branch: "feat-x" } }) }).run);
    expect(getIssue(a.db, a.ref)).toMatchObject({ worktree: NEW_WT, branch: "feat-x" });
    const b = unstarted();
    await createOrcaWorktree(b.me, b.ref, { feature: "x" }, stubOrca({ "worktree create": ok({ worktree: { path: NEW_WT } }) }).run);
    expect(getIssue(b.db, b.ref)).toMatchObject({ worktree: NEW_WT, branch: null });
  });

  test("実行場所が記録済みなら orca を呼ばず、失敗として返す", async () => {
    const { db, me, ref } = issueWithWorktree();
    const { run, calls } = stubOrca({ "worktree create": created });
    const res = await createOrcaWorktree(me, ref, { feature: "search-n1" }, run);
    expect(res).toMatchObject({ created: false, worktree: WT, branch: "feat-search", failure: { code: "WORKTREE_ALREADY_RECORDED" } });
    expect(calls).toHaveLength(0);
    expect(getIssue(db, ref)).toMatchObject({ worktree: WT, branch: "feat-search" });
  });

  test("ブランチだけが記録済みの Issue でも orca を呼ばず、失敗として返す（ブランチ名を上書きしない）", async () => {
    const { db, me, ref } = unstarted();
    db.query("UPDATE issues SET branch = 'feat-branch-only' WHERE number = 1").run();
    const { run, calls } = stubOrca({ "worktree create": created });
    const res = await createOrcaWorktree(me, ref, { feature: "search-n1" }, run);
    expect(res).toMatchObject({ created: false, worktree: null, branch: "feat-branch-only", failure: { code: "WORKTREE_ALREADY_RECORDED" } });
    expect(calls).toHaveLength(0);
    expect(getIssue(db, ref)).toMatchObject({ worktree: null, branch: "feat-branch-only" });
  });

  test("NOD_ORCA=0・orca が無い・時間切れ・orca の失敗・読めない結果は理由を返し、Issue を変えない", async () => {
    const cases: [OrcaRunner | null, string, string][] = [
      [null, "DISABLED", "NOD_ORCA=0"],
      [stubOrca({}).run, "ORCA_NOT_INSTALLED", "orca が見つかりません"],
      [stubOrca({ "worktree create": { kind: "timeout" } }).run, "TIMEOUT", "60秒以内"],
      [stubOrca({ "worktree create": { kind: "exited", exitCode: 1, stdout: '{"ok":false,"error":{"code":"name_taken","message":"already exists"}}', stderr: "" } }).run, "ORCA_ERROR", "already exists"],
      [stubOrca({ "worktree create": { kind: "exited", exitCode: 1, stdout: "", stderr: "boom\n" } }).run, "ORCA_ERROR", "boom"],
      [stubOrca({ "worktree create": ok({ worktree: {} }) }).run, "ORCA_ERROR", "worktree のパス"],
    ];
    for (const [run, code, text] of cases) {
      const { db, me, ref } = unstarted();
      const before = getIssue(db, ref);
      const res = await createOrcaWorktree(me, ref, { feature: "search-n1" }, run);
      expect(res).toMatchObject({ issueId: "API-1", created: false, worktree: null, branch: null, failure: { code } });
      expect(res.failure?.message).toContain(text);
      expect(getIssue(db, ref)).toMatchObject({ worktree: null, branch: null, status: before.status, assignee: before.assignee, agentState: before.agentState });
    }
  });

  test("orca を待つ間に Issue がアーカイブされたら、例外にせず、作られた worktree のパスを含む失敗を返す", async () => {
    const { db, me, ref } = unstarted();
    const run: OrcaRunner = async () => {
      archiveIssue(me, ref);
      return created;
    };
    const res = await createOrcaWorktree(me, ref, { feature: "search-n1" }, run);
    expect(res).toMatchObject({ issueId: "API-1", created: false, worktree: null, branch: null, failure: { code: "WORKTREE_NOT_RECORDED" } });
    expect(res.failure?.message).toContain(NEW_WT);
    expect(res.failure?.message).toContain("アーカイブ済み");
    expect(getIssue(db, ref)).toMatchObject({ worktree: null, branch: null });
  });

  test("feature に英小文字・数字・- 以外があるか空なら INVALID_ARGS で、orca を呼ばない", async () => {
    const { me, ref } = unstarted();
    const { run, calls } = stubOrca({ "worktree create": created });
    for (const feature of ["", "Search", "a b", "a_b", "a+b", "検索", "a/b", "--x\n"]) {
      const code = await createOrcaWorktree(me, ref, { feature }, run).then(() => undefined, (e) => (e as { code?: string }).code);
      expect([feature, code]).toEqual([feature, "INVALID_ARGS"]);
    }
    expect(calls).toHaveLength(0);
  });

  test("アーカイブ済みと存在しない Issue は例外で、orca を呼ばない", async () => {
    const { me, ref } = unstarted();
    const { run, calls } = stubOrca({ "worktree create": created });
    expect(await createOrcaWorktree(me, "API-999", { feature: "x" }, run).then(() => undefined, (e) => e.code)).toBe("NOT_FOUND");
    archiveIssue(me, ref);
    expect(await createOrcaWorktree(me, ref, { feature: "x" }, run).then(() => undefined, (e) => e.code)).toBe("ISSUE_ARCHIVED");
    expect(calls).toHaveLength(0);
  });
});
