import { expect, test } from "bun:test";
import * as core from "@nod/core";
import { acceptPreparedSprint, prepareSprint, sprintTestClock } from "../../core/test/fixtures/sprint-start";
import { makeRepo, runNod, tempDb } from "./helpers";

test("CLIのsuggest/next/start/update/bulk-updateは採択Issueにも通常どおり成功し、採択外の通常操作を保つ", async () => {
  const cwd = makeRepo(), path = tempDb(), db = core.openDb(path);
  const ws = core.initWorkspace(db, { path: cwd }).workspace, me = { db, actor: "me" };
  const adopted = core.createIssue(me, { workspaceId: ws.id, title: "採択", priority: 1 });
  const adoptedForHuman = core.createIssue(me, { workspaceId: ws.id, title: "人が着手する採択", priority: 2 });
  const ordinary = core.createIssue(me, { workspaceId: ws.id, title: "通常", priority: 4 });
  const untouched = core.createIssue(me, { workspaceId: ws.id, title: "一括の採択外", priority: 4 });
  const ready = acceptPreparedSprint(me, prepareSprint(me, ws.key, [adopted.id, adoptedForHuman.id]));
  // 固定時計の過去の期間で開始するため、CLIの実行前の自動引継ぎで終了させず、採択Issueへの通常操作だけを確かめる
  core.setSprintRollover(me, ws.key, { enabled: false });
  const run = (args: string[], actor = "codex") => runNod(["issue", ...args, "--json"], { cwd, db: path, actor });
  expect((await run(["suggest"])).json.id).toBe(adopted.id);
  expect((await run(["next"])).json).toMatchObject({ id: adopted.id, status: "in_progress", assignee: "codex" });
  // 先の操作で担当が決まると別actorのstartは一般条件で拒否されるので、actorごとにIssueを分ける。
  for (const [actor, issue] of [["codex", adopted], ["me", adoptedForHuman]] as const) {
    expect(await run(["start", issue.id], actor)).toMatchObject({ exitCode: 0, json: { id: issue.id, status: "in_progress", assignee: actor } });
    expect(await run(["update", issue.id, "--status", "in_progress", "--assignee", actor], actor)).toMatchObject({ exitCode: 0, json: { status: "in_progress", assignee: actor } });
  }
  core.activateSprint(me, ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, sprintTestClock);
  expect(await run(["bulk-update", untouched.id, adopted.id, "--status", "in_progress", "--priority", "1"], "me")).toMatchObject({ exitCode: 0 });
  expect((await run(["show", untouched.id])).json).toMatchObject({ status: "in_progress", priority: 1 });
  expect((await run(["show", adopted.id])).json).toMatchObject({ status: "in_progress", assignee: "codex", priority: 1 });
  expect((await run(["next"])).json.id).toBe(ordinary.id);
  expect((await run(["start", untouched.id])).json.status).toBe("in_progress");
  db.close();
});
