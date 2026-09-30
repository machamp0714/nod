import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tempDb, tempDir } from "./helpers";

function cli(db: string, cwd: string, args: string[], actor = "codex") {
  const proc = Bun.spawnSync(["bun", join(import.meta.dir, "../src/main.ts"), ...args], {
    cwd, env: { ...process.env, NOD_DB: db, NOD_ORCA: "0", NOD_ACTOR: actor }, stdout: "pipe", stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  return { code: proc.exitCode, stdout, stderr: proc.stderr.toString(), json: args.includes("--json") ? JSON.parse(stdout) : undefined };
}

describe("Initiative CLI", () => {
  test("LLM も作成・紐付け・状態変更ができ、show に配下 Project の進捗を出す", () => {
    const db = tempDb();
    const cwd = tempDir();
    const created = cli(db, cwd, ["initiative", "create", "検索の刷新", "-d", "年内", "--target", "2026-12-31", "--json"]);
    expect(created.code).toBe(0);
    expect(created.json).toMatchObject({ name: "検索の刷新", targetDate: "2026-12-31", createdBy: "codex" });
    cli(db, cwd, ["project", "create", "A"]);
    cli(db, cwd, ["project", "create", "B"]);
    expect(cli(db, cwd, ["initiative", "add-project", "検索の刷新", "A"]).code).toBe(0);
    expect(cli(db, cwd, ["initiative", "add-project", String(created.json.id), "B", "--json"]).json.projectCount).toBe(2);
    const shown = cli(db, cwd, ["initiative", "show", "検索の刷新"]);
    expect(shown.stdout).toContain("検索の刷新（planned）  0/0  Project 2  目標日 2026-12-31");
    expect(shown.stdout).toContain("A（planned）  0/0");
    expect(cli(db, cwd, ["project", "show", "A"]).stdout).toContain("Initiative: 検索の刷新");
    expect(cli(db, cwd, ["initiative", "update", "検索の刷新", "--status", "completed", "--target", "", "--json"]).json).toMatchObject({
      status: "completed",
      targetDate: null,
    });
    expect(cli(db, cwd, ["initiative", "list", "--json"]).json).toEqual([]);
    expect(cli(db, cwd, ["initiative", "list", "--all"]).stdout).toContain("検索の刷新（completed）");
    expect(cli(db, cwd, ["initiative", "remove-project", "検索の刷新", "A", "--json"]).json.projectCount).toBe(1);
  });

  test("不正値・欠落・不存在はエラーになる", () => {
    const db = tempDb();
    const cwd = tempDir();
    cli(db, cwd, ["initiative", "create", "保持"]);
    for (const [args, code] of [
      [["initiative", "create", "保持"], "INITIATIVE_EXISTS"],
      [["initiative", "create", "42"], "INVALID_ARGS"],
      [["initiative", "update", "保持"], "INVALID_ARGS"],
      [["initiative", "update", "保持", "--status", "done"], "INVALID_ARGS"],
      [["initiative", "add-project", "保持", "ない"], "NOT_FOUND"],
      [["initiative", "show", "ない"], "NOT_FOUND"],
    ] as const) {
      const result = cli(db, cwd, [...args, "--json"]);
      expect([result.code, result.json.error.code]).toEqual([1, code]);
    }
  });
});
