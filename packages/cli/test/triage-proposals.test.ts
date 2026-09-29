import { expect, test } from "bun:test";
import { openDb } from "@nod/core";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

// 提案以外の表の中身。提案が Triage の状態を変えないことを確かめる
function snapshot(path: string) {
  const db = openDb(path);
  const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'triage_proposals' ORDER BY name").all() as { name: string }[];
  const rows = tables.map(({ name }) => db.query(`SELECT * FROM "${name}" ORDER BY rowid`).all());
  db.close();
  return rows;
}

test("LLM は triage propose で提案だけを記録でき、Triage の状態は変わらない。確定は人だけが行える", async () => {
  const db = tempDb();
  const cwd = makeRepo();
  registerRepo(db, cwd);
  const original = await runNod(["issue", "create", "元の Issue", "--json"], { cwd, db });
  const issue = await runNod(["issue", "create", "判断待ち", "--json"], { cwd, db, actor: "codex" });
  const before = snapshot(db);
  const accept = await runNod(
    ["triage", "propose", issue.json.id, "--accept", "-l", "bug", "-l", "perf", "--assignee", "codex", "-p", "2", "--reason", "再現できた", "--json"],
    { cwd, db, actor: "codex" },
  );
  expect(accept.exitCode).toBe(0);
  expect(accept.json).toMatchObject({ actor: "codex", decision: "accept", labels: ["bug", "perf"], assignee: "codex", priority: 2, reason: "再現できた" });
  const dup = await runNod(["triage", "propose", issue.json.id, "--duplicate-of", original.json.id, "--json"], { cwd, db, actor: "claude-code" });
  expect(dup.json).toMatchObject({ decision: "duplicate", duplicateOf: original.json.id });
  expect(snapshot(db)).toEqual(before);

  const text = await runNod(["triage", "proposals", issue.json.id], { cwd, db, actor: "codex" });
  expect(text.stdout).toContain("確定は人が行います");
  expect(text.stdout).toContain("理由: 再現できた");
  expect(text.stdout).toContain(`元: ${original.json.id}`);

  for (const args of [[], ["--accept", "--decline"], ["--decline", "-l", "bug"]]) {
    const bad = await runNod(["triage", "propose", issue.json.id, ...args, "--json"], { cwd, db, actor: "codex" });
    expect(bad.exitCode).toBe(1);
    expect(bad.json.error.code).toBe("INVALID_ARGS");
  }
  for (const args of [["accept", issue.json.id], ["decline", issue.json.id], ["duplicate", issue.json.id, original.json.id]]) {
    const forbidden = await runNod(["triage", ...args, "--json"], { cwd, db, actor: "codex" });
    expect(forbidden.json.error.code).toBe("FORBIDDEN_FOR_LLM");
  }
  expect(snapshot(db)).toEqual(before);

  const accepted = await runNod(["triage", "accept", issue.json.id, "--json"], { cwd, db });
  expect(accepted.json.status).toBe("todo");
  const late = await runNod(["triage", "propose", issue.json.id, "--decline", "--json"], { cwd, db, actor: "codex" });
  expect(late.json.error.code).toBe("NOT_IN_TRIAGE");
  const kept = await runNod(["triage", "proposals", issue.json.id, "--json"], { cwd, db });
  expect(kept.json.map((p: { actor: string }) => p.actor).sort()).toEqual(["claude-code", "codex"]);
});
