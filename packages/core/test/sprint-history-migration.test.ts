import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDb } from "../src/db";
import { MIGRATIONS } from "../src/schema";
import { getSprint, listSprints, resolveLegacyCycle, nextSprintNumber } from "../src/ops/sprints";
import { createIssue, getIssue, updateIssue, queryIssues } from "../src/ops/issues";
import { createCycle, updateCycle, deleteCycle, moveOpenIssues } from "../src/ops/cycles";
import { setCadence, clearCadence, syncCycles } from "../src/ops/cycle-cadence";
import { answerQuestion } from "../src/ops/human";
import { isSubscribed, listNotifications, markNotificationsRead } from "../src/ops/notifications";
import { getDesktopNotificationDelivery } from "../src/ops/desktop-notifications";
import { getProject, updateProject } from "../src/ops/projects";
import { recentSummary } from "../src/ops/summary";
import { completionStats } from "../src/ops/stats";
import { tempDbPath } from "./helpers";
import { listViews, updateView } from "../src/ops/views";
import { listPageDisplays, setPageDisplay } from "../src/ops/page-displays";

function legacyFixture() {
  const path = tempDbPath();
  const old = new Database(path);
  for (const migration of MIGRATIONS.slice(0, 42)) for (const step of migration) {
    if (typeof step === "string") old.exec(step); else step(old);
  }
  old.exec(`PRAGMA user_version=42;
    INSERT INTO workspaces (id,key,name,path,created_at,color) VALUES (1,'AAA','元A','/a','2026-01-01','#123456'),(2,'BBB','元B','/b','2026-01-01','#654321');
    UPDATE workspaces SET next_number=2;
    INSERT INTO cycles (id,name,start_date,end_date,created_by,created_at,updated_at) VALUES
      (1,'過去','2026-01-01','2026-01-14','me','2026-01-01','2026-01-01'),
      (2,'現在','2026-10-20','2026-11-02','me','2026-10-01','2026-10-01'),
      (3,'未来','2027-01-01','2027-01-14','me','2026-10-01','2026-10-01'),
      (4,'空','2027-02-01','2027-02-14','me','2026-10-01','2026-10-01');
    INSERT INTO cycle_cadence VALUES(1,2,1,'2026-01-01',5,'me','2026-10-01');
    INSERT INTO issues (id,workspace_id,number,title,description,status,cycle_id,created_by,created_at,updated_at) VALUES
      (1,1,1,'元の要求','元本文','done',1,'me','2026-01-01','2026-10-01'),
      (2,2,1,'別Workspace','別本文','todo',1,'me','2026-01-01','2026-10-01');
    INSERT INTO events (id,issue_id,actor,type,data,created_at) VALUES
      (1,1,'me','created','{"cycle_id":1,"status":"todo"}','2026-01-01'),
      (2,1,'me','cycle_changed','{"from_id":99,"to_id":1}','2026-01-02'),
      (3,2,'me','cycle_changed','{"from_id":2,"to_id":1}','2026-01-02');`);
  old.close();
  return path;
}

test("版42の全期間を1件ずつ履歴へ移し、再起動とIssue変更後も元の要求とイベントを読める", () => {
  const path = legacyFixture();
  let db = openDb(path);
  const periods = listSprints(db);
  expect(periods.map(s => [s.number,s.name,s.phase,s.workspaceId,s.timezone])).toEqual([
    [1,'過去','imported',null,null],[2,'現在','imported',null,null],
    [3,'未来','imported',null,null],[4,'空','imported',null,null],
  ]);
  const history = getSprint(db, String(periods[0]!.id));
  expect(history).toMatchObject({startDate:'2026-01-01',endDate:'2026-01-14',goal:null,definitionOfDone:null,outcome:null});
  expect(history.items.map(i => [i.sourceIssueKey,i.snapshot.workspace.key,i.snapshot.issue.description])).toEqual([
    ['AAA-1','AAA','元本文'],['BBB-1','BBB','別本文'],
  ]);
  expect(history.legacy!.cadence).toMatchObject({weeks:2,next_number:5});
  expect(history.events.map(e => e.original.id)).toEqual([1,2,3]);
  expect(resolveLegacyCycle(db,99).kind).toBe('deleted');
  expect(resolveLegacyCycle(db,100).kind).toBe('not_found');
  expect(resolveLegacyCycle(db,1)).toMatchObject({kind:'imported',sprintId:history.id});
  expect(queryIssues(db,{sprint:'none'}).issues).toEqual([]);
  expect(queryIssues(db,{sprint:history.id}).issues.map(i=>i.id)).toEqual(['AAA-1','BBB-1']);
  expect(getIssue(db,'AAA-1').title).toBe('元の要求');
  updateIssue({db,actor:'me'},'AAA-1',{description:'後の本文'});
  expect(createIssue({db,actor:'me'},{workspaceId:1,title:'通常起票'}).title).toBe('通常起票');
  db.exec('DELETE FROM issues WHERE id=2');
  expect(getSprint(db,history.id).items).toEqual(history.items.map(i => i.sourceIssueKey === 'BBB-1' ? {...i,issueId:null} : i));
  expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('cycles','cycle_cadence','issues_cycle')").all()).toEqual([]);
  const backups = readdirSync(join(dirname(path),'backups'));
  db.close();
  db = openDb(path);
  expect(listSprints(db)).toEqual(periods);
  expect(readdirSync(join(dirname(path),'backups'))).toEqual(backups);
  const backup = new Database(join(dirname(path),'backups',backups[0]!),{readonly:true});
  expect(backup.query('PRAGMA user_version').get()).toEqual({user_version:42});
  expect(backup.query('SELECT name FROM cycles ORDER BY id').all()).toEqual([{name:'過去'},{name:'現在'},{name:'未来'},{name:'空'}]);
  expect(backup.query('SELECT description FROM issues WHERE cycle_id=1 ORDER BY id').all()).toEqual([{description:'元本文'},{description:'別本文'}]);
  backup.close(); db.close();
});


