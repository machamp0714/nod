import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createIssue, initWorkspace, openDb } from "@nod/core";
import { makeRepo, runNod, tempDb, tempDir } from "./helpers";

test("LLMはnod sprint addで合意の前にIssueを所属にし、別プロセスの詳細・Issue・絞り込みで読め、人専用操作は拒否のまま", async () => {
  const cwd = makeRepo(), db = tempDb(), inputDir = tempDir();
  const d = openDb(db); const ws = initWorkspace(d,{path:cwd}).workspace;
  const prepared = createIssue({db:d,actor:"me"},{workspaceId:ws.id,title:"準備中に足す"});
  const planned = createIssue({db:d,actor:"me"},{workspaceId:ws.id,title:"計画で選ぶ"});
  const inserted = createIssue({db:d,actor:"me"},{workspaceId:ws.id,title:"実行中に差し込む"});
  const outside = createIssue({db:d,actor:"me"},{workspaceId:ws.id,title:"Sprintの外"}); d.close();
  const me = {cwd,db,actor:"me"}, codex = {cwd,db,actor:"codex"};
  let sequence = 0;
  const run = async (args:string[],input:unknown,actor="me") => {
    const file = join(inputDir,`${++sequence}.json`); writeFileSync(file,JSON.stringify(input));
    return runNod([...args,"--input",file,"--json"],{cwd,db,actor});
  };
  expect((await run(["scrum","configure"],{expectedVersion:0,requestKey:"設定",enabled:true,problem:"停滞",productGoal:"再開する",priorityRationale:"判断を優先"})).exitCode).toBe(0);
  const sprint = (await run(["sprint","create"],{workspaceKey:ws.key,name:"差し込みSprint",startDate:"2000-01-01",endDate:"2999-01-01",timezone:"Asia/Tokyo",expectedVersion:0,requestKey:"作成"},"codex")).json;

  // 合意の操作を呼ぶ前に、LLMの1回の追加だけで所属になる
  const added = await runNod(["sprint","add",String(sprint.number),prepared.id,"--json"],codex);
  expect(added.exitCode).toBe(0);
  expect(Object.keys(added.json).sort()).toEqual(["added","item","sprint"]);
  expect(added.json).toMatchObject({added:true,sprint:{id:sprint.id},item:{sourceIssueKey:prepared.id,addedBy:"codex",association:"added"}});
  const again = await runNod(["sprint","add",sprint.id,prepared.id,"--json"],codex);
  expect(again.json).toMatchObject({added:false,item:{id:added.json.item.id,addedBy:"codex",addedAt:added.json.item.addedAt}});
  expect((await runNod(["sprint","add",sprint.id,prepared.id],codex)).stdout).toContain(`既に所属しています: Sprint ${sprint.number}「差し込みSprint」 ${prepared.id}`);

  const shown = await runNod(["sprint","show",sprint.id,"--json"],me);
  expect(shown.json).toMatchObject({version:sprint.version,plans:[],adoptedPlanId:null,items:[{sourceIssueKey:prepared.id,association:"added",addedBy:"codex"}]});
  const shownText = (await runNod(["sprint","show",String(sprint.number)],me)).stdout;
  expect(shownText).toContain(prepared.id);
  expect(shownText).toContain("追加（追加者: codex）");
  const issue = await runNod(["issue","show",prepared.id,"--json"],me);
  expect(issue.json.sprints).toEqual([expect.objectContaining({id:sprint.id,number:sprint.number,association:"added"})]);
  expect(issue.json.activity.filter((e:any)=>e.type==="sprint_added").map((e:any)=>e.actor)).toEqual(["codex"]);
  const issueText = (await runNod(["issue","show",prepared.id],me)).stdout;
  expect(issueText).toContain(`Sprint: ${sprint.number} 差し込みSprint（追加）`);
  expect(issueText).toContain(`codex が Sprint ${sprint.number}「差し込みSprint」に追加した`);
  expect((await runNod(["issue","list","--sprint",String(sprint.number),"--json"],me)).json.map((i:any)=>i.id)).toEqual([prepared.id]);

  // 計画・合意・開始・中止の人専用の制約は残る
  expect((await runNod(["sprint","add",sprint.id,planned.id,"--json"],codex)).json.added).toBe(true);
  const plannedItem = (await runNod(["sprint","show",sprint.id,"--json"],me)).json.items.find((i:any)=>i.sourceIssueKey===planned.id);
  const proposed = (await run(["sprint","plan","propose",sprint.id],{expectedVersion:sprint.version,requestKey:"計画",goal:"差し込みを進める",verificationMethod:"一巡する",items:[{itemId:plannedItem.id,contribution:"計画の作業",executionPlan:"実装する"}],definitionOfDone:[{id:"確認",text:"動く"}],constraints:{executionScope:"Workspace",maxParallel:1,notes:"既存権限"},changeReason:"最初の計画"},"codex")).json;
  const agree = {expectedVersion:proposed.sprint.version,requestKey:"合意",contentHash:proposed.plan.contentHash};
  expect((await run(["sprint","plan","accept",sprint.id,proposed.plan.id],agree,"codex")).json.error.code).toBe("FORBIDDEN_FOR_LLM");
  const ready = (await run(["sprint","plan","accept",sprint.id,proposed.plan.id],agree)).json;
  const activation = {expectedVersion:ready.sprint.version,requestKey:"開始"};
  expect((await run(["sprint","activate",sprint.id],activation,"codex")).json.error.code).toBe("FORBIDDEN_FOR_LLM");
  const active = (await run(["sprint","activate",sprint.id],activation)).json;
  expect(active.phase).toBe("active");

  // 実行中のSprintへの差し込みも、再承認なしで current の所属になる
  const insertion = await runNod(["sprint","add",sprint.id,inserted.id,"--json"],codex);
  expect(insertion.json).toMatchObject({added:true,sprint:{phase:"active",version:active.version},item:{sourceIssueKey:inserted.id,addedBy:"codex"}});
  expect((await runNod(["sprint","plan","list",sprint.id,"--json"],me)).json.map((p:any)=>p.id)).toEqual([proposed.plan.id]);
  const current = (await runNod(["issue","list","--sprint","current","--json"],me)).json.map((i:any)=>i.id).sort();
  expect(current).toEqual([prepared.id,planned.id,inserted.id].sort());
  expect(current).not.toContain(outside.id);
  expect((await runNod(["issue","list","--sprint","none","--json"],me)).json.map((i:any)=>i.id)).toEqual([outside.id]);
  expect((await runNod(["issue","show",inserted.id,"--json"],me)).json.sprints).toEqual([expect.objectContaining({id:sprint.id,association:"added"})]);
  expect((await run(["sprint","cancel",sprint.id],{expectedVersion:active.version,requestKey:"中止",reason:"優先順位変更"},"codex")).json.error.code).toBe("FORBIDDEN_FOR_LLM");
});
