import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tempDb } from "./helpers";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

function cli(db: string, cwd: string, args: string[], actor = "codex") {
  const proc = Bun.spawnSync(["bun", join(import.meta.dir, "../src/main.ts"), ...args], {
    cwd, env: { ...process.env, NOD_DB: db, NOD_ORCA: "0", NOD_ACTOR: actor }, stdout: "pipe", stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  return { code: proc.exitCode, stdout, stderr: proc.stderr.toString(), json: args.includes("--json") ? JSON.parse(stdout) : undefined };
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "nod-cycle-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  return dir;
}

describe("Cycle CLI", () => {
  test("LLM も Cycle を作り、Issue を入れ、未完了を次の Cycle へ移せるが、削除は人だけ", () => {
    const db = tempDb();
    const cwd = repo();
    expect(cli(db, cwd, ["init", "--key", "CYC"], "me").code).toBe(0);
    expect(cli(db, cwd, ["cycle", "create", "S1", "--start", "2000-01-01", "--end", "2000-01-14", "--json"]).json).toMatchObject({
      name: "S1",
      state: "completed",
      createdBy: "codex",
    });
    cli(db, cwd, ["cycle", "create", "S2", "--start", "2999-01-01", "--end", "2999-01-14"]);
    const created = cli(db, cwd, ["issue", "create", "作業", "--cycle", "S1", "--json"], "me").json;
    expect(created.cycle.name).toBe("S1");
    expect(cli(db, cwd, ["issue", "show", created.id]).stdout).toContain("Cycle: S1");
    expect(cli(db, cwd, ["issue", "list", "--cycle", "S1", "--json"]).json.map((i: { id: string }) => i.id)).toEqual([created.id]);
    const outside = cli(db, cwd, ["issue", "create", "Cycle の外", "--json"], "me").json;
    expect(cli(db, cwd, ["issue", "list", "--cycle", "none", "--json"]).json.map((i: { id: string }) => i.id)).toEqual([outside.id]);
    expect(cli(db, cwd, ["cycle", "list"]).stdout).toContain("S1（終了）  2000-01-01〜2000-01-14  0/1  持ち越し候補 1");
    expect(cli(db, cwd, ["cycle", "show", "S1"]).stdout).toContain("nod cycle move-open");

    const moved = cli(db, cwd, ["cycle", "move-open", "S1", "--to", "S2", "--json"]);
    expect(moved.json).toMatchObject({ moved: [created.id], to: { name: "S2", open: 1 } });
    expect(cli(db, cwd, ["issue", "update", created.id, "--cycle", "", "--json"]).json.cycle).toBeNull();
    expect(cli(db, cwd, ["summary", "--cycle", "S2", "--json"]).code).toBe(0);
    expect(cli(db, cwd, ["stats", "--cycle", "S2", "--json"]).code).toBe(0);
    expect(cli(db, cwd, ["cycle", "update", "S2", "--name", "次", "--json"]).json.name).toBe("次");
    // 削除は人だけ（LLM は FORBIDDEN_FOR_LLM）
    const forbidden = cli(db, cwd, ["cycle", "delete", "次", "--json"]);
    expect([forbidden.code, forbidden.json.error.code]).toEqual([1, "FORBIDDEN_FOR_LLM"]);
    expect(cli(db, cwd, ["cycle", "delete", "次", "--json"], "me").json).toMatchObject({ name: "次" });
  });

  test("重なり・不正値・不存在はエラーになる", () => {
    const db = tempDb();
    const cwd = repo();
    cli(db, cwd, ["init", "--key", "CYC"], "me");
    cli(db, cwd, ["cycle", "create", "S1", "--start", "2000-01-01", "--end", "2000-01-14"]);
    for (const [args, code] of [
      [["cycle", "create", "S2", "--start", "2000-01-14", "--end", "2000-01-20"], "CYCLE_OVERLAP"],
      [["cycle", "create", "current", "--start", "2001-01-01", "--end", "2001-01-02"], "INVALID_ARGS"],
      [["cycle", "create", "none", "--start", "2001-01-01", "--end", "2001-01-02"], "INVALID_ARGS"],
      [["cycle", "update", "S1"], "INVALID_ARGS"],
      [["cycle", "show", "ない"], "NOT_FOUND"],
      [["cycle", "list", "--tz", "+09:00"], "INVALID_ARGS"],
    ] as const) {
      const result = cli(db, cwd, [...args, "--json"]);
      expect([args.join(" "), result.code, result.json.error.code]).toEqual([args.join(" "), 1, code]);
    }
  });
});
