import { expect, test } from "bun:test";
import { join } from "node:path";
import { configureScrumWorkspace, createSprint, initWorkspace, listSprints, openDb, resolveSprint } from "../src/index";
import { tempDbPath } from "./helpers";

async function race(path:string,operation:string,ref:string,inputs:unknown[]) {
  const children = inputs.map(input => Bun.spawn(["bun",join(import.meta.dir,"fixtures/sprint-planning-race.ts"),path,operation,ref,JSON.stringify(input)],{stdout:"pipe",stderr:"pipe"}));
  return Promise.all(children.map(async child => {
    const [stdout,stderr,exit] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    expect([exit,stderr]).toEqual([0,""]);
    return JSON.parse(stdout);
  }));
}
test("別プロセスのDB接続が同じ作成要求を再送しても1件へ合流し、競合更新は一方だけ成功する", async () => {
  const path = tempDbPath(), db = openDb(path), me = {db,actor:"me"};
  const ws = initWorkspace(db,{path:"/tmp/race",key:"RACE"}).workspace;
  configureScrumWorkspace(me,ws.key,{enabled:true,problem:"競合",productGoal:"一意性",priorityRationale:"一件だけ",expectedVersion:0,requestKey:"設定"});
  const create = {workspaceKey:ws.key,startDate:"2026-10-01",endDate:"2026-10-14",timezone:"Asia/Tokyo",expectedVersion:0,requestKey:"同一作成"};
  const identical = await race(path,"create","",[create,create]);
  expect(identical[0]).toEqual(identical[1]);
  expect(listSprints(db)).toHaveLength(1);
  const sprint = listSprints(db)[0]!;
  const updated = await race(path,"update",sprint.id,[{expectedVersion:sprint.version,requestKey:"更新A",name:"A"},{expectedVersion:sprint.version,requestKey:"更新B",name:"B"}]);
  expect(updated.filter(r=>r.value)).toHaveLength(1);
  expect(updated.find(r=>r.error).error.code).toBe("STALE_REVISION");
  expect(resolveSprint(db,sprint.id).version).toBe(sprint.version+1);
  const overlapping = await race(path,"create","",[{...create,requestKey:"別作成A",startDate:"2026-11-01",endDate:"2026-11-14"},{...create,requestKey:"別作成B",startDate:"2026-11-01",endDate:"2026-11-14"}]);
  expect(overlapping.filter(r=>r.value)).toHaveLength(1);
  expect(overlapping.find(r=>r.error).error.code).toBe("SPRINT_OVERLAP");
  expect(listSprints(db).map(s=>s.number)).toEqual([1,2]);
  db.close();
});
