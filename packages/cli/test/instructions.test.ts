import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

// 実 CLI と一時 DB、偽 Orca で追加指示の記録・送信・受け取りを確かめる。
describe("nod issue instruct / instructions", () => {
  test.each(["me", "codex"])("%s の start で受け取って確認済みになる。show では確認済みにしない", async (actor) => {
    const db = tempDb();
    const repo = makeRepo();
    registerRepo(db, repo);
    const created = (await runNod(["issue", "create", "--requested", "検索", "--json"], { cwd: repo, db })).json;
    await runNod(["issue", "start", created.id], { cwd: repo, db, actor: "claude-code" });

    const recorded = await runNod(["issue", "instruct", created.id, "テストも追加して", "--json"], { cwd: repo, db });
    expect(recorded.exitCode).toBe(0);
    expect(recorded.json).toMatchObject({ kind: "instruction", body: "テストも追加して", createdBy: "me", sendState: "unsent" });

    const shown = await runNod(["issue", "show", created.id], { cwd: repo, db, actor });
    expect(shown.stdout).toContain("未確認の追加指示:");
    expect(shown.stdout).toContain("[追加指示・未送信]");
    expect(shown.stdout).toContain("[追加指示・未確認]: テストも追加して");

    const started = await runNod(["issue", "start", created.id, "--json"], { cwd: repo, db, actor });
    expect(started.json.pendingInstructions).toMatchObject([{ id: recorded.json.id, body: "テストも追加して" }]);
    const again = await runNod(["issue", "start", created.id, "--json"], { cwd: repo, db, actor });
    expect(again.json.pendingInstructions).toEqual([]);

    const list = await runNod(["issue", "instructions", created.id], { cwd: repo, db, actor: "claude-code" });
    expect(list.stdout).toContain(`${actor} が確認済み`);
  });

  test("どの LLM の show でも指示は未確認のままで、開始した LLM に渡す", async () => {
    const db = tempDb();
    const repo = makeRepo();
    registerRepo(db, repo);
    const created = (await runNod(["issue", "create", "--requested", "検索", "--json"], { cwd: repo, db })).json;
    await runNod(["issue", "start", created.id], { cwd: repo, db, actor: "claude-code" });
    await runNod(["issue", "instruct", created.id, "テストも追加して"], { cwd: repo, db });

    const other = await runNod(["issue", "show", created.id, "--json"], { cwd: repo, db, actor: "codex" });
    expect(other.json.pendingInstructions).toHaveLength(1);
    const shown = await runNod(["issue", "show", created.id], { cwd: repo, db, actor: "claude-code" });
    // 読んだときの表示は「未確認」のまま
    expect(shown.stdout).toContain("未確認の追加指示:");
    expect(shown.stdout).toContain("テストも追加して");

    const restarted = await runNod(["issue", "start", created.id, "--json"], { cwd: repo, db, actor: "codex" });
    expect(restarted.json.pendingInstructions).toMatchObject([{ body: "テストも追加して" }]);
    const list = await runNod(["issue", "instructions", created.id], { cwd: repo, db });
    expect(list.stdout).toContain("codex が確認済み");
  });

  test("start のテキスト出力に追加指示を出す", async () => {
    const db = tempDb();
    const repo = makeRepo();
    registerRepo(db, repo);
    const created = (await runNod(["issue", "create", "--requested", "検索", "--json"], { cwd: repo, db })).json;
    await runNod(["issue", "instruct", created.id, "1行目\n2行目"], { cwd: repo, db });
    const started = await runNod(["issue", "start", created.id], { cwd: repo, db, actor: "claude-code" });
    expect(started.stdout).toContain("追加指示（先に読んで対応する）:");
    expect(started.stdout).toContain("    1行目\n    2行目");
  });

  test("LLM が追加指示を記録でき、記録者と本文が残る", async () => {
    const db = tempDb();
    const repo = makeRepo();
    registerRepo(db, repo);
    const created = (await runNod(["issue", "create", "--requested", "検索", "--json"], { cwd: repo, db })).json;
    const res = await runNod(["issue", "instruct", created.id, "テストも追加して", "--json"], { cwd: repo, db, actor: "codex" });
    expect(res.exitCode).toBe(0);
    expect(res.json).toMatchObject({ body: "テストも追加して", createdBy: "codex", sendState: "unsent", acknowledgedAt: null });
    const shown = await runNod(["issue", "show", created.id, "--json"], { cwd: repo, db });
    expect(shown.json.pendingInstructions).toMatchObject([{ id: res.json.id, body: "テストも追加して", createdBy: "codex" }]);
  });

  test("LLM が選んだ端末へ定型文を送り、重複送信・宛先違い・結果不明の再試行を既存規則で扱う", async () => {
    const db = tempDb();
    const repo = makeRepo();
    registerRepo(db, repo);
    const opts = { cwd: repo, db, actor: "codex" };
    const created = (await runNod(["issue", "create", "--requested", "検索", "--json"], opts)).json;
    await runNod(["issue", "start", created.id], opts);
    const dir = tempDir();
    const fake = join(dir, "orca.ts");
    const log = join(dir, "calls.jsonl");
    writeFileSync(fake, `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "terminal" && args[1] === "list") {
  console.log(JSON.stringify({ ok: true, result: { terminals: [
    { handle: "term_agent", worktreePath: ${JSON.stringify(repo)}, connected: true, writable: true, agentIdentity: "codex" },
    { handle: "term_shell", worktreePath: ${JSON.stringify(repo)}, connected: true, writable: true, agentIdentity: null },
    { handle: "term_other_worktree", worktreePath: ${JSON.stringify(join(tempDir(), "other-worktree"))}, connected: true, writable: true, agentIdentity: "codex" }
  ] } }));
} else if (args[0] === "terminal" && args[1] === "send") {
  if (process.env.NOD_TEST_SEND_UNKNOWN === "1" && !args.includes("--retry-request")) {
    console.log(JSON.stringify({ ok: false, error: { code: "unknown", message: "結果不明" }, requestId: "req_saved" }));
    process.exitCode = 1;
  } else console.log(JSON.stringify({ ok: true, result: { accepted: true, requestId: "req_saved" } }));
} else process.exitCode = 2;
`);
    const env = { NOD_ORCA: "1", ORCA_CLI_COMMAND: `bun ${fake}` };
    const recorded = (await runNod(["issue", "instruct", created.id, "本文は端末へ送らない", "--json"], opts)).json;
    const sendArgs = ["issue", "send-instruction", created.id, String(recorded.id), "--terminal", "term_agent", "--json"];
    const sent = await runNod(sendArgs, { ...opts, env });
    expect(sent.exitCode).toBe(0);
    expect(sent.json).toMatchObject({ sendState: "sent", sentBy: "codex", sentTerminal: "term_agent", acknowledgedAt: null });
    const calls = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(calls()).toEqual([
      ["terminal", "list", "--worktree", `path:${repo}`, "--json"],
      ["terminal", "send", "--terminal", "term_agent", "--text",
        `nod: ${created.id} に追加指示があります（#${recorded.id}）。nod issue show ${created.id} で読んでください`, "--enter", "--json"],
    ]);
    const duplicate = await runNod(sendArgs, { ...opts, env });
    expect(duplicate.json.error.code).toBe("INSTRUCTION_ALREADY_SENT");
    expect(calls()).toHaveLength(2);

    const second = (await runNod(["issue", "instruct", created.id, "次の指示", "--json"], opts)).json;
    const secondArgs = ["issue", "send-instruction", created.id, String(second.id), "--terminal", "term_shell", "--json"];
    const wrongTarget = await runNod(secondArgs, { ...opts, env });
    expect(wrongTarget.json).toMatchObject({ sendState: "failed", sendError: { code: "TERMINAL_NOT_FOUND" } });
    expect(calls().filter((args) => args[1] === "send")).toHaveLength(1);
    secondArgs[5] = "term_other_worktree";
    const otherWorktree = await runNod(secondArgs, { ...opts, env });
    expect(otherWorktree.json).toMatchObject({ sendState: "failed", sendError: { code: "TERMINAL_NOT_FOUND" } });
    expect(calls().filter((args) => args[1] === "send")).toHaveLength(1);
    secondArgs[5] = "term_agent";
    const unknown = await runNod(secondArgs, { ...opts, env: { ...env, NOD_TEST_SEND_UNKNOWN: "1" } });
    expect(unknown.json).toMatchObject({ sendState: "unconfirmed" });
    const retry = await runNod(secondArgs, { ...opts, env });
    expect(retry.json).toMatchObject({ sendState: "sent", sentBy: "codex" });
    expect(calls().at(-1)).toEqual([
      "terminal", "send", "--terminal", "term_agent", "--text",
      `nod: ${created.id} に追加指示があります（#${second.id}）。nod issue show ${created.id} で読んでください`,
      "--enter", "--json", "--retry-request", "req_saved",
    ]);
    const listed = await runNod(["issue", "instructions", created.id, "--json"], opts);
    expect(listed.json).toMatchObject([{ id: recorded.id, sentBy: "codex" }, { id: second.id, sentBy: "codex" }]);
  });
});

