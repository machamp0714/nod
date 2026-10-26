import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

test("旧Cycleコマンドと直接所属オプションはDBを作成せず廃止案内を返す", async () => {
  const cwd = makeRepo();
  const db = tempDb();
  for (const args of [
    ["cycle"], ["cycle", "list"], ["cycle", "create"], ["cycle", "cadence", "set", "--weeks", "2"],
    ["cycle", "未知", "--不明"], ["issue", "create", "作業", "--cycle", "current"],
    ["issue", "create", "--cycle"], ["issue", "update", "--cycle=none"],
    ["issue", "list", "--cycle=none"], ["issue", "list", "--cycle"],
    ["issue", "update", "API-1", "--title", "変更", "--cycle", ""],
    ["issue", "bulk-update", "API-1", "--cycle", "1"],
    ["triage", "accept", "API-1", "--cycle", "1"], ["stats", "llm", "--cycle", "none"],
    ["summary", "--cycle", "current"],
  ]) {
    const res = await runNod([...args, "--json"], { cwd, db });
    expect([args, res.json?.error?.code]).toEqual([args, "CYCLE_RETIRED"]);
    expect(res.json.error.message).toContain("Sprint");
    expect(existsSync(db)).toBe(false);
  }
});

test("通常文字列と区切り後のCycle表記を許し、廃止入力で既存DBを変えない", async () => {
  const cwd = makeRepo();
  const db = tempDb();
  registerRepo(db, cwd, "LIT");
  for (const title of ["cycle", "--cycle"]) {
    const res = await runNod(["issue", "create", "--requested", "--json", "--", title], {cwd, db, actor:"me"});
    expect(res.exitCode).toBe(0);
    expect(res.json.title).toBe(title);
  }
  const value = await runNod(["issue", "create", "値", "--description", "--cycle", "--requested", "--json"], {cwd, db, actor:"me"});
  expect(value.exitCode).toBe(0);
  expect(value.json.description).toBe("--cycle");
  const before = readFileSync(db);
  expect((await runNod(["issue", "update", value.json.id, "--title", "変更", "--cycle=none", "--json"], {cwd,db})).json.error.code).toBe("CYCLE_RETIRED");
  expect(readFileSync(db)).toEqual(before);
});
