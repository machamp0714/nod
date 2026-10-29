import { expect, test } from "bun:test";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

test("CLIからレビュー中へ移し、表示・検索・表示名・遷移ルールを往復できる", async () => {
  const cwd = makeRepo("api-server");
  const db = tempDb();
  registerRepo(db, cwd);
  const opts = { cwd, db };
  const run = (args: string[]) => runNod(args, opts);
  const issue = (await run(["issue", "create", "レビューに提出", "--json"])).json;
  await run(["issue", "start", issue.id]);
  const update = await run(["issue", "update", issue.id, "--status", "in_review", "--json"]);
  expect(update.exitCode).toBe(0);
  expect(update.json.status).toBe("in_review");
  expect((await run(["issue", "show", issue.id])).stdout).toContain("In Review");
  expect((await run(["issue", "list", "--status", "in_review", "--json"])).json.map((item: { id: string }) => item.id)).toEqual([issue.id]);
  expect((await run(["workspace", "status-names", "set", "in_review", "レビュー中", "--json"])).exitCode).toBe(0);
  expect((await run(["workspace", "status-names", "show", "--json"])).json.names.in_review).toBe("レビュー中");
  expect((await run(["issue", "show", issue.id])).stdout).toContain("レビュー中");
  expect((await run(["workspace", "transitions", "set", "--forbid", "in_review:done", "--json"])).exitCode).toBe(0);
  expect((await run(["workspace", "transitions", "show", "--json"])).json.forbidden).toEqual([{ from: "in_review", to: "done" }]);
  expect((await run(["issue", "update", issue.id, "--status", "done", "--json"])).json.error.code).toBe("TRANSITION_NOT_ALLOWED");
  expect((await run(["issue", "show", issue.id, "--json"])).json.status).toBe("in_review");
  for (const args of [
    ["workspace", "status-names", "set", "in_review", "レビュー"],
    ["workspace", "transitions", "set", "--forbid", "todo:in_review"],
  ]) {
    expect((await runNod([...args, "--json"], { ...opts, actor: "codex" })).json.error.code).toBe("FORBIDDEN_FOR_LLM");
  }
});
