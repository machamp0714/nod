import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { openDb, SCHEMA_VERSION, schemaVersion } from "../src/db";
import { createCycle, deleteCycle, getCycle, listCycles, moveOpenIssues, resolveCycle, updateCycle } from "../src/ops/cycles";
import { createIssue, getIssue, queryIssues, updateIssue } from "../src/ops/issues";
import { listSprints, getSprint, nextSprintNumber } from "../src/ops/sprints";
import { bulkUpdateIssues } from "../src/ops/bulk-update";
import { MIGRATIONS } from "../src/schema";
import { codeOf, setup, tempDbPath } from "./helpers";

test("旧Cycleの読取と書込みは廃止案内を返し、通常Issueと保存データを変えない",()=>{
  const {db,ws,me,llm}=setup();
  const issue=createIssue(me,{workspaceId:ws.id,title:"通常Issue"});
  const tables=(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map(r=>r.name);
  const snapshot=()=>tables.map(table=>db.query(`SELECT * FROM ${table}`).all());
  const before=snapshot();
  for (const ctx of [me,llm]) for (const operation of [
    ()=>createCycle(ctx,{name:'旧Cycle',startDate:'2026-10-01',endDate:'2026-10-14'}),
    ()=>updateCycle(ctx,'1',{name:'変更'}),()=>deleteCycle(ctx,'1'),()=>moveOpenIssues(ctx,'1','2'),
    ()=>createIssue(ctx,{workspaceId:ws.id,title:'直接所属',cycleRef:'1'}),
    ()=>updateIssue(ctx,issue.id,{cycleRef:null,title:'巻き添え'}),
  ]) expect(codeOf(operation)).toBe('CYCLE_RETIRED');
  for (const ref of ['1','旧名','current','none']) {
    expect(codeOf(()=>queryIssues(db,{cycle:ref}))).toBe('CYCLE_RETIRED');
    expect(codeOf(()=>resolveCycle(db,ref))).toBe('CYCLE_RETIRED');
    expect(codeOf(()=>getCycle(db,ref))).toBe('CYCLE_RETIRED');
  }
  expect(codeOf(()=>listCycles(db))).toBe('CYCLE_RETIRED');
  expect(codeOf(()=>bulkUpdateIssues(me,[issue.id],{cycleRef:'1'}))).toBe('BULK_UPDATE_FAILED');
  expect(snapshot()).toEqual(before);
  expect(getIssue(db,issue.id).title).toBe('通常Issue');
  expect(updateIssue(me,issue.id,{title:'通常更新'}).title).toBe('通常更新');
  db.close();
});

test("Cycle の前の版の DB を移行しても既存の Issue を保ち、Cycle なしで始まる", () => {
  const before = MIGRATIONS.findIndex((steps) => steps.some((s) => typeof s === "string" && s.includes("CREATE TABLE cycles")));
  expect(before).toBeGreaterThan(0);
  const path = tempDbPath();
  const old = new Database(path, { create: true });
  old.exec("PRAGMA foreign_keys=ON");
  for (const [v, steps] of MIGRATIONS.slice(0, before).entries()) {
    for (const step of steps) {
      if (typeof step === "string") old.exec(step);
      else step(old);
    }
    old.exec(`PRAGMA user_version=${v + 1}`);
  }
  old.exec("INSERT INTO workspaces (id,key,name,path,next_number,created_at,color) VALUES (1,'API','api','/tmp/api',2,'2026-01-01','#3B82F6')");
  old.exec("INSERT INTO issues (id,workspace_id,number,title,status,created_by,created_at,updated_at) VALUES (1,1,1,'既存','todo','me','2026-01-01','2026-01-01')");
  old.close();

  const db = openDb(path);
  expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
  expect(getIssue(db, "API-1")).toMatchObject({ title: "既存", cycle: null });
  expect(listSprints(db)).toEqual([]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});

// Cycle を全体で1系列にするマイグレーション（cycle_cadence を作るもの）の手前まで適用し、Workspace 2つ（API・WEB）を足した DB を作る。既存の移行テストと同じ書き方
function beforeGlobalCycles(): { path: string; old: Database } {
  const before = MIGRATIONS.findIndex((steps) => steps.some((s) => typeof s === "string" && s.includes("CREATE TABLE cycle_cadence")));
  expect(before).toBeGreaterThan(0);
  const path = tempDbPath();
  const old = new Database(path, { create: true });
  old.exec("PRAGMA foreign_keys=ON");
  for (const [v, steps] of MIGRATIONS.slice(0, before).entries()) {
    for (const step of steps) {
      if (typeof step === "string") old.exec(step);
      else step(old);
    }
    old.exec(`PRAGMA user_version=${v + 1}`);
  }
  old.exec("INSERT INTO workspaces (id,key,name,path,next_number,created_at,color) VALUES (1,'API','api','/tmp/api',2,'2026-01-01','#3B82F6')");
  old.exec("INSERT INTO workspaces (id,key,name,path,next_number,created_at,color) VALUES (2,'WEB','web','/tmp/web',2,'2026-01-01','#10B981')");
  return { path, old };
}

function insertOldCycle(old: Database, id: number, workspaceId: number, name: string, start: string, end: string) {
  old
    .query("INSERT INTO cycles (id,workspace_id,name,start_date,end_date,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'me','2026-01-01','2026-01-01')")
    .run(id, workspaceId, name, start, end);
}

test("移行: 既存の Cycle の名前が Workspace 間で重なれば「名前 · キー」に改名し、Issue の所属を保つ。ID は使い回さない", () => {
  const { path, old } = beforeGlobalCycles();
  insertOldCycle(old, 1, 1, "Sprint 1", "2026-01-01", "2026-01-14");
  insertOldCycle(old, 2, 2, "Sprint 1", "2026-02-01", "2026-02-14");
  old.exec("INSERT INTO issues (id,workspace_id,number,title,status,cycle_id,created_by,created_at,updated_at) VALUES (1,2,1,'既存','todo',2,'me','2026-01-01','2026-01-01')");
  old.close();

  const db = openDb(path);
  expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
  expect(listSprints(db).map((c) => c.name)).toEqual(["Sprint 1", "Sprint 1 · WEB"]);
  expect(getIssue(db, "WEB-1").cycle).toBeNull();
  expect(getSprint(db, "2").items).toMatchObject([{sourceIssueKey:"WEB-1",snapshot:{workspace:{key:"WEB"},issue:{title:"既存"}}}]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  // 移した行の最大 ID から採番を続ける。消した Cycle の ID を新しい Cycle に使い回さないため
  expect(nextSprintNumber(db)).toBe(3);
  db.close();
});

test("移行: 「名前 · キー」が既存の名前と重なるなら、さらに ID を付けて一意にする", () => {
  const { path, old } = beforeGlobalCycles();
  insertOldCycle(old, 1, 1, "Sprint 1", "2026-01-01", "2026-01-14");
  insertOldCycle(old, 2, 1, "Sprint 1 · WEB", "2026-02-01", "2026-02-14");
  insertOldCycle(old, 3, 2, "Sprint 1", "2026-03-01", "2026-03-14");
  insertOldCycle(old, 4, 2, "Sprint 1 · WEB · 3", "2026-04-01", "2026-04-14");
  old.close();

  const db = openDb(path);
  expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
  const names = listSprints(db).map((c) => c.name);
  expect(names.slice(0, 2)).toEqual(["Sprint 1", "Sprint 1 · WEB"]);
  expect(names[2]).not.toBe("Sprint 1 · WEB");
  expect(names[2]!.startsWith("Sprint 1 · WEB · ")).toBe(true);
  expect(new Set(names).size).toBe(4);
  db.close();
});
