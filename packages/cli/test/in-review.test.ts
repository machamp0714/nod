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

test("エージェントがレビュー提出・修正再開・再提出・完了報告を行える", async () => {
  const cwd = makeRepo("api-server");
  const db = tempDb();
  registerRepo(db, cwd);
  const run = (args: string[]) => runNod([...args, "--json"], { cwd, db, actor: "codex" });
  const issue = (await run(["issue", "create", "レビュー指摘を修正する", "--requested"])).json;
  const started = (await run(["issue", "start", issue.id])).json;
  const review = (await run(["issue", "update", issue.id, "--status", "in_review"])).json;
  expect(review).toMatchObject({ status: "in_review", agentState: null, closedAt: null });
  const resumed = await run(["issue", "start", issue.id]);
  expect(resumed.exitCode).toBe(0);
  expect(resumed.json).toMatchObject({ status: "in_progress", agentState: "working", startedAt: started.startedAt });
  await run(["issue", "update", issue.id, "--status", "in_review"]);
  const done = await run(["issue", "done", issue.id, "--summary", "mergeと完了条件を確認しました"]);
  expect(done.exitCode).toBe(0);
  expect(done.json).toMatchObject({ status: "done", agentState: "done" });
  expect(done.json.closedAt).not.toBeNull();
  expect((await run(["issue", "show", issue.id])).json.activity).toContainEqual(expect.objectContaining({ kind: "comment", actor: "codex", body: "mergeと完了条件を確認しました" }));
});

test("CLIの進捗・統計・候補でレビュー中を未完了として扱い、完了報告だけを数える", async () => {
  const cwd = makeRepo("api-server");
  const db = tempDb();
  registerRepo(db, cwd);
  const run = (args: string[]) => runNod([...args, "--json"], { cwd, db, actor: "codex" });
  const today = new Date().toISOString().slice(0, 10);
  await run(["cycle", "create", "レビュー集計", "--start", today, "--end", today]);
  await run(["project", "create", "レビュー進捗"]);
  const review = (await run(["issue", "create", "レビュー待ち", "--requested", "--cycle", "レビュー集計", "--project", "レビュー進捗"])).json;
  const blocked = (await run(["issue", "create", "後続", "--requested", "--project", "レビュー進捗"])).json;
  expect((await run(["issue", "relate", review.id, "--blocks", blocked.id])).exitCode).toBe(0);
  await run(["issue", "start", review.id]);
  await run(["issue", "update", review.id, "--status", "in_review"]);
  for (const command of ["suggest", "next"]) expect((await run(["issue", command])).json).toBeNull();
  expect((await run(["issue", "list", "--ready"])).json).toEqual([]);
  expect((await run(["issue", "start", blocked.id])).json.error.code).toBe("BLOCKED");
  expect((await run(["cycle", "show", "レビュー集計", "--tz", "UTC"])).json).toMatchObject({ open: 1, done: 0, analytics: { scope: 1, started: 1, completed: 0 } });
  expect((await run(["project", "show", "レビュー進捗"])).json).toMatchObject({ total: 2, done: 0 });
  const stats = ["stats", "llm", "--by", "day", "--from", today, "--to", today, "--tz", "UTC"];
  expect((await run(stats)).json.llms[0].totals).toMatchObject({ submitted: 0, completed: 0 });
  await run(["issue", "start", review.id]);
  await run(["issue", "update", review.id, "--status", "in_review"]);
  expect((await run(stats)).json.llms[0].totals).toMatchObject({ submitted: 0, completed: 0 });
  await run(["issue", "done", review.id, "--summary", "mergeと完了条件を確認"]);
  expect((await run(stats)).json.llms[0].totals).toMatchObject({ submitted: 1, completed: 1 });
  expect((await run(["stats", "--by", "day", "--from", today, "--to", today, "--tz", "UTC"])).json.totals.completed).toBe(1);
  expect((await run(["issue", "next"])).json.id).toBe(blocked.id);
});
