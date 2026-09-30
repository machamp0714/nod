import { describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIssue } from "../src/ops/issues";
import { startIssue } from "../src/ops/agent";
import { cdCommand, defaultOrcaRunner, openInOrca, orcaCommand, type OrcaRunner } from "../src/ops/orca";
import type { GhRunResult } from "../src/ops/pr-status";
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

  test("cd コマンドは単一引用符を含むパスもそのまま貼れる形にする", () => {
    expect(cdCommand("/tmp/it's")).toBe(`cd '/tmp/it'\\''s'`);
  });
});