test("移行した固定View、相対条件、全ページの表示設定を再表示して保存できる", () => {
  const path = legacyFixture();
  const old = new Database(path);
  const display = {groupBy:'cycle',subGroupBy:'workspace',columns:['status','project'],showCompleted:false};
  for (const [name,cycle] of [['固定ID','1'],['固定名','過去'],['相対','current'],['未所属','none'],['削除済み','99'],['不明名','不明の期間']]) {
    old.query("INSERT INTO views(name,color,filter,display) VALUES(?,'#123456',?,?)").run(name!,JSON.stringify({cycle,q:'本文',status:['done']}),JSON.stringify(display));
  }
  for (const page of ['issues','my-issues','project:1','cycle:1','cycle:99']) old.query("INSERT INTO page_displays VALUES(?,?,'2026-01-01')").run(page,JSON.stringify({groupBy:'workspace',subGroupBy:'cycle',showChildren:false}));
  old.close();
  openDb(path).close();
  const db = openDb(path);
  const id = listSprints(db)[0]!.id;
  const views = listViews(db);
  expect(views.map(v=>v.filter.sprint)).toEqual([id,id,'current','none','legacy-cycle:99','legacy-cycle:不明の期間']);
  for (const view of views) {
    expect(view).toMatchObject({color:'#123456',filter:{q:'本文',status:['done']},display:{groupBy:'sprint',subGroupBy:'workspace',showCompleted:false}});
    expect(updateView(db,view.id,{filter:view.filter,display:view.display})).toEqual(view);
  }
  const pages=listPageDisplays(db);
  expect(Object.keys(pages).sort()).toEqual(['issues','my-issues','project:1',`sprint:${id}`,'cycle:99'].sort());
  for (const [page,display] of Object.entries(pages)) {
    expect(display).toEqual({groupBy:'workspace',subGroupBy:'sprint',showChildren:false});
    expect(setPageDisplay(db,page,display)).toEqual(display);
  }
  db.close();
});


test("版42のバックアップ失敗時は期間・関連・イベント・保存Viewを一切変えない",()=>{
  const path=legacyFixture();
  const old=new Database(path);
  const tables=['cycles','cycle_cadence','issues','events','views','workspaces'];
  const before=tables.map(t=>old.query(`SELECT * FROM ${t}`).all());
  old.close();
  writeFileSync(join(dirname(path),'backups'),'バックアップ作成を妨げるfixture');
  let error:unknown;
  try {openDb(path);} catch(e) {error=e;}
  expect(error).toMatchObject({code:'DB_BACKUP_FAILED'});
  const unchanged=new Database(path,{readonly:true});
  expect(unchanged.query('PRAGMA user_version').get()).toEqual({user_version:42});
  expect(tables.map(t=>unchanged.query(`SELECT * FROM ${t}`).all())).toEqual(before);
  expect(unchanged.query("SELECT name FROM sqlite_master WHERE name='sprints'").all()).toEqual([]);
  unchanged.close();
});

