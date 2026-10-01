import { expect, test } from "bun:test";
import { openDb } from "@nod/core";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

// 提案と通知以外の表の中身（通知は #125 で me に届ける）。提案が Triage の状態を変えないことを確かめる
function snapshot(path: string) {
  const db = openDb(path);
  const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('triage_proposals', 'notifications') ORDER BY name").all() as { name: string }[];
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
  expect(text.stdout).toMatch(/Assignee: codex  \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n/);
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

test("LLM は triage propose --withdraw で自分の提案だけを取り下げられ、me には提案の通知が届く（#125）", async () => {
  const db = tempDb();
  const cwd = makeRepo();
  registerRepo(db, cwd);
  const issue = await runNod(["issue", "create", "判断待ち", "--json"], { cwd, db, actor: "codex" });
  await runNod(["triage", "propose", issue.json.id, "--accept", "--json"], { cwd, db, actor: "codex" });
  await runNod(["triage", "propose", issue.json.id, "--decline", "--json"], { cwd, db, actor: "claude-code" });
  const inbox = await runNod(["notification", "list"], { cwd, db });
  expect(inbox.stdout).toContain("codex が Triage を提案: 受け入れ");
  expect(inbox.stdout).toContain("claude-code が Triage を提案: 却下");

  const withdrawn = await runNod(["triage", "propose", issue.json.id, "--withdraw", "--json"], { cwd, db, actor: "codex" });
  expect(withdrawn.exitCode).toBe(0);
  expect(withdrawn.json).toEqual({ issueId: issue.json.id, actor: "codex", withdrawn: true });
  const text = await runNod(["triage", "propose", issue.json.id, "--withdraw"], { cwd, db, actor: "claude-code" });
  expect(text.stdout).toContain(`${issue.json.id} の claude-code の提案を取り下げました`);
  const again = await runNod(["triage", "propose", issue.json.id, "--withdraw", "--json"], { cwd, db, actor: "codex" });
  expect(again.json.error.code).toBe("NOT_FOUND");
  expect((await runNod(["triage", "proposals", issue.json.id, "--json"], { cwd, db })).json).toEqual([]);
  expect((await runNod(["notification", "list", "--json"], { cwd, db })).json).toEqual([]);

  for (const args of [["--withdraw", "--accept"], ["--withdraw", "--reason", "x"], ["--withdraw", "-l", "bug"]]) {
    const bad = await runNod(["triage", "propose", issue.json.id, ...args, "--json"], { cwd, db, actor: "codex" });
    expect(bad.json.error.code).toBe("INVALID_ARGS");
  }
});
