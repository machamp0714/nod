import { expect, test } from "bun:test";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

test("LLM はレビュー待ちを経ずに完了し、旧レビューコマンドは受け付けない", async () => {
  const cwd = makeRepo();
  const db = tempDb();
  registerRepo(db, cwd);
  const opts = { cwd, db, actor: "codex" };
  const created = await runNod(["issue", "create", "実装する", "--requested", "--json"], opts);
  const id = created.json.id;
  const started = await runNod(["issue", "start", id, "--json"], opts);
  expect(started.json).not.toHaveProperty("rejection");
  const done = await runNod(["issue", "done", id, "--summary", "実装を完了した"], opts);
  expect(done.exitCode).toBe(0);
  expect(done.stdout).toContain("完了しました:");
  expect((await runNod(["issue", "show", id, "--json"], opts)).json.status).toBe("done");
  const inbox = await runNod(["inbox", "--json"], opts);
  expect(inbox.json).not.toHaveProperty("reviews");
  for (const args of [
    ["review", "list"],
    ["review", "approve", id],
    ["review", "reject", id, "理由"],
    ["git", "sync"],
    ["automation", "undo", id],
    ["automation", "set", "--pr-review", "on"],
    ["automation", "set", "--commit-review", "on"],
  ]) {
    const rejected = await runNod([...args, "--json"], opts);
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.json.error.code).toBe("INVALID_ARGS");
  }
});
