import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createIssue, initWorkspace, openDb } from "@nod/core";
import { makeRepo, runNod, tempDb, tempDir } from "./helpers";

// 旧データの候補だけのitem（追加の記録なし）を作る
function legacyCandidate(db: string, sprintId: string, issueRef: string): void {
  const d = openDb(db);
  const row = d.query("SELECT i.id FROM issues i JOIN workspaces w ON w.id=i.workspace_id WHERE w.key || '-' || i.number=?").get(issueRef) as { id: number };
  d.query("INSERT INTO sprint_items(id,sprint_id,issue_id,source_issue_key,snapshot,origin) VALUES(?,?,?,?,?,'candidate')")
    .run(crypto.randomUUID(), sprintId, row.id, issueRef, JSON.stringify({ schemaVersion: 1, capturedAt: "2026-10-01T00:00:00.000Z", statusBasis: "candidate_snapshot", labels: [], project: null, workspace: {}, issue: { id: row.id, title: "旧候補", description: null, status: "todo" } }));
  d.close();
}

test("LLMはnod sprint removeで追加の所属を外し、別プロセスの詳細・Issue・絞り込みで読め、採択の所属と閉じたSprintからは外せない", async () => {
  const cwd = makeRepo(), db = tempDb(), inputDir = tempDir();
  const d = openDb(db); const ws = initWorkspace(d,{path:cwd}).workspace;
  const moved = createIssue({db:d,actor:"me"},{workspaceId:ws.id,title:"次のSprintへ送る"});
  const mistaken = createIssue({db:d,actor:"me"},{workspaceId:ws.id,title:"誤って入れた"});
  const planned = createIssue({db:d,actor:"me"},{workspaceId:ws.id,title:"計画で選ぶ"});
  const legacy = createIssue({db:d,actor:"me"},{workspaceId:ws.id,title:"旧候補"});
  const outside = createIssue({db:d,actor:"me"},{workspaceId:ws.id,title:"Sprintの外"}); d.close();
  const me = {cwd,db,actor:"me"}, codex = {cwd,db,actor:"codex"};
  let sequence = 0;
  const run = async (args:string[],input:unknown,actor="me") => {
    const file = join(inputDir,`${++sequence}.json`); writeFileSync(file,JSON.stringify(input));
    return runNod([...args,"--input",file,"--json"],{cwd,db,actor});
  };
  expect((await run(["scrum","configure"],{expectedVersion:0,requestKey:"設定",enabled:true,problem:"停滞",productGoal:"再開する",priorityRationale:"判断を優先"})).exitCode).toBe(0);
  const sprint = (await run(["sprint","create"],{workspaceKey:ws.key,name:"外すSprint",startDate:"2000-01-01",endDate:"2099-12-31",timezone:"Asia/Tokyo",expectedVersion:0,requestKey:"作成"},"codex")).json;
  const other = (await run(["sprint","create"],{workspaceKey:ws.key,name:"次のSprint",startDate:"2100-01-01",endDate:"2199-12-31",timezone:"Asia/Tokyo",expectedVersion:0,requestKey:"次を作成"},"codex")).json;
  const added = (await runNod(["sprint","add",String(sprint.number),moved.id,"--json"],codex)).json;
  expect((await runNod(["sprint","add",String(other.number),moved.id,"--json"],codex)).json.added).toBe(true);
  expect((await runNod(["sprint","add",sprint.id,mistaken.id,"--json"],codex)).json.added).toBe(true);
  legacyCandidate(db,sprint.id,legacy.id);

  // 番号の参照で外す。item・写しは残り、追加の記録だけが外れる。Sprintの版は上がらない
  const removed = await runNod(["sprint","remove",String(sprint.number),moved.id,"--json"],codex);
  expect(removed.exitCode).toBe(0);
  expect(Object.keys(removed.json).sort()).toEqual(["item","removed","sprint"]);
  expect(removed.json).toMatchObject({removed:true,sprint:{id:sprint.id,version:sprint.version},item:{id:added.item.id,sourceIssueKey:moved.id,association:null,addedBy:null}});
  // UUIDの参照で外し、テキストで外したことを1行で示す
  expect((await runNod(["sprint","remove",sprint.id,mistaken.id],codex)).stdout).toContain(`外しました: Sprint ${sprint.number}「外すSprint」 ${mistaken.id}`);

  // 所属でなければ何もしない。解除済みのitemは返し、itemが無ければnull
  const again = await runNod(["sprint","remove",sprint.id,moved.id,"--json"],codex);
  expect(again.json).toMatchObject({removed:false,item:{id:added.item.id,addedBy:null}});
  const never = await runNod(["sprint","remove",String(sprint.number),outside.id,"--json"],codex);
  expect(never.exitCode).toBe(0);
  expect(never.json).toMatchObject({removed:false,item:null,sprint:{id:sprint.id}});
  expect((await runNod(["sprint","remove",sprint.id,outside.id],codex)).stdout).toContain(`所属ではありません（何もしていません）: Sprint ${sprint.number}「外すSprint」 ${outside.id}`);

  // 別プロセスの読み出し: 指定していないSprintの所属は残り、Activityの操作者はLLM
  const issue = await runNod(["issue","show",moved.id,"--json"],me);
  expect(issue.json.sprints).toEqual([expect.objectContaining({id:other.id,number:other.number,association:"added",inAdoptedPlan:false})]);
  expect(issue.json.activity.filter((e:any)=>e.type==="sprint_removed").map((e:any)=>e.actor)).toEqual(["codex"]);
  expect((await runNod(["issue","show",moved.id],me)).stdout).toContain(`codex が Sprint ${sprint.number}「外すSprint」から外した`);
  expect((await runNod(["issue","list","--sprint",String(sprint.number),"--json"],me)).json.map((i:any)=>i.id)).toEqual([]);
  expect((await runNod(["issue","list","--sprint",String(other.number),"--json"],me)).json.map((i:any)=>i.id)).toEqual([moved.id]);
  const shownText = (await runNod(["sprint","show",String(sprint.number)],me)).stdout;
  expect(shownText).toContain("item（所属は移行・採択・追加。旧候補と解除済みは所属外）:");
  expect(shownText).not.toContain("候補だけ");
  for (const key of [moved.id,mistaken.id,legacy.id]) {
    const row = shownText.split("\n").find(l=>l.startsWith(`  ${key}  `));
    expect([key,row?.endsWith("所属外")]).toEqual([key,true]);
  }

  // 計画で採択された所属は、追加の記録が重なっていても外せず、何も書かない
  expect((await runNod(["sprint","add",sprint.id,planned.id,"--json"],codex)).json.added).toBe(true);
  const plannedItem = (await runNod(["sprint","show",sprint.id,"--json"],me)).json.items.find((i:any)=>i.sourceIssueKey===planned.id);
  const proposed = (await run(["sprint","plan","propose",sprint.id],{expectedVersion:sprint.version,requestKey:"計画",goal:"送る",verificationMethod:"一巡する",items:[{itemId:plannedItem.id,contribution:"計画の作業",executionPlan:"実装する"}],definitionOfDone:[{id:"確認",text:"動く"}],constraints:{executionScope:"Workspace",notes:"既存権限"},changeReason:"最初の計画"},"codex")).json;
  expect((await run(["sprint","plan","accept",sprint.id,proposed.plan.id],{expectedVersion:proposed.sprint.version,requestKey:"合意",contentHash:proposed.plan.contentHash})).exitCode).toBe(0);
  expect((await runNod(["issue","show",planned.id,"--json"],me)).json.sprints).toEqual([expect.objectContaining({id:sprint.id,association:"added",inAdoptedPlan:true})]);
  const adopted = await runNod(["sprint","remove",sprint.id,planned.id,"--json"],codex);
  expect(adopted.exitCode).not.toBe(0);
  expect(adopted.json.error.code).toBe("INVALID_STATE");
  expect((await runNod(["issue","list","--sprint",sprint.id,"--json"],me)).json.map((i:any)=>i.id)).toEqual([planned.id]);
  expect((await runNod(["issue","show",planned.id,"--json"],me)).json.activity.filter((e:any)=>e.type==="sprint_removed")).toEqual([]);

  // 閉じたSprintからは外せず、所属は履歴として残る
  expect((await run(["sprint","cancel",other.id],{expectedVersion:other.version,requestKey:"中止",reason:"優先順位変更"})).exitCode).toBe(0);
  const closed = await runNod(["sprint","remove",String(other.number),moved.id,"--json"],codex);
  expect(closed.exitCode).not.toBe(0);
  expect(closed.json.error.code).toBe("INVALID_STATE");
  expect((await runNod(["issue","show",moved.id,"--json"],me)).json.sprints).toEqual([expect.objectContaining({id:other.id,association:"added"})]);
});
