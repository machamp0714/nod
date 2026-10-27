import { expect, test } from "bun:test";
import { createIssue, getIssue, listSprints, listViews, queryIssues } from "@nod/core";
import { call, setup } from "./helpers";

test("旧Cycleと周期のAPIは入力によらず廃止案内を返し、Issueの他属性も部分変更しない", async () => {
  const {app,db,ws,me} = setup();
  const issue = createIssue(me,{workspaceId:ws.id,title:"元の要求"});
  const before = getIssue(db,issue.id);
  for (const [method,path,body] of [
    ["POST","/api/cycles",{}], ["POST","/api/cycles/不明/update",{name:"変更"}],
    ["DELETE","/api/cycles/1",undefined], ["PUT","/api/cycle-cadence",{}],
    ["DELETE","/api/cycle-cadence",undefined],
    ["POST","/api/views",{name:"旧条件",filter:{cycle:"current"}}], ["GET","/api/cycle-cadence",undefined],
    ["POST",`/api/issues/${issue.id}/update`,{title:"変更",cycleRef:null}],
    ["POST","/api/issues/bulk-update",{ids:[issue.id],priority:1,cycleRef:3}],
    ["POST",`/api/issues/${issue.id}/accept`,{priority:1,cycleRef:"1"}],
  ] as const) {
    const res = await call(app,method,path,body);
    expect([path,res.status,res.json.error.code]).toEqual([path,410,"CYCLE_RETIRED"]);
    expect(res.json.error.message).toContain("Sprint");
    expect(getIssue(db,issue.id)).toEqual(before);
  }
  expect(listViews(db)).toEqual([]);
  expect(listSprints(db)).toEqual([]);
  expect(queryIssues(db,{}).issues).toHaveLength(1);
  db.close();
});
