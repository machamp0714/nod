import { expect, test } from "bun:test";
import { openDb } from "@nod/core";
import { addActiveSprint, legacySprintFixture } from "../../core/test/fixtures/sprint";
import { createApp } from "../src/app";
import { call, tempDir } from "./helpers";
import { join } from "node:path";

test("Sprint全件・詳細・旧IDの専用解決を読み、旧IDを新番号へ読み替えない", async () => {
  const path=join(tempDir(),"nod.db"); legacySprintFixture(path);
  const db=openDb(path); const app=createApp({db});
  const list=await call(app,"GET","/api/sprints");
  expect(list.status).toBe(200);
  expect(list.json.map((s:any)=>[s.number,s.phase])).toEqual([[1,"imported"],[2,"imported"],[3,"imported"],[4,"imported"]]);
  const detail=await call(app,"GET","/api/sprints/1");
  expect(detail.json).toMatchObject({id:list.json[0].id,timezone:null,goal:null,items:[{sourceIssueKey:"AAA-1"},{sourceIssueKey:"BBB-1"}]});
  expect((await call(app,"GET",`/api/sprints/${detail.json.id}`)).json).toEqual(detail.json);
  expect((await call(app,"GET","/api/cycles/1")).json).toEqual({kind:"imported",sprintId:detail.json.id});
  expect((await call(app,"GET","/api/cycles/99")).json).toEqual({kind:"deleted"});
  const fresh=addActiveSprint(db,1,100,[]);
  expect((await call(app,"GET","/api/cycles/100")).json).toEqual({kind:"not_found"});
  expect((await call(app,"GET","/api/sprints/100")).json.id).toBe(fresh);
  expect((await call(app,"GET","/api/sprints/999")).json.error.code).toBe("NOT_FOUND");
  expect((await call(app,"GET","/api/cycles/abc")).status).toBe(400);
  db.close();
});

test("保存Viewは相対currentとSprint列を保ち、採用planと現在Sprintの変更に追従する", async () => {
  const path=join(tempDir(),"nod.db"); legacySprintFixture(path);
  const db=openDb(path); const app=createApp({db});
  const a=addActiveSprint(db,1,5,["AAA-1"]); addActiveSprint(db,2,6,["BBB-1"]);
  const saved=await call(app,"POST","/api/views",{name:"横断",color:"#123456",filter:{sprint:"current",q:""},display:{columns:["status","sprint","project"],groupBy:"sprint",subGroupBy:"workspace"}});
  expect(saved.status).toBe(201);
  const view=(await call(app,"GET",`/api/views/${saved.json.id}`)).json;
  expect(view.filter.sprint).toBe("current");
  expect(view.display.columns).toEqual(["status","sprint","project"]);
  expect((await call(app,"GET","/api/issues?sprint=current")).json.issues.map((i:any)=>i.id)).toEqual(["AAA-1","BBB-1"]);
  const detail=(await call(app,"GET","/api/issues/AAA-1")).json;
  expect(detail.sprints.map((s:any)=>[s.number,s.association])).toEqual([[1,"imported"],[5,"adopted"]]);
  expect((await call(app,"GET","/api/issues?sprint=current&workspace=BBB")).json.issues.map((i:any)=>i.id)).toEqual(["BBB-1"]);
  db.query("UPDATE sprint_plans SET agreed_hash='異なるhash' WHERE sprint_id=?").run(a);
  expect((await call(app,"GET","/api/issues?sprint=current")).json.issues.map((i:any)=>i.id)).toEqual(["BBB-1"]);
  db.query("UPDATE sprint_plans SET agreed_hash=content_hash WHERE sprint_id=?").run(a);
  db.query("UPDATE sprints SET phase='ended' WHERE id=?").run(a);
  addActiveSprint(db,1,7,["AAA-2"]);
  expect((await call(app,"GET","/api/issues?sprint=current")).json.issues.map((i:any)=>i.id)).toEqual(["AAA-2","BBB-1"]);
  expect((await call(app,"GET",`/api/views/${saved.json.id}`)).json.filter.sprint).toBe("current");
  expect((await call(app,"GET","/api/issues?sprint=legacy-cycle:99")).json.error.code).toBe("NOT_FOUND");
  db.close();
});

