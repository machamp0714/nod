import { expect, test } from "bun:test";
import { join } from "node:path";
import { createIssue, openDb } from "@nod/core";
import { makeRepo, registerRepo, tempDb } from "./helpers";

test("CLI --queryは説明とUnicodeを検索しstart後のtodoでworkingを外す", () => {
  const path=tempDb(); const cwd=makeRepo(); registerRepo(path,cwd,"API");
  const db=openDb(path); const me={db,actor:"me"};
  createIssue(me,{workspaceId:1,title:"対象",description:"Users 日本語 ÉCOLE %_"});
  createIssue(me,{workspaceId:1,title:"無関係"}); db.close();
  const run=(args:string[])=> {
    const result=Bun.spawnSync(["bun",join(import.meta.dir,"../src/main.ts"),...args],{cwd,env:{...process.env,NOD_DB:path,NOD_ORCA:"0",NOD_ACTOR:"codex"},stdout:"pipe",stderr:"pipe"});
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };
  for(const q of ["users","日本語","école","%_"]) expect(JSON.parse(run(["issue","list","--query",q,"--json"])).map((i:{id:string})=>i.id)).toEqual(["API-1"]);
  run(["issue","start","API-1"]);
  expect(JSON.parse(run(["issue","update","API-1","--status","todo","--json"])).agentState).toBeNull();
  expect(run(["issue","show","API-1"])).not.toContain("[working]");
});
