import { expect, test } from "bun:test";
import { openDb } from "@nod/core";
import { addActiveSprint, legacySprintFixture } from "../../core/test/fixtures/sprint";
import { makeRepo, runNod, tempDb } from "./helpers";

test("Sprint一覧・番号とUUIDの詳細・Issue検索を読み、currentは完了済みを含める", async () => {
  const db=tempDb();
  const cwd=makeRepo();
  legacySprintFixture(db);
  const opts={cwd,db,actor:"me"};
  const list=await runNod(["sprint","list","--json"],opts);
  expect(list.exitCode).toBe(0);
  expect(list.json.map((s:any)=>[s.number,s.phase])).toEqual([[1,"imported"],[2,"imported"],[3,"imported"],[4,"imported"]]);
  const history=await runNod(["sprint","show","1","--json"],opts);
  expect(history.json).toMatchObject({id:list.json[0].id,goal:null,timezone:null,items:[{sourceIssueKey:"AAA-1"},{sourceIssueKey:"BBB-1"}]});
  expect((await runNod(["sprint","show",list.json[0].id,"--json"],opts)).json).toEqual(history.json);
  const text=await runNod(["sprint","show","1"],opts);
  expect(text.stdout).toContain("不明");
  expect(text.stdout).toContain("AAA-1");
  expect((await runNod(["sprint","show","999","--json"],opts)).json.error.code).toBe("NOT_FOUND");
  const d=openDb(db); addActiveSprint(d,1,5,["AAA-1"]); addActiveSprint(d,2,6,["BBB-1"]); d.close();
  const current=await runNod(["issue","list","--all-workspaces","--sprint","current","--json"],opts);
  expect(current.json.map((i:any)=>i.id)).toEqual(["AAA-1","BBB-1"]);
  expect(current.json[0].sprints.map((s:any)=>s.association)).toEqual(["imported","adopted"]);
  expect((await runNod(["issue","list","--all-workspaces","--sprint","none","--json"],opts)).json.map((i:any)=>i.id)).toEqual(["AAA-2"]);
});

test("statsとsummaryもSprint条件で絞り、未解決条件を外して全件に広げない", async () => {
  const db=tempDb(); const cwd=makeRepo(); legacySprintFixture(db);
  const d=openDb(db); addActiveSprint(d,1,5,["AAA-1"]); addActiveSprint(d,2,6,["BBB-1"]); d.close();
  const opts={cwd,db,actor:"me"};
  for(const command of [["stats"],["stats","llm"],["summary"]]) {
    const res=await runNod([...command,"--all-workspaces","--sprint","current","--json"],opts);
    expect([command,res.exitCode]).toEqual([command,0]);
    expect((await runNod([...command,"--all-workspaces","--sprint","legacy-cycle:99","--json"],opts)).json.error.code).toBe("NOT_FOUND");
  }
  const fixed=await runNod(["stats","--all-workspaces","--sprint","1","--from","2026-10-01","--to","2026-10-01","--tz","UTC","--json"],opts);
  expect(fixed.json.totals.completed).toBe(1);
  const none=await runNod(["stats","--all-workspaces","--sprint","none","--from","2026-10-01","--to","2026-10-01","--tz","UTC","--json"],opts);
  expect(none.json.totals.completed).toBe(0);
});
