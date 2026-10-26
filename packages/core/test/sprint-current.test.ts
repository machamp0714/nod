import { expect, test } from "bun:test";
import { openDb } from "../src/db";
import { createView, getView } from "../src/ops/views";
import { completionStats } from "../src/ops/stats";
import { STATUSES } from "../src/types";
import { createIssue, queryIssues } from "../src/ops/issues";
import { initWorkspace } from "../src/ops/workspaces";
import { resolveCurrentSprints } from "../src/ops/sprints";
import { tempDbPath } from "./helpers";

const clock = {now: new Date('2026-10-26T03:00:00.000Z')};

// 合意・開始の製品操作はS02の範囲。内部fixtureだけで読取契約を検証する。
function fixture() {
  const db=openDb(tempDbPath());
  const workspaces=['AAA','BBB','CCC','DDD','EEE','FFF','GGG','HHH','III'].map(key=>initWorkspace(db,{path:`/tmp/${key}`,key,name:key}).workspace);
  const makeSprint=(ws:number, phase:string, ends='2026-10-27T03:00:00.000Z', agreement='me', hash='合意hash')=>{
    const id=crypto.randomUUID();
    db.query(`INSERT INTO sprints(id,number,workspace_id,name,phase,start_date,end_date,timezone,starts_at,ends_at,adopted_plan_id,created_at,updated_at)
      VALUES(?,?,?,? ,?,'2026-10-25','2026-10-27','Asia/Tokyo','2026-10-25T03:00:00.000Z',?,?, '2026-10-01','2026-10-01')`).run(id,ws,ws,`Sprint ${ws}`,phase,ends,`plan-${id}`);
    db.query("INSERT INTO sprint_plans VALUES(?,?,1,'合意hash',?,'2026-10-25',?)").run(`plan-${id}`,id,agreement,hash);
    return id;
  };
  const sprints=[makeSprint(workspaces[0]!.id,'active'),makeSprint(workspaces[1]!.id,'active'),
    makeSprint(workspaces[2]!.id,'imported'),makeSprint(workspaces[3]!.id,'ended'),makeSprint(workspaces[4]!.id,'canceled'),
    makeSprint(workspaces[5]!.id,'active',clock.now.toISOString()),makeSprint(workspaces[6]!.id,'draft'),
    makeSprint(workspaces[7]!.id,'active',undefined,'codex'),makeSprint(workspaces[8]!.id,'active',undefined,'me','別hash')];
  const addItem=(ws:number,sprint:string,title:string,status='todo',adopted=true)=>{
    const issue=createIssue({db,actor:'me'},{workspaceId:ws,title});
    db.query('UPDATE issues SET status=? WHERE workspace_id=? AND number=?').run(status,ws,issue.number);
    const row=db.query('SELECT id FROM issues WHERE workspace_id=? AND number=?').get(ws,issue.number) as {id:number};
    const item=crypto.randomUUID();
    db.query("INSERT INTO sprint_items VALUES(?,?,?,?,?,'candidate')").run(item,sprint,row.id,issue.id,JSON.stringify({schemaVersion:1,workspace:{id:ws,key:issue.workspace,name:issue.workspace},issue:{id:row.id,title,description:null,status}}));
    if(adopted) db.query('INSERT INTO sprint_plan_items VALUES(?,?)').run(`plan-${sprint}`,item);
    return issue.id;
  };
  const expected:string[]=[];
  for (let index=0;index<2;index++) for (const status of STATUSES) expected.push(addItem(workspaces[index]!.id,sprints[index]!,status,status));
  const first=db.query('SELECT * FROM sprint_items WHERE source_issue_key=?').get(expected[0]!) as {sprint_id:string;issue_id:number;snapshot:string};
  const duplicate=crypto.randomUUID();
  db.query("INSERT INTO sprint_items VALUES(?,?,?,?,?,'candidate')").run(duplicate,first.sprint_id,first.issue_id,'重複する関連のfixture',first.snapshot);
  db.query('INSERT INTO sprint_plan_items VALUES(?,?)').run(`plan-${first.sprint_id}`,duplicate);
  const candidate=addItem(workspaces[0]!.id,sprints[0]!,'候補のみ','todo',false);
  const archived=addItem(workspaces[0]!.id,sprints[0]!,'アーカイブ');
  db.query('UPDATE issues SET archived_at=? WHERE title=?').run('2026-10-26','アーカイブ');
  for (let index=2;index<sprints.length;index++) addItem(workspaces[index]!.id,sprints[index]!,'除外される採択');
  return {db,workspaces,sprints,expected,candidate,archived};
}

