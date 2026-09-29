import { expect, test } from "bun:test";
import { openDb } from "@nod/core";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

test("diagnoseは空結果・停滞候補とJSONを返し、診断でDBを変更しない", async () => {
  const db = tempDb(), cwd = makeRepo();
  registerRepo(db, cwd);
  const opts = { cwd, db, actor: "codex" };
  const args = ["issue", "diagnose", "--stale-days", "7"];
  const empty = await runNod([...args, "--json"], opts);
  expect(empty.exitCode).toBe(0);
  expect(empty.json).toMatchObject({ staleDays: 7, findings: [] });
  const emptyText = await runNod(args, opts);
  expect(emptyText.exitCode).toBe(0);
  expect(emptyText.stdout).toContain("候補はありません");
  const created = await runNod(["issue", "create", "停滞候補", "--json"], { cwd, db });
  const connection = openDb(db);
  connection.exec("UPDATE issues SET status='in_progress', created_at='2020-01-01T00:00:00Z', updated_at='2020-01-01T00:00:00Z'; UPDATE events SET created_at='2020-01-01T00:00:00Z'");
  const before = connection.serialize();
  const result = await runNod([...args, "--json"], opts);
  expect(result.exitCode).toBe(0);
  expect(result.json.findings).toHaveLength(1);
  expect(result.json.findings[0]).toMatchObject({ issue: { id: created.json.id }, reasons: [{ type: "stale" }] });
  const human = await runNod(args, opts);
  expect(human.stdout).toContain(created.json.id);
  expect(human.stdout).toContain("活動記録");
  expect(connection.serialize()).toEqual(before);
  connection.close();
  const invalid = await runNod([...args, "--project", "不存在", "--json"], opts);
  expect(invalid.json.error.code).toBe("NOT_FOUND");
});

test("diagnoseは閾値の未指定・不正値とWorkspace未登録を拒否する", async () => {
  const opts = { cwd: makeRepo(), db: tempDb() };
  registerRepo(opts.db, opts.cwd);
  for (const value of [undefined, "0", "-1", "1.5", "abc", "1e3", "999999999999999999"]) {
    const result = await runNod(["issue", "diagnose", ...(value ? ["--stale-days", value] : []), "--json"], opts);
    expect(result.exitCode).toBe(1);
    expect(result.json.error.code).toBe("INVALID_ARGS");
  }
  const missing = await runNod(["issue", "diagnose", "--stale-days", "1", "-w", "MISSING", "--json"], opts);
  expect(missing.json.error.code).toBe("NOT_INITIALIZED");
});
