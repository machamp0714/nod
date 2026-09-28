import { expect, test } from "bun:test";
import { join } from "node:path";
import { makeRepo, registerRepo, tempDb } from "./helpers";

for (const actor of ["codex", "claude-code", "other-agent"]) {
  test(`${actor} のTriage判断をCLIで拒否し、人は判断できる`, () => {
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
      const before = run("me", ["issue", "show", issue.id]).json;
      const args = ["triage", op, issue.id, ...(op === "duplicate" ? [original.id] : [])];
      const result = run(actor, args);
      expect(result.code).toBe(1);
      expect(result.json.error.code).toBe("FORBIDDEN_FOR_LLM");
      expect(run("me", ["issue", "show", issue.id]).json).toEqual(before);
      const accepted = run("me", args);
      expect(accepted.code).toBe(0);
      expect(accepted.json.status).toBe(op === "accept" ? "todo" : "canceled");
    }
  });
}