test('各Workspaceの有効な現在Sprintと人が合意した採択だけを全状態で読み、時刻境界・閲覧範囲・重複を守る',()=>{
  const {db,workspaces,sprints,expected,archived}=fixture();
  const current=resolveCurrentSprints(db,{clock});
  expect(current.sprints.map(s=>s.id)).toEqual(sprints.slice(0,2));
  expect(current.issues.map(i=>i.id)).toEqual(expected);
  expect(current.issues[0]!.sprints.map(s=>s.id)).toEqual([sprints[0]!]);
  expect(resolveCurrentSprints(db,{clock,workspaceIds:[workspaces[0]!.id]}).issues.map(i=>i.id)).toEqual(expected.slice(0,STATUSES.length));
  expect(resolveCurrentSprints(db,{clock,workspaceIds:[]}).issues).toEqual([]);
  expect(resolveCurrentSprints(db,{clock,workspaceIds:[workspaces[2]!.id]})).toEqual({sprints:[],issues:[]});
  expect(resolveCurrentSprints(db,{clock,archived:true}).issues.map(i=>i.id)).toEqual([archived]);
  expect(resolveCurrentSprints(db,{clock:{now:new Date('2026-10-25T02:59:59.999Z')}}).issues).toEqual([]);
  expect(resolveCurrentSprints(db,{clock:{now:new Date('2026-10-27T03:00:00.000Z')}}).issues).toEqual([]);
  expect(()=>db.query(`INSERT INTO sprints(id,number,workspace_id,name,phase,start_date,end_date,timezone,starts_at,ends_at,created_at,updated_at)
    SELECT ?,100,workspace_id,'同時active','active',start_date,end_date,timezone,starts_at,ends_at,created_at,updated_at FROM sprints WHERE id=?`)
    .run(crypto.randomUUID(),sprints[0]!)).toThrow('UNIQUE constraint failed: sprints.workspace_id');
  db.exec('DROP TABLE sprint_plan_items');
  expect(()=>resolveCurrentSprints(db,{clock})).toThrow();
  db.close();
});

test('保存Viewのcurrent・固定Sprint・noneを共通scopeで読み、候補だけは未所属として扱う',()=>{
  const {db,sprints,expected,candidate}=fixture();
  expect(queryIssues(db,{sprint:'current'},clock).issues.map(i=>i.id)).toEqual(expected);
  expect(queryIssues(db,{sprint:sprints[0]},clock).issues.map(i=>i.id)).toEqual(expected.slice(0,STATUSES.length));
  expect(queryIssues(db,{sprint:'1'},clock).issues.map(i=>i.id)).toEqual(expected.slice(0,STATUSES.length));
  expect(queryIssues(db,{sprint:'none'},clock).issues.map(i=>i.id)).toContain(candidate);
  expect(queryIssues(db,{sprint:'none'},clock).issues.map(i=>i.id).some(i=>expected.includes(i))).toBe(false);
  expect(queryIssues(db,{sprint:'current',workspace:['BBB']},clock).issues.map(i=>i.id)).toEqual(expected.slice(STATUSES.length));
  expect(()=>queryIssues(db,{sprint:'legacy-cycle:99'},clock)).toThrow();
  expect(()=>queryIssues(db,{sprint:crypto.randomUUID()},clock)).toThrow();
  const view=createView(db,{name:'全Workspaceの現在Sprint',filter:{sprint:'current'}});
  expect(getView(db,view.id).filter).toEqual({sprint:'current'});
  expect(queryIssues(db,getView(db,view.id).filter,clock).issues.map(i=>i.id)).toEqual(expected);
  db.query("UPDATE sprints SET phase='ended' WHERE id=?").run(sprints[0]!);
  expect(queryIssues(db,getView(db,view.id).filter,clock).issues.map(i=>i.id)).toEqual(expected.slice(STATUSES.length));
  db.close();
});

test('完了分析も同じcurrentと固定Sprintのscopeを用い、候補を採択に数えない',()=>{
  const {db,sprints}=fixture();
  db.exec("UPDATE issues SET closed_at='2026-10-26T04:00:00.000Z' WHERE status='done'");
  const range={from:'2026-10-26',to:'2026-10-26',tz:'UTC',now:clock.now};
  expect(completionStats(db,{...range,sprint:'current'}).totals.completed).toBe(2);
  expect(completionStats(db,{...range,sprint:sprints[0]}).totals.completed).toBe(1);
  expect(completionStats(db,{...range,sprint:'none'}).totals.completed).toBe(0);
  expect(()=>completionStats(db,{...range,sprint:'legacy-cycle:99'})).toThrow();
  db.close();
});
