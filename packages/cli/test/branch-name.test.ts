import { expect, test } from "bun:test";
import { openDb } from "@nod/core";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

test("人とLLMがコピー可能な名前とJSONを取得でき、DB・git refs・Orcaを変更しない", async () => {
  const db = tempDb();
  const cwd = makeRepo();
  registerRepo(db, cwd, "API");
  const other = makeRepo("other");
  registerRepo(db, other, "OTHER");
  const created = (await runNod(["issue", "create", "日本語🚀 / .. @{ [ ~ ^ : ? *", "--json"], { cwd, db })).json;
  const elsewhere = (await runNod(["issue", "create", "別Workspace", "--json"], { cwd: other, db })).json;
  await runNod(["issue", "start", created.id], { cwd, db });
  const dir = tempDir();
  const bin = join(dir, "orca");
  const log = join(dir, "called");
  writeFileSync(bin, `#!/bin/sh\ntouch '${log}'\n`);
  chmodSync(bin, 0o755);
  const connection = openDb(db);
  const before = connection.serialize();
  const refs = () => Bun.spawnSync(["git", "show-ref"], { cwd }).stdout.toString();
  const beforeRefs = refs();
  for (const actor of ["me", "codex"]) {
    const opts = { cwd, db, actor, env: { NOD_ORCA: "1", ORCA_CLI_COMMAND: bin } };
    const human = await runNod(["issue", "branch-name", created.id.toLowerCase()], opts);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toBe("nod/api-1\n");
    const json = await runNod(["issue", "branch-name", created.id, "--json"], opts);
    expect(json.exitCode).toBe(0);
    expect(json.json).toEqual({ issueId: "API-1", suggestedBranch: "nod/api-1" });
    const cross = await runNod(["issue", "branch-name", elsewhere.id, "--json"], opts);
    expect(cross.json.suggestedBranch).toBe("nod/other-1");
  }
  expect(connection.serialize()).toEqual(before);
  connection.close();
  expect(refs()).toBe(beforeRefs);
  expect(existsSync(log)).toBe(false);
  for (const [id, code] of [["bad", "INVALID_ARGS"], ["API-99999", "NOT_FOUND"]]) {
    const result = await runNod(["issue", "branch-name", id!, "--json"], { cwd, db });
    expect(result.exitCode).toBe(1);
    expect(result.json.error.code).toBe(code);
  }
  const help = await runNod(["issue", "branch-name", "--help"], { cwd, db });
  expect(help.stdout).toContain("ブランチ作成・着手・記録変更はしない");
});
