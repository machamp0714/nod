import { Database } from "bun:sqlite";
import { MIGRATIONS } from "../../src/schema";

// 製品に合意・開始操作を先行公開せず、公開読取を検証するための内部fixture。
export function legacySprintFixture(path: string): void {
  const db = new Database(path);
  for (const migration of MIGRATIONS.slice(0,42)) for (const step of migration) {
    if (typeof step === "string") db.exec(step); else step(db);
  }
  db.exec(`PRAGMA user_version=42;
    INSERT INTO workspaces(id,key,name,path,color,created_at,next_number) VALUES
      (1,'AAA','元A','/tmp/AAA','#123456','2026-01-01',3),(2,'BBB','元B','/tmp/BBB','#654321','2026-01-01',2);
    INSERT INTO cycles(id,name,start_date,end_date,created_by,created_at,updated_at) VALUES
      (1,'過去','2026-01-01','2026-01-14','me','2026-01-01','2026-01-01'),
      (2,'現在だった期間','2026-10-20','2026-11-02','me','2026-10-01','2026-10-01'),
      (3,'未来','2999-01-01','2999-01-14','me','2026-10-01','2026-10-01'),
      (4,'空','2999-02-01','2999-02-14','me','2026-10-01','2026-10-01');
    INSERT INTO cycle_cadence VALUES(1,2,1,'2026-01-01',5,'me','2026-10-01');
    INSERT INTO issues(id,workspace_id,number,title,status,cycle_id,created_by,created_at,updated_at,closed_at) VALUES
      (1,1,1,'移行時は完了','done',1,'me','2026-01-01','2026-10-01','2026-10-01T03:00:00.000Z'),
      (2,2,1,'別Workspace','todo',1,'me','2026-01-01','2026-10-01',NULL),
      (3,1,2,'所属なし','todo',NULL,'me','2026-01-01','2026-10-01',NULL);
    INSERT INTO events(id,issue_id,actor,type,data,created_at) VALUES
      (1,1,'me','created','{"cycle_id":1,"status":"todo"}','2026-01-01T03:00:00.000Z'),
      (2,1,'me','status_changed','{"from":"todo","to":"done"}','2026-10-01T03:00:00.000Z'),
      (3,2,'me','created','{"cycle_id":1,"status":"todo"}','2026-01-02T03:00:00.000Z'),
      (4,3,'me','cycle_changed','{"from_id":99,"to_id":null}','2025-01-01T03:00:00.000Z');`);
  db.close();
}

export function addActiveSprint(db: Database, workspaceId: number, number: number, issueRefs: string[]): string {
  const id=crypto.randomUUID();
  const plan=crypto.randomUUID();
  db.query(`INSERT INTO sprints(id,number,workspace_id,name,phase,start_date,end_date,timezone,starts_at,ends_at,adopted_plan_id,created_at,updated_at)
    VALUES(?,?,?,?,'active','2000-01-01','2999-01-01','UTC','2000-01-01T00:00:00.000Z','2999-01-01T00:00:00.000Z',?,'2026-01-01','2026-01-01')`).run(id,number,workspaceId,`実行 ${number}`,plan);
  db.query("INSERT INTO sprint_plans VALUES(?,?,1,'合意hash','me','2026-01-01','合意hash')").run(plan,id);
  for(const ref of issueRefs) {
    const issue=db.query("SELECT i.id FROM issues i JOIN workspaces w ON w.id=i.workspace_id WHERE w.key || '-' || i.number=?").get(ref) as {id:number};
    const item=crypto.randomUUID();
    db.query("INSERT INTO sprint_items VALUES(?,?,?,?,?,'candidate')").run(item,id,issue.id,ref,'{}');
    db.query('INSERT INTO sprint_plan_items VALUES(?,?)').run(plan,item);
  }
  return id;
}
