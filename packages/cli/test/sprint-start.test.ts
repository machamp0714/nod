import { expect, test } from "bun:test";
import * as core from "@nod/core";
import { acceptPreparedSprint, prepareSprint, sprintTestClock } from "../../core/test/fixtures/sprint-start";
import { makeRepo, runNod, tempDb } from "./helpers";

test("CLIのsuggest/next/start/update/bulk-updateは同じ採択保護を通り、採択外の通常操作を保つ", async () => {
  const cwd = makeRepo(), path = tempDb(), db = core.openDb(path);
  const ws = core.initWorkspace(db, { path: cwd }).workspace, me = { db, actor: "me" };
  const adopted = core.createIssue(me, { workspaceId: ws.id, title: "採択", priority: 1 });
  const ordinary = core.createIssue(me, { workspaceId: ws.id, title: "通常", priority: 4 });
  const untouched = core.createIssue(me, { workspaceId: ws.id, title: "一括の採択外", priority: 4 });
  const ready = acceptPreparedSprint(me, prepareSprint(me, ws.key, [adopted.id]));
  const run = (args: string[], actor = "codex") => runNod(["issue", ...args, "--json"], { cwd, db: path, actor });
  expect((await run(["suggest"])).json.id).toBe(ordinary.id);
  expect((await run(["next"])).json.id).toBe(ordinary.id);
  for (const actor of ["codex", "me"]) {
    expect(await run(["start", adopted.id], actor)).toMatchObject({ exitCode: 1, json: { error: { code: "SPRINT_CONTEXT_REQUIRED" } } });
    expect(await run(["update", adopted.id, "--status", "in_progress", "--assignee", actor], actor)).toMatchObject({ exitCode: 1, json: { error: { code: "SPRINT_CONTEXT_REQUIRED" } } });
  }
  core.activateSprint(me, ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, sprintTestClock);
  expect(await run(["bulk-update", untouched.id, adopted.id, "--status", "in_progress", "--priority", "1"], "me")).toMatchObject({ exitCode: 1, json: { error: { code: "BULK_UPDATE_FAILED", details: { failures: [{ id: adopted.id, code: "SPRINT_CONTEXT_REQUIRED" }] } } } });
  expect((await run(["show", untouched.id])).json).toMatchObject({ status: "todo", priority: 4 });
  expect((await run(["show", adopted.id])).json).toMatchObject({ status: "todo", assignee: null, agentState: null });
  expect((await run(["start", untouched.id])).json.status).toBe("in_progress");
  db.close();
});
