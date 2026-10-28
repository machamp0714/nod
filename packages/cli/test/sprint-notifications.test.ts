import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "@nod/core";
import { makeRepo, runNod, tempDb, tempDir } from "./helpers";
import { prepareSprint } from "../../core/test/fixtures/sprint-start";

test("CLIのreceiveは実構造の質問に返信し、別Deliveryの再配送を同じ保存結果へ合流させる", async () => {
  const cwd = makeRepo(), path = tempDb(), dir = tempDir(), db = core.openDb(path), me = { db, actor: "me" }, llm = { db, actor: "codex" };
  const ws = core.initWorkspace(db, { path: cwd }).workspace, issue = core.createIssue(me, { workspaceId: ws.id, title: "通知を受理する仕事" });
  const p = prepareSprint(me, ws.key, [issue.id]);
  const period = core.updateSprint(me, p.sprint.id, { expectedVersion: p.sprint.version, requestKey: "期間", startDate: "2000-01-01", endDate: "2999-01-01" });
  const proposed = core.proposeSprintPlan(me, period.id, { ...p.input, expectedVersion: period.version, requestKey: "期間内の計画" });
  const ready = core.acceptSprintPlan(me, period.id, proposed.plan.id, { expectedVersion: proposed.sprint.version, requestKey: "合意", contentHash: proposed.plan.contentHash });
  const sprint = core.activateSprint(me, period.id, { expectedVersion: ready.sprint.version, requestKey: "開始" });
  const adapter: core.SprintOrcaAdapter = { authority: async () => ({ runId: "fixture-run", caller: "fixture-pm", coordinator: "fixture-pm", consumerGeneration: 1, runtimeId: "fixture-home", callerIdentity: "orca_session_id:fixture-session", source: "Orca", observedAt: new Date().toISOString() }),
    send: async o => ({ runId: "fixture-run", taskId: "fixture-task", dispatchId: o.kind === "task_create" ? null : "fixture-dispatch", requestId: "request:" + o.id, requested: null, effective: null, identity: null, source: "Orca", receivedAt: new Date().toISOString() }) };
  const session = await core.beginSprintSession(llm, sprint.id, { expectedVersion: sprint.version, requestKey: "監督", runId: "fixture-run" }, adapter);
  const context = { sessionId: session.id, generation: 1 };
  const attempt = core.prepareSprintExecution(llm, sprint.id, { ...context, itemId: p.items[0]!.id, requestKey: "担当", actor: "codex", spec: "仕事", placement: { agent: "codex", worktree: "path:/fixture" } });
  await core.requestSprintExecution(llm, sprint.id, { ...context, attemptId: attempt.id }, adapter); db.close();
  const fake = join(dir, "orca.ts"), stateFile = join(dir, "state.json"), input = join(dir, "input.json");
  writeFileSync(stateFile, JSON.stringify({ delivery: "fixture-delivery-first", acked: false, commands: [] }));
  writeFileSync(fake, `import {readFileSync,writeFileSync} from 'node:fs';
const file=process.env.NOD_TEST_ORCA_STATE!,s=JSON.parse(readFileSync(file,'utf8')),a=process.argv.slice(2);s.commands.push(a);let result;
const text='保存した成果を確認してください';
if(a[0]==='status')result={runtime:{runtimeId:'fixture-home',state:'ready',reachable:true,connectionState:'connected'},caller:{orcaSessionId:'orca_session_id:fixture-session',live:true}};
else if(['run-current','run-show'].includes(a[1]))result={run:{id:'fixture-run',coordinator_handle:'fixture-pm',consumer_generation:1}};
else if(a[1]==='check'){const ack=a.includes('--ack')?a[a.indexOf('--ack')+1]:null;if(ack)s.acked=true;result={runId:'fixture-run',deliveryId:s.acked?null:s.delivery,messages:s.acked?[]:[{id:'fixture-question',run_id:'fixture-run',delivery_contract:'current_delivery',from_handle:'dispatch:fixture-dispatch',to_handle:'run:fixture-run',type:'question',body:'確認先を教えてください',payload:JSON.stringify({taskId:'fixture-task',dispatchId:'fixture-dispatch',question:'確認先を教えてください',options:[]}),created_at:'2026-01-01T00:00:00Z',delivered_at:null}],count:s.acked?0:1,acknowledged:ack};}
else if(a[1]==='reply')result={message:{id:'fixture-answer',run_id:'fixture-run',from_handle:'run:fixture-run',to_handle:'dispatch:fixture-dispatch',type:'status',thread_id:'fixture-question',body:text},question:{message_id:'fixture-question',run_id:'fixture-run',dispatch_id:'fixture-dispatch',asker_handle:'dispatch:fixture-dispatch',status:'answered',answer_message_id:'fixture-answer',answer_body:text,answered_by_generation:1,answered_at:'2026-01-01T00:00:00Z'},duplicate:false,mutation:{requestId:'fixture-reply-request'}};
else throw Error('想定外の操作');writeFileSync(file,JSON.stringify(s));console.log(JSON.stringify({ok:true,result,_meta:{runtimeId:'fixture-home'}}));`);
  writeFileSync(input, JSON.stringify({ ...context, answers: [{ messageId: "fixture-question", body: "保存した成果を確認してください" }] }));
  const opts = { cwd, db: path, actor: "codex", env: { NOD_ORCA: "1", ORCA_CLI_COMMAND: `bun ${fake}`, NOD_TEST_ORCA_STATE: stateFile } };
  const receive = () => runNod(["sprint", "execution", "receive", sprint.id, "--input", input, "--from", "fixture-pm", "--json"], opts);
  const first = await receive();
  expect(first).toMatchObject({ exitCode: 0, json: { results: [{ kind: "question" }], deliveries: [{ acknowledged: true }] } });
  const saved = JSON.parse(readFileSync(stateFile, "utf8")); saved.delivery = "fixture-delivery-next"; saved.acked = false; writeFileSync(stateFile, JSON.stringify(saved));
  const replayed = await receive();
  expect(replayed.json.results[0].id).toBe(first.json.results[0].id);
  expect(replayed.json.results).toHaveLength(1);
  const commands: string[][] = JSON.parse(readFileSync(stateFile, "utf8")).commands;
  expect(commands.filter(a => a[1] === "reply")).toHaveLength(1);
  expect(commands.filter(a => a.includes("--ack")).map(a => a[a.indexOf("--ack") + 1])).toEqual(["fixture-delivery-first", "fixture-delivery-next"]);
  const shown = await runNod(["sprint", "execution", "notifications", sprint.id], opts);
  expect(shown.exitCode).toBe(0); expect(shown.stdout).toContain("配送"); expect(shown.stdout).toContain("受理結果");
});