test("未来の時計でも通常読取は移行履歴とIssueを変えず、currentなしと取得失敗を区別する", async () => {
  const path=join(tempDir(),"nod.db"); legacySprintFixture(path);
  const db=openDb(path); const app=createApp({db,sprintClock:{now:new Date('3000-01-01T00:00:00.000Z')}});
  const before=(await call(app,"GET","/api/issues/AAA-1")).json;
  const first=(await call(app,"GET","/api/sprints")).json;
  expect((await call(app,"GET","/api/sprints/current")).json).toEqual({sprints:[],issues:[]});
  expect((await call(app,"GET","/api/issues?sprint=current")).json.issues).toEqual([]);
  expect((await call(app,"GET","/api/sprints")).json).toEqual(first);
  expect((await call(app,"GET","/api/issues/AAA-1")).json).toEqual(before);
  const id=addActiveSprint(db,1,5,["AAA-1"]);
  const currentApp=createApp({db});
  const current=(await call(currentApp,"GET","/api/sprints/current?workspaceId=1")).json;
  expect(current.sprints.map((s:any)=>s.id)).toEqual([id]);
  expect(current.issues.map((i:any)=>i.status)).toEqual(["done"]);
  expect((await call(currentApp,"GET","/api/sprints/current?workspaceId=2")).json).toEqual({sprints:[],issues:[]});
  db.exec('DROP TABLE sprint_plan_items');
  const failure=await call(currentApp,"GET","/api/sprints/current");
  expect(failure.status).toBe(500);
  expect(failure.json.error.code).toBe("INTERNAL");
  db.close();
});

test("Sprint分析APIは写しと履歴を区別し、旧分析APIも旧ID対応だけを使う", async () => {
  const path=join(tempDir(),"nod.db"); legacySprintFixture(path);
  const db=openDb(path); const app=createApp({db});
  const analysis=await call(app,"GET","/api/sprints/1/analytics?tz=UTC");
  expect(analysis.status).toBe(200);
  expect(analysis.json).toMatchObject({number:1,statusBasis:"migration_snapshot",completed:1});
  expect(analysis.json.burnup.at(-1).completed).toBe(0);
  expect((await call(app,"GET","/api/cycles/1/analytics?tz=UTC")).json).toEqual(analysis.json);
  expect((await call(app,"GET","/api/cycles/99/analytics")).json.error.code).toBe("LEGACY_CYCLE_DELETED");
  addActiveSprint(db,1,100,[]);
  expect((await call(app,"GET","/api/cycles/100/analytics")).json.error.code).toBe("NOT_FOUND");
  db.close();
});

test("検索・stats・summaryは同じSprint条件を使い、未解決と廃止条件を空集合と区別する", async () => {
  const path=join(tempDir(),"nod.db"); legacySprintFixture(path);
  const db=openDb(path); addActiveSprint(db,1,5,["AAA-1"]);
  const app=createApp({db,sprintClock:{now:new Date('2026-10-26T00:00:00.000Z')}});
  const range='from=2026-10-01&to=2026-10-01&tz=UTC';
  for(const sprint of ['1','current']) {
    expect((await call(app,"GET",`/api/stats?${range}&sprint=${sprint}`)).json.totals.completed).toBe(1);
    expect((await call(app,"GET",`/api/summary?since=90d&sprint=${sprint}`)).json.sections.find((s:any)=>s.kind==='completed').items.map((i:any)=>i.issueId)).toEqual(['AAA-1']);
  }
  expect((await call(app,"GET",`/api/stats?${range}&sprint=none`)).json.totals.completed).toBe(0);
  for(const route of ['/api/issues','/api/stats','/api/stats/llm','/api/summary']) {
    expect((await call(app,"GET",`${route}?sprint=legacy-cycle:99`)).json.error.code).toBe('NOT_FOUND');
    expect((await call(app,"GET",`${route}?cycle=current`)).json.error.code).toBe('CYCLE_RETIRED');
  }
  const issues=(await call(app,'GET','/api/issues?sprint=current')).json.issues;
  const current=(await call(app,'GET','/api/sprints/current')).json;
  expect(current.issues[0].sprints).toEqual(issues[0].sprints);
  db.close();
});