test('旧Cycleの全書込みと直接所属変更を案内して拒否し、同期も移行履歴を動かさない',()=>{
  const path=legacyFixture();
  const db=openDb(path);
  const ctx={db,actor:'me'};
  const before=getSprint(db,listSprints(db)[0]!.id);
  const events=db.query('SELECT * FROM events').all();
  for (const operation of [
    ()=>createCycle(ctx,{name:'作成',startDate:'2026-01-01',endDate:'2026-01-14'}),
    ()=>updateCycle(ctx,'1',{name:'変更'}),()=>deleteCycle(ctx,'1'),
    ()=>moveOpenIssues(ctx,'1','2'),()=>setCadence(ctx,{weeks:1}),()=>clearCadence(ctx),
    ()=>createIssue(ctx,{workspaceId:1,title:'直接所属',cycleRef:'1'}),
    ()=>updateIssue(ctx,'AAA-1',{title:'巻き添え変更',cycleRef:null}),
  ]) {
    let error:unknown; try {operation();} catch(e) {error=e;}
    expect(error).toMatchObject({code:'CYCLE_RETIRED'});
  }
  expect(syncCycles(ctx)).toEqual({created:[],carried:[]});
  expect(getSprint(db,before.id)).toEqual(before);
  expect(getIssue(db,'AAA-1').title).toBe('元の要求');
  expect(db.query('SELECT * FROM events').all()).toEqual(events);
  db.close();
});


test('移行時に未所属のIssueの旧期間イベントと分析根拠も保存し、旧ID再利用疑いを確定関連と分ける',()=>{
  const path=legacyFixture();
  const old=new Database(path);
  old.exec(`INSERT INTO issues(id,workspace_id,number,title,description,status,created_by,created_at,updated_at)
    VALUES(3,1,2,'移動済みの要求','退避する本文','done','me','2025-12-01','2026-02-01');
    INSERT INTO events(id,issue_id,actor,type,data,created_at) VALUES
    (4,3,'me','created','{"cycle_id":1,"status":"todo"}','2026-01-03'),
    (5,3,'me','status_changed','{"from":"todo","to":"done"}','2026-01-04'),
    (6,3,'me','cycle_changed','{"from_id":1,"to_id":null}','2026-01-05'),
    (7,3,'me','cycle_changed','{"from_id":2,"to_id":null}','2025-12-01');
    INSERT INTO issue_labels VALUES(3,'履歴label');`);
  old.close();
  const db=openDb(path);
  const sprint=listSprints(db)[0]!;
  const detail=getSprint(db,sprint.id);
  expect(detail.items).toHaveLength(2);
  expect(detail.events.map(e=>e.original.id)).toEqual([1,2,3,4,5,6,7]);
  expect(detail.evidence.find(e=>e.sourceIssueKey==='AAA-2')).toMatchObject({snapshot:{issue:{description:'退避する本文'},labels:['履歴label']}});
  const reused=getSprint(db,'2');
  expect(reused.events.find(e=>e.original.id===7)?.association).toBe('ambiguous');
  expect(detail.events.find(e=>e.original.id===4)?.association).toBe('recorded');
  db.exec('DELETE FROM issues WHERE id=3');
  expect(getSprint(db,sprint.id).evidence).toEqual(detail.evidence);
  expect(getSprint(db,sprint.id).events).toEqual(detail.events);
  db.close();
});

test('Sprint共通番号は旧採番と周期消費の全上限を越えて続き、削除した番号を再利用しない',()=>{
  for (const [consumedId,cadenceNext,expected] of [[4,5,5],[12,5,13],[4,20,20]]) {
    const path=legacyFixture();
    const old=new Database(path);
    old.query("UPDATE sqlite_sequence SET seq=? WHERE name='cycles'").run(consumedId!);
    old.query('UPDATE cycle_cadence SET next_number=?').run(cadenceNext!);
    old.close();
    const db=openDb(path);
    expect(nextSprintNumber(db)).toBe(expected!);
    const add=(number:number)=>db.query(`INSERT INTO sprints(id,number,workspace_id,name,phase,start_date,end_date,timezone,created_at,updated_at)
      VALUES(?,?,1,'後続fixture','draft','2026-10-26','2026-10-27','Asia/Tokyo','2026-10-26','2026-10-26')`).run(crypto.randomUUID(),number);
    add(expected!);
    expect(nextSprintNumber(db)).toBe(expected!+1);
    db.query('DELETE FROM sprints WHERE number=?').run(expected!);
    expect(()=>add(expected!)).toThrow();
    expect(nextSprintNumber(db)).toBe(expected!+1);
    add(expected!+1);
    expect(nextSprintNumber(db)).toBe(expected!+2);
    db.close();
  }
});


