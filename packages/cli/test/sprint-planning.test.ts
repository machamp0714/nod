import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createIssue, initWorkspace, openDb } from "@nod/core";
import { makeRepo, runNod, tempDb, tempDir } from "./helpers";

test("CLIのJSON入力で提案から人の合意と開始へ進み、agentの人専用操作と競合を拒否する", async () => {
  const cwd = makeRepo(), db = tempDb(), inputDir = tempDir();
  const d = openDb(db); const ws = initWorkspace(d,{path:cwd}).workspace;
  const issue = createIssue({db:d,actor:"me"},{workspaceId:ws.id,title:"判断を集める"}); d.close();
  let sequence = 0;
  const run = async (args:string[],input:unknown,actor="me") => {
    const file = join(inputDir,`${++sequence}.json`); writeFileSync(file,JSON.stringify(input));
    return runNod([...args,"--input",file,"--json"],{cwd,db,actor});
  };
  const config = {expectedVersion:0,requestKey:"設定",enabled:true,problem:"停滞",productGoal:"再開する",priorityRationale:"判断を優先"};
  expect((await run(["scrum","configure"],config,"codex")).json.error.code).toBe("FORBIDDEN_FOR_LLM");
  expect((await run(["scrum","configure"],config)).exitCode).toBe(0);
  expect((await runNod(["scrum","show","--json"],{cwd,db,actor:"codex"})).json.version).toBe(1);
  const sprint = (await run(["sprint","create"],{workspaceKey:ws.key,startDate:"2000-01-01",endDate:"2999-01-01",timezone:"Asia/Tokyo",expectedVersion:0,requestKey:"作成"},"codex")).json;
  expect(sprint.phase).toBe("draft");
  const added = (await run(["sprint","candidates","add",sprint.id],{expectedVersion:sprint.version,requestKey:"候補",issueRef:issue.id},"codex")).json;
  const proposed = (await run(["sprint","plan","propose",sprint.id],{expectedVersion:added.sprint.version,requestKey:"計画",goal:"回答後に再開",verificationMethod:"一巡する",items:[{itemId:added.item.id,contribution:"判断を集約",executionPlan:"Inboxへ追加"}],definitionOfDone:[{id:"操作",text:"再開を確認"}],constraints:{executionScope:"Workspace",maxParallel:1,notes:"公開は既存権限"},changeReason:"最初の計画"},"codex")).json;
  const agree = {expectedVersion:proposed.sprint.version,requestKey:"合意",contentHash:proposed.plan.contentHash};
  expect((await run(["sprint","plan","accept",sprint.id,proposed.plan.id],agree,"codex")).json.error.code).toBe("FORBIDDEN_FOR_LLM");
  const ready = (await run(["sprint","plan","accept",sprint.id,proposed.plan.id],agree)).json;
  const activation = {expectedVersion:ready.sprint.version,requestKey:"開始"};
  expect((await run(["sprint","activate",sprint.id],activation,"codex")).json.error.code).toBe("FORBIDDEN_FOR_LLM");
  const active = (await run(["sprint","activate",sprint.id],activation)).json;
  expect(active.phase).toBe("active");
  expect((await runNod(["sprint","show",sprint.id,"--json"],{cwd,db,actor:"codex"})).json.plans[0].contentHash).toBe(proposed.plan.contentHash);
  expect((await run(["sprint","update",sprint.id],{expectedVersion:0,requestKey:"古い更新",name:"変更"})).json.error.code).toBe("STALE_REVISION");
  const cancel = {expectedVersion:active.version,requestKey:"中止",reason:"優先順位変更"};
  expect((await run(["sprint","cancel",sprint.id],cancel,"codex")).json.error.code).toBe("FORBIDDEN_FOR_LLM");
  expect((await run(["sprint","cancel",sprint.id],cancel)).json.phase).toBe("canceled");
});

test("CLIはstdinのJSON入力を受け取り、不正JSONを日本語の構造化エラーで返す", async () => {
  const cwd=makeRepo(), db=tempDb();
  const d=openDb(db); initWorkspace(d,{path:cwd}); d.close();
  const send = async (body:string) => {
    const proc=Bun.spawn(["bun",join(import.meta.dir,"../src/main.ts"),"scrum","configure","--input","-","--json"],{
      cwd,env:{...process.env,NOD_DB:db,NOD_ACTOR:"me",NOD_ORCA:"0"},stdin:"pipe",stdout:"pipe",stderr:"pipe",
    });
    proc.stdin.write(body); proc.stdin.end();
    const [text,exit] = await Promise.all([new Response(proc.stdout).text(),proc.exited]);
    return {exit,json:JSON.parse(text)};
  };
  expect(await send(JSON.stringify({enabled:true,problem:"停滞",productGoal:"再開",priorityRationale:"判断を優先",expectedVersion:0,requestKey:"標準入力"}))).toMatchObject({exit:0,json:{version:1}});
  expect((await send("{" )).json.error.code).toBe("INVALID_ARGS");
});
