import { expect, test } from "bun:test";
import { createIssue, startIssue } from "@nod/core";
import { setup, call } from "./helpers";

test("APIの説明検索と手動status変更はcoreと同じ結果になる", async () => {
  const {db,app,ws,me}=setup();
  const issue=createIssue(me,{workspaceId:ws.id,title:"対象",description:"Users 日本語 ÉCOLE %_"});
  createIssue(me,{workspaceId:ws.id,title:"無関係"});
  for(const q of ["users","日本語","école","%_"]) {
    const r=await call(app,"GET",`/api/issues?${new URLSearchParams({q})}`);
    expect(r.status).toBe(200);
    expect(r.json.issues.map((i:{id:string})=>i.id)).toEqual([issue.id]);
    expect(r.json.counts.ready).toBe(1);
  }
  startIssue({db,actor:"codex"},issue.id);
  const r=await call(app,"POST",`/api/issues/${issue.id}/update`,{status:"todo"});
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({status:"todo",agentState:null});
  db.close();
});
