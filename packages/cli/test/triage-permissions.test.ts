import { expect, test } from "bun:test";
import { join } from "node:path";
import { makeRepo, registerRepo, tempDb } from "./helpers";

for (const actor of ["codex", "claude-code", "other-agent"]) {
  test(`${actor} も Triage の判断を CLI で行え、書き手に残る`, () => {
    const db = tempDb();
    const repo = makeRepo();
    registerRepo(db, repo, "API");
    const run = (who: string, args: string[]) => {
      const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/main.ts"), ...args, "--json"], {
        cwd: repo, env: { ...process.env, NOD_DB: db, NOD_ORCA: "0", NOD_ACTOR: who }, stdout: "pipe", stderr: "pipe",
      });
      return { code: result.exitCode, json: JSON.parse(result.stdout.toString()) };
    };
    const original = run("me", ["issue", "create", "元の Issue"]).json;
    for (const op of ["accept", "decline", "duplicate"]) {
      const issue = run(actor, ["issue", "create", "判断待ち"]).json;
      const result = run(actor, ["triage", op, issue.id, ...(op === "duplicate" ? [original.id] : [])]);
      expect(result.code).toBe(0);
      expect(result.json.status).toBe(op === "accept" ? "todo" : "canceled");
      const shown = run("me", ["issue", "show", issue.id]).json;
      const type = op === "accept" ? "triage_accepted" : "triage_declined";
      expect(shown.activity.find((a: { type?: string }) => a.type === type)?.actor).toBe(actor);
    }
  });
}

test("LLM も nod issue update --status で Triage から出せる。bulk-update では人と同じく TRIAGE_DECISION_REQUIRED", () => {
  const db = tempDb();
  const repo = makeRepo();
  registerRepo(db, repo, "API");
  const run = (who: string, args: string[]) => {
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/main.ts"), ...args, "--json"], {
      cwd: repo, env: { ...process.env, NOD_DB: db, NOD_ORCA: "0", NOD_ACTOR: who }, stdout: "pipe", stderr: "pipe",
    });
    return { code: result.exitCode, json: JSON.parse(result.stdout.toString()) };
  };
  const bulkTarget = run("claude-code", ["issue", "create", "一括"]).json;
  const before = run("me", ["issue", "show", bulkTarget.id]).json;
  const bulk = run("claude-code", ["issue", "bulk-update", bulkTarget.id, "-s", "todo"]);
  expect(bulk.code).toBe(1);
  expect(bulk.json.error.details.failures).toEqual([{ id: bulkTarget.id, code: "TRIAGE_DECISION_REQUIRED", message: expect.any(String) }]);
  expect(run("me", ["issue", "show", bulkTarget.id]).json).toEqual(before);
  const issue = run("claude-code", ["issue", "create", "判断待ち"]).json;
  const update = run("claude-code", ["issue", "update", issue.id, "--status", "todo", "-p", "1"]);
  expect(update.code).toBe(0);
  expect(update.json).toMatchObject({ status: "todo", priority: 1 });
});
