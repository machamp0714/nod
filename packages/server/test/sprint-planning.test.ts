import { expect, test } from "bun:test";
import { createIssue, getSprint } from "@nod/core";
import { createApp } from "../src/app";
import { call, setup } from "./helpers";

test("HTTPから方向設定・作成・候補・版への合意・開始・中止を操作し、同じcore競合を返す", async () => {
  const { db, ws, me } = setup();
  const app = createApp({ db, sprintClock: { now: new Date("2026-10-27T03:00:00.000Z") } });
  const base = { expectedVersion: 0, requestKey: "設定", enabled: true, problem: "停滞", productGoal: "判断して再開", priorityRationale: "回答を優先" };
  expect((await call(app,"PUT",`/api/workspaces/${ws.key}/scrum`,base)).status).toBe(200);
  expect((await call(app,"GET",`/api/workspaces/${ws.key}/scrum`)).json.version).toBe(1);
  expect((await call(app,"PUT",`/api/workspaces/${ws.key}/scrum`,{...base,actor:"me"})).status).toBe(400);
  const created = await call(app,"POST","/api/sprints",{workspaceKey:ws.key,startDate:"2026-10-27",endDate:"2026-11-08",timezone:"Asia/Tokyo",expectedVersion:0,requestKey:"作成"});
  expect(created.status).toBe(201);
  const sprint = created.json;
  const issue = createIssue(me,{workspaceId:ws.id,title:"判断する"});
  const added = await call(app,"POST",`/api/sprints/${sprint.id}/candidates`,{issueRef:issue.id,expectedVersion:sprint.version,requestKey:"候補"});
  expect(added.status).toBe(201);
  const proposed = await call(app,"POST",`/api/sprints/${sprint.id}/plans`,{expectedVersion:added.json.sprint.version,requestKey:"計画",goal:"回答後に再開",verificationMethod:"一巡を確認",items:[{itemId:added.json.item.id,contribution:"回答を集約",executionPlan:"Inboxへ追加"}],definitionOfDone:[{id:"確認",text:"再開を確認"}],constraints:{executionScope:"Workspace",maxParallel:1,notes:"公開は既存権限"},changeReason:"初期計画"});
  expect(proposed.status).toBe(201);
  const accepted = await call(app,"POST",`/api/sprints/${sprint.id}/plans/${proposed.json.plan.id}/accept`,{expectedVersion:proposed.json.sprint.version,requestKey:"合意",contentHash:proposed.json.plan.contentHash});
  expect(accepted.status).toBe(200);
  const stale = await call(app,"POST",`/api/sprints/${sprint.id}/activate`,{expectedVersion:0,requestKey:"古い開始"});
  expect(stale).toMatchObject({status:409,json:{error:{code:"STALE_REVISION"}}});
  const active = await call(app,"POST",`/api/sprints/${sprint.id}/activate`,{expectedVersion:accepted.json.sprint.version,requestKey:"開始"});
  expect(active).toMatchObject({status:200,json:{phase:"active"}});
  expect((await call(app,"GET","/api/sprints/current")).json.issues.map((i:any)=>i.id)).toEqual([issue.id]);
  const activeBefore = (await call(app,"GET",`/api/sprints/${sprint.id}`)).json;
  expect((await call(app,"PATCH",`/api/sprints/${sprint.id}`,{expectedVersion:active.json.version,requestKey:"延長",endDate:"2026-11-09"})).status).toBe(409);
  expect((await call(app,"GET",`/api/sprints/${sprint.id}`)).json).toEqual(activeBefore);
  const canceled = await call(app,"POST",`/api/sprints/${sprint.id}/cancel`,{expectedVersion:active.json.version,requestKey:"中止",reason:"優先順位の変更"});
  expect(canceled).toMatchObject({status:200,json:{phase:"canceled",cancelReason:"優先順位の変更"}});
  expect((await call(app,"GET",`/api/sprints/${sprint.id}`)).json).toEqual(getSprint(db,sprint.id));

  const create = async (requestKey: string, startDate: string, endDate: string, replansSprintId?: string) => {
    const result = await call(app,"POST","/api/sprints",{workspaceKey:ws.key,startDate,endDate,timezone:"Asia/Tokyo",expectedVersion:0,requestKey,...(replansSprintId ? {replansSprintId} : {})});
    expect(result.status).toBe(201);
    return result.json;
  };
  const target = {startDate:sprint.startDate,endDate:sprint.endDate};
  const unlinked = await create("未関連作成","2026-11-10","2026-11-11");
  const unlinkedBefore = (await call(app,"GET",`/api/sprints/${unlinked.id}`)).json;
  expect(await call(app,"PATCH",`/api/sprints/${unlinked.id}`,{...target,expectedVersion:unlinked.version,requestKey:"未関連の期間変更"})).toMatchObject({status:400,json:{error:{code:"INVALID_ARGS"}}});
  expect((await call(app,"GET",`/api/sprints/${unlinked.id}`)).json).toEqual(unlinkedBefore);

  const other = await create("別中止元作成","2026-11-15","2026-11-16");
  expect(await call(app,"POST",`/api/sprints/${other.id}/cancel`,{expectedVersion:other.version,requestKey:"別中止元を中止",reason:"別の再計画"})).toMatchObject({status:200,json:{phase:"canceled"}});
  const wrong = await create("別中止元への関連作成","2026-11-18","2026-11-19",other.id);
  const wrongBefore = (await call(app,"GET",`/api/sprints/${wrong.id}`)).json;
  expect(await call(app,"PATCH",`/api/sprints/${wrong.id}`,{...target,expectedVersion:wrong.version,requestKey:"誤った中止元"})).toMatchObject({status:400,json:{error:{code:"INVALID_ARGS"}}});
  expect((await call(app,"GET",`/api/sprints/${wrong.id}`)).json).toEqual(wrongBefore);

  const linked = await create("正しい中止元への関連作成","2026-11-20","2026-11-21",sprint.id);
  const input = {...target,expectedVersion:linked.version,requestKey:"関連を保持して期間変更"};
  const updated = await call(app,"PATCH",`/api/sprints/${linked.id}`,input);
  expect(updated).toMatchObject({status:200,json:{...target,startsAt:sprint.startsAt,endsAt:sprint.endsAt,replansSprintId:sprint.id,version:linked.version+1}});
  const linkedBefore = (await call(app,"GET",`/api/sprints/${linked.id}`)).json;
  expect(await call(app,"PATCH",`/api/sprints/${linked.id}`,input)).toEqual(updated);
  expect(await call(app,"PATCH",`/api/sprints/${linked.id}`,{...input,requestKey:"古い版"})).toMatchObject({status:409,json:{error:{code:"STALE_REVISION"}}});
  expect(await call(app,"PATCH",`/api/sprints/${linked.id}`,{...input,name:"異なる入力"})).toMatchObject({status:409,json:{error:{code:"IDEMPOTENCY_CONFLICT"}}});
  for (const extra of [{actor:"me"},{replansSprintId:other.id}]) {
    expect(await call(app,"PATCH",`/api/sprints/${linked.id}`,{expectedVersion:updated.json.version,requestKey:"未知入力",...extra})).toMatchObject({status:400,json:{error:{code:"INVALID_ARGS"}}});
  }
  expect((await call(app,"GET",`/api/sprints/${linked.id}`)).json).toEqual(linkedBefore);

  let normal = await call(app,"PATCH",`/api/sprints/${unlinked.id}`,{expectedVersion:unlinked.version,requestKey:"後隣接",startDate:"2026-11-09",endDate:"2026-11-09"});
  expect(normal).toMatchObject({status:200,json:{startsAt:sprint.endsAt,replansSprintId:null}});
  normal = await call(app,"PATCH",`/api/sprints/${unlinked.id}`,{expectedVersion:normal.json.version,requestKey:"前隣接",startDate:"2026-10-26",endDate:"2026-10-26"});
  expect(normal).toMatchObject({status:200,json:{endsAt:sprint.startsAt,replansSprintId:null}});
  normal = await call(app,"PATCH",`/api/sprints/${unlinked.id}`,{expectedVersion:normal.json.version,requestKey:"通常非重複",startDate:"2026-12-01",endDate:"2026-12-01"});
  expect(normal).toMatchObject({status:200,json:{startDate:"2026-12-01",endDate:"2026-12-01",version:4,replansSprintId:null}});
  db.close();
});
