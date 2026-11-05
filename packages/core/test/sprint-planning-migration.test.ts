import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { addIssueToSprint, getIssue, getSprint, listSprints, nextSprintNumber, openDb, queryIssues, resolveLegacyCycle } from "../src/index";
import { MIGRATIONS } from "../src/schema";
import { legacySprintFixture } from "./fixtures/sprint";
import { tempDbPath } from "./helpers";

test("版43のSprint移行履歴を版44へ欠落なく移し、対応IDと共通採番を維持する", () => {
  const path = tempDbPath(); legacySprintFixture(path);
  const old = new Database(path);
  for (const step of MIGRATIONS[42]!) { if (typeof step === "string") old.exec(step); else step(old); }
  old.exec("PRAGMA user_version=43");
  const originals = old.query("SELECT * FROM sprints ORDER BY number").all() as {id:string;number:number;legacy_cycle_id:number;legacy_data:string}[];
  const snapshots = old.query("SELECT snapshot FROM sprint_items ORDER BY source_issue_key").all() as {snapshot:string}[];
  old.close();
  const db = openDb(path);
  expect(listSprints(db).map(s=>[s.id,s.number,s.phase])).toEqual(originals.map(s=>[s.id,s.number,"imported"]));
  for (const original of originals) {
    expect(getSprint(db,original.id).legacy).toEqual(JSON.parse(original.legacy_data));
    expect(resolveLegacyCycle(db,original.legacy_cycle_id)).toEqual({kind:"imported",sprintId:original.id});
  }
  expect(getSprint(db,originals[0]!.id).items.map(i=>i.snapshot)).toEqual(snapshots.map(r=>JSON.parse(r.snapshot)));
  expect(nextSprintNumber(db)).toBe(5);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.query("PRAGMA integrity_check").get()).toEqual({integrity_check:"ok"});
  db.close();
});

test("版50の候補だけのitemを版51で所属にせず、写しと計画の参照を保ったまま、追加で同じitemを所属にする", () => {
  const path = tempDbPath();
  const old = new Database(path);
  for (const migration of MIGRATIONS.slice(0, 50)) for (const step of migration) { if (typeof step === "string") old.exec(step); else step(old); }
  old.exec(`PRAGMA user_version=50;
    INSERT INTO workspaces(id,key,name,path,color,created_at,next_number) VALUES(1,'AAA','元A','/tmp/AAA','#123456','2026-01-01',2);
    INSERT INTO issues(id,workspace_id,number,title,status,created_by,created_at,updated_at) VALUES(1,1,1,'旧候補','todo','me','2026-10-01','2026-10-01');
    INSERT INTO sprints(id,number,workspace_id,name,phase,start_date,end_date,timezone,starts_at,ends_at,created_at,updated_at,version,working_days,workspace_snapshot)
      VALUES('sprint-1',1,1,'Sprint 1','draft','2026-10-30','2026-10-30','Asia/Tokyo','2026-10-29T15:00:00.000Z','2026-10-30T15:00:00.000Z','2026-10-01','2026-10-01',3,'[1,2,3,4,5]','{"id":1,"key":"AAA","name":"元A"}');
    UPDATE sprint_number_sequence SET next_number=2;
    INSERT INTO sprint_items VALUES('item-1','sprint-1',1,'AAA-1','{"schemaVersion":1,"capturedAt":"2026-10-01","statusBasis":"candidate_snapshot","labels":[],"project":null,"workspace":{"id":1,"key":"AAA","name":"元A"},"issue":{"id":1,"title":"旧候補","description":null,"status":"todo"}}','candidate');
    INSERT INTO sprint_plans(id,sprint_id,revision,content_hash) VALUES('plan-1','sprint-1',1,'未合意hash');
    INSERT INTO sprint_plan_contents(plan_id,schema_version,base_plan_id,content,change_reason,created_by,created_at) VALUES('plan-1',1,NULL,'{"items":[{"itemId":"item-1"}]}','提案','codex','2026-10-01');
    INSERT INTO sprint_plan_items VALUES('plan-1','item-1');`);
  const snapshot = (old.query("SELECT snapshot FROM sprint_items WHERE id='item-1'").get() as { snapshot: string }).snapshot;
  old.close();
  const db = openDb(path);
  try {
    const detail = getSprint(db, "sprint-1");
    expect(detail.items).toEqual([{ id: "item-1", sprintId: "sprint-1", issueId: 1, sourceIssueKey: "AAA-1", origin: "candidate", snapshot: JSON.parse(snapshot),
      addedBy: null, addedAt: null, rolloverFromItemId: null, member: false, association: null }]);
    expect(detail.plans.map(p => [p.id, p.content.items.map(item => item.itemId)])).toEqual([["plan-1", ["item-1"]]]);
    expect(queryIssues(db, { sprint: "sprint-1" }).issues).toEqual([]);
    expect(getIssue(db, "AAA-1").sprints).toEqual([]);
    const added = addIssueToSprint({ db, actor: "codex" }, "1", { issueRef: "AAA-1" });
    expect(added).toMatchObject({ added: true, sprint: { id: "sprint-1", version: 3 }, item: { id: "item-1", snapshot: JSON.parse(snapshot), addedBy: "codex", member: true, association: "added" } });
    expect(queryIssues(db, { sprint: "sprint-1" }).issues.map(i => i.id)).toEqual(["AAA-1"]);
    expect(getIssue(db, "AAA-1").sprints.map(s => [s.id, s.association])).toEqual([["sprint-1", "added"]]);
    expect(getSprint(db, "sprint-1").plans).toEqual(detail.plans);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});
