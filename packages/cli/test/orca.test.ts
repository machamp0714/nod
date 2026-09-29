import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { notifyOrca } from "../src/orca";
import { addWorktree, makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

// 受け取った引数を1行ずつログに書き、指定した JSON を返す偽の orca
function fakeOrca(response: string): { bin: string; log: string } {
  const dir = tempDir("nod-orca-");
  const bin = join(dir, "orca");
  const log = join(dir, "log.txt");
  writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do echo "$a" >> "${log}"; done\necho '${response}'\n`);
  chmodSync(bin, 0o755);
  return { bin, log };
}

describe("notifyOrca", () => {
  test("ステータスとコメントを orca worktree set に渡す", async () => {
    const { bin, log } = fakeOrca('{"ok":true}');
    expect(await notifyOrca({ status: "in-progress", comment: "作業中: API-1 検索" }, { ORCA_CLI_COMMAND: bin })).toBe(true);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "worktree",
      "set",
      "--worktree",
      "active",
      "--workspace-status",
      "in-progress",
      "--comment",
      "作業中: API-1 検索",
      "--json",
    ]);
  });

  test("ok: false、orca がない、NOD_ORCA=0 のときは false を返し、例外を投げない", async () => {
    const failing = fakeOrca('{"ok":false,"error":{"code":"selector_not_found"}}');
    expect(await notifyOrca({ comment: "x" }, { ORCA_CLI_COMMAND: failing.bin })).toBe(false);
    expect(await notifyOrca({ comment: "x" }, { ORCA_CLI_COMMAND: "/nonexistent/orca" })).toBe(false);
    const off = fakeOrca('{"ok":true}');
    expect(await notifyOrca({ comment: "x" }, { ORCA_CLI_COMMAND: off.bin, NOD_ORCA: "0" })).toBe(false);
    expect(existsSync(off.log)).toBe(false);
  });

  test("長いコメントは 80 文字で切る", async () => {
    const { bin, log } = fakeOrca('{"ok":true}');
    await notifyOrca({ comment: "あ".repeat(100) }, { ORCA_CLI_COMMAND: bin });
    const comment = readFileSync(log, "utf8").split("\n")[5] ?? "";
    expect([...comment]).toHaveLength(80);
    expect(comment.endsWith("…")).toBe(true);
  });
});

describe("nod issue と Orca", () => {
  test("worktree で着手すると、ブランチとパスを Issue に記録する", async () => {
    const db = tempDb();
    const repo = makeRepo();
    registerRepo(db, repo);
    const wt = addWorktree(repo, "feat-search");
    const created = (await runNod(["issue", "create", "t", "--json"], { cwd: repo, db })).json;
    await runNod(["issue", "start", created.id], { cwd: wt, db, actor: "claude-code" });
    const shown = (await runNod(["issue", "show", created.id, "--json"], { cwd: repo, db })).json;
    expect(shown).toMatchObject({ branch: "feat-search", worktree: wt });
  });

  test("suggest は LLM でも Orca に通知しない", async () => {
    const db = tempDb();
    const repo = makeRepo();
    registerRepo(db, repo);
    const created = (await runNod(["issue", "create", "候補", "--json"], { cwd: repo, db })).json;
    const { bin, log } = fakeOrca('{"ok":true}');
    const result = await runNod(["issue", "suggest", "--json"], {
      cwd: repo, db, actor: "claude-code",
      env: { ORCA_CLI_COMMAND: bin, NOD_ORCA: "1" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.json.id).toBe(created.id);
    expect(existsSync(log)).toBe(false);
  });

  test("diagnose は LLM でも Orca に通知しない", async () => {
    const db = tempDb(), repo = makeRepo();
    registerRepo(db, repo);
    const { bin, log } = fakeOrca('{"ok":true}');
    const result = await runNod(["issue", "diagnose", "--stale-days", "7", "--json"], {
      cwd: repo, db, actor: "claude-code", env: { ORCA_CLI_COMMAND: bin, NOD_ORCA: "1" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.json.findings).toEqual([]);
    expect(existsSync(log)).toBe(false);
  });

  test("start、ask、done でカードを更新する", async () => {
    const db = tempDb();
    const repo = makeRepo();
    registerRepo(db, repo);
    const { bin, log } = fakeOrca('{"ok":true}');
    const env = { ORCA_CLI_COMMAND: bin, NOD_ORCA: "1" };
    const llm = (args: string[]) => runNod([...args, "--json"], { cwd: repo, db, actor: "claude-code", env });

    const created = (await runNod(["issue", "create", "検索を直す", "--json"], { cwd: repo, db })).json;
    await llm(["issue", "start", created.id]);
    await llm(["issue", "ask", created.id, "複合インデックスでよいか"]);
    await llm(["issue", "done", created.id, "--summary", "直した"]);

    const lines = readFileSync(log, "utf8").split("\n");
    expect(lines).toContain(`作業中: ${created.id} 検索を直す`);
    expect(lines).toContain("入力待ち: 複合インデックスでよいか");
    expect(lines).toContain(`レビュー待ち: ${created.id} 検索を直す`);
    expect(lines.filter((l) => l === "--workspace-status")).toHaveLength(2);
  });

  test("orca が失敗しても nod は成功する", async () => {
    const db = tempDb();
    const repo = makeRepo();
    registerRepo(db, repo);
    const created = (await runNod(["issue", "create", "t", "--json"], { cwd: repo, db })).json;
    const r = await runNod(["issue", "start", created.id, "--json"], {
      cwd: repo,
      db,
      actor: "claude-code",
      env: { ORCA_CLI_COMMAND: "/nonexistent/orca", NOD_ORCA: "1" },
    });
    expect(r.exitCode).toBe(0);
    expect(r.json.agentState).toBe("working");
  });
});

// 裁定: カードの更新は LLM の操作だけ。作業場所の記録は誰でも行う
describe("Orca の更新は LLM だけ", () => {
  test("人が着手したときはカードを更新しないが、作業場所は記録する", async () => {
    const db = tempDb();
    const repo = makeRepo();
    registerRepo(db, repo);
    const wt = addWorktree(repo, "feat-human");
    const { bin, log } = fakeOrca('{"ok":true}');
    const env = { ORCA_CLI_COMMAND: bin, NOD_ORCA: "1" };
    const created = (await runNod(["issue", "create", "t", "--json"], { cwd: repo, db })).json;
    const r = await runNod(["issue", "start", created.id, "--json"], { cwd: wt, db, env });
    expect(r.exitCode).toBe(0);
    expect(existsSync(log)).toBe(false);
    const shown = (await runNod(["issue", "show", created.id, "--json"], { cwd: repo, db })).json;
    expect(shown).toMatchObject({ branch: "feat-human", worktree: wt });
  });

  test("LLM の next と fail でもカードを更新する", async () => {
    const db = tempDb();
    const repo = makeRepo();
    registerRepo(db, repo);
    const { bin, log } = fakeOrca('{"ok":true}');
    const env = { ORCA_CLI_COMMAND: bin, NOD_ORCA: "1" };
    const created = (await runNod(["issue", "create", "索引を張る", "--json"], { cwd: repo, db })).json;
    const picked = await runNod(["issue", "next", "--json"], { cwd: repo, db, actor: "claude-code", env });
    expect(picked.json.id).toBe(created.id);
    await runNod(["issue", "fail", created.id, "DB に接続できない", "--json"], { cwd: repo, db, actor: "claude-code", env });
    const lines = readFileSync(log, "utf8").split("\n");
    expect(lines).toContain(`作業中: ${created.id} 索引を張る`);
    expect(lines).toContain("エラー: DB に接続できない");
  });
});

describe("ORCA_CLI_COMMAND", () => {
  test("空白を含むパスでもそのまま実行する", async () => {
    const dir = join(tempDir("nod-orca-"), "with space");
    mkdirSync(dir);
    const bin = join(dir, "orca");
    const log = join(dir, "log.txt");
    writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do echo "$a" >> "${log}"; done\necho '{"ok":true}'\n`);
    chmodSync(bin, 0o755);
    expect(await notifyOrca({ comment: "x" }, { ORCA_CLI_COMMAND: bin })).toBe(true);
    expect(readFileSync(log, "utf8").split("\n")[0]).toBe("worktree");
  });
});

describe("orca が応答しないとき", () => {
  test("子プロセスが出力を握ったままでも、3 秒ほどで諦めて nod は成功する", async () => {
    const db = tempDb();
    const repo = makeRepo();
    registerRepo(db, repo);
    const dir = tempDir("nod-orca-");
    const bin = join(dir, "orca");
    writeFileSync(bin, `#!/bin/sh\nsleep 20\necho '{"ok":true}'\n`);
    chmodSync(bin, 0o755);
    const created = (await runNod(["issue", "create", "t", "--json"], { cwd: repo, db })).json;
    const started = Date.now();
    const r = await runNod(["issue", "start", created.id, "--json"], {
      cwd: repo,
      db,
      actor: "claude-code",
      env: { ORCA_CLI_COMMAND: bin, NOD_ORCA: "1" },
    });
    expect(r.exitCode).toBe(0);
    expect(r.json.agentState).toBe("working");
    expect(Date.now() - started).toBeLessThan(8000);
  });
});