test('質問・通知・購読・Document・Project・配送・期限通知の原本を保ち、通常操作を継続できる',()=>{
  const path=legacyFixture();
  const old=new Database(path);
  old.exec(`INSERT INTO projects(id,name,created_by,created_at,updated_at) VALUES(1,'元Project','me','2026-01-01','2026-01-01');
    UPDATE issues SET project_id=1,due_date='2026-01-14',closed_at='2026-01-10T00:00:00.000Z' WHERE id=1;
    INSERT INTO questions(id,issue_id,question,asked_by,asked_at) VALUES(1,2,'元の質問','codex','2026-01-01');
    INSERT INTO subscriptions VALUES(2,'me','2026-01-01');
    INSERT INTO comments(id,issue_id,author,body,created_at) VALUES(1,2,'codex','元のコメント','2026-01-01');
    INSERT INTO documents(id,path,title,kind,created_at) VALUES(1,'/fixture/spec.md','元仕様','spec','2026-01-01');
    INSERT INTO document_links(document_id,issue_id) VALUES(1,2);
    INSERT INTO document_links(document_id,project_id) VALUES(1,1);
    INSERT INTO notifications(id,recipient,issue_id,kind,event_type,event_id,actor,created_at)
      VALUES(1,'me',2,'activity','created',3,'codex','2026-01-01');
    INSERT INTO desktop_notification_deliveries VALUES(1,'sent',NULL,'2026-01-01','2026-01-01');
    INSERT INTO due_date_occurrences VALUES(1,'2026-01-14','2026-01-01','notified',1);
    UPDATE events SET created_at=created_at || 'T00:00:00.000Z';`);
  const tables=['projects','issues','questions','subscriptions','comments','documents','document_links','notifications','events','desktop_notification_settings','desktop_notification_deliveries','due_date_notification_settings','due_date_occurrences'];
  const before=tables.map(t=>old.query(`SELECT * FROM ${t}`).all());
  old.close();
  openDb(path).close();
  const db=openDb(path);
  // 撤去した単一所属以外の全行・全列を比較する。
  expect(tables.map((t,index)=>db.query(`SELECT * FROM ${t}`).all())).toEqual(before.map((rows,index)=>tables[index]==='issues' ? rows.map(row=>{const {cycle_id,...kept}=row as Record<string,unknown>;return kept;}) : rows));
  expect(getIssue(db,'BBB-1')).toMatchObject({questions:[{id:1,question:'元の質問'}],documents:[{id:1,title:'元仕様'}]});
  expect(getProject(db,'1')).toMatchObject({name:'元Project',documents:[{id:1,title:'元仕様'}]});
  expect(isSubscribed(db,'BBB-1')).toBe(true);
  expect(listNotifications(db).map(n=>n.id)).toEqual([1]);
  expect(getDesktopNotificationDelivery(db,1)).toEqual({state:'sent',reason:null});
  expect(completionStats(db,{from:'2026-01-01',to:'2026-01-14',tz:'UTC',sprint:'1'}).totals.completed).toBe(1);
  expect(recentSummary(db,{since:'2026-01-01T00:00:00.000Z',now:new Date('2026-01-15T00:00:00Z')}).totals).toEqual({total:1,human:1,llm:0});
  expect(answerQuestion({db,actor:'me'},'BBB-1','回答',{questionId:1}).answered[0]!.answer).toBe('回答');
  expect(markNotificationsRead({db,actor:'me'},{ids:[1]}).updated).toBe(1);
  expect(updateProject({db,actor:'me'},'1',{status:'started'}).status).toBe('started');
  expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  db.close();
});

test('移行中の外部キー検査失敗は版とschemaと保存原本を原子的に巻き戻す',()=>{
  const path=legacyFixture();
  const old=new Database(path);
  old.query("INSERT INTO questions(issue_id,question,asked_by,asked_at) VALUES(999,'不整合fixture','me','2026-01-01')").run();
  const tables=['cycles','cycle_cadence','issues','events','questions'];
  const before=tables.map(t=>old.query(`SELECT * FROM ${t}`).all());
  old.close();
  expect(()=>openDb(path)).toThrow('Sprint移行後の外部キー整合性検査に失敗しました');
  const rolledBack=new Database(path,{readonly:true});
  expect(rolledBack.query('PRAGMA user_version').get()).toEqual({user_version:42});
  expect(tables.map(t=>rolledBack.query(`SELECT * FROM ${t}`).all())).toEqual(before);
  expect(rolledBack.query("SELECT name FROM sqlite_master WHERE name='sprints'").all()).toEqual([]);
  rolledBack.close();
});
