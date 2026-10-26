import type { Database } from "bun:sqlite";

// 取得できた原本だけを移し、旧暦日や過去イベントを現在の状態から補完しない。
export function importSprintHistory(db: Database): void {
  const capturedAt = new Date().toISOString();
  db.exec(`CREATE TABLE sprint_migration_source(id INTEGER PRIMARY KEY CHECK(id=1), snapshot TEXT NOT NULL);
  CREATE TABLE sprints (
    id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE CHECK(number>0),
    workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
    name TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('imported','draft','ready','active','ended','canceled')),
    start_date TEXT NOT NULL, end_date TEXT NOT NULL, timezone TEXT,
    starts_at TEXT, ends_at TEXT, adopted_plan_id TEXT,
    goal TEXT, definition_of_done TEXT, outcome TEXT,
    legacy_cycle_id INTEGER UNIQUE, legacy_data TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    CHECK(phase='imported' OR (workspace_id IS NOT NULL AND timezone IS NOT NULL)),
    CHECK(start_date<=end_date)
  );
  CREATE UNIQUE INDEX sprints_active_workspace ON sprints(workspace_id) WHERE phase='active';
  CREATE TABLE sprint_number_sequence(id INTEGER PRIMARY KEY CHECK(id=1), next_number INTEGER NOT NULL CHECK(next_number>0));
  CREATE TABLE sprint_items(
    id TEXT PRIMARY KEY, sprint_id TEXT NOT NULL REFERENCES sprints(id) ON DELETE RESTRICT,
    issue_id INTEGER REFERENCES issues(id) ON DELETE SET NULL,
    source_issue_key TEXT NOT NULL, snapshot TEXT NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN ('imported','candidate')),
    UNIQUE(sprint_id,source_issue_key)
  );
  CREATE TABLE sprint_legacy_issue_evidence(
    sprint_id TEXT NOT NULL REFERENCES sprints(id) ON DELETE RESTRICT,
    source_issue_id INTEGER NOT NULL, source_issue_key TEXT NOT NULL, snapshot TEXT NOT NULL,
    PRIMARY KEY(sprint_id,source_issue_id)
  );
  CREATE TABLE sprint_plans(
    id TEXT PRIMARY KEY, sprint_id TEXT NOT NULL REFERENCES sprints(id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL, content_hash TEXT NOT NULL,
    agreed_by TEXT, agreed_at TEXT, agreed_hash TEXT,
    UNIQUE(sprint_id,revision), UNIQUE(sprint_id,id)
  );
  CREATE TABLE sprint_plan_items(
    plan_id TEXT NOT NULL REFERENCES sprint_plans(id) ON DELETE RESTRICT,
    item_id TEXT NOT NULL REFERENCES sprint_items(id) ON DELETE RESTRICT,
    PRIMARY KEY(plan_id,item_id)
  );
  CREATE TRIGGER sprint_plan_item_scope BEFORE INSERT ON sprint_plan_items
    WHEN (SELECT sprint_id FROM sprint_plans WHERE id=NEW.plan_id) <> (SELECT sprint_id FROM sprint_items WHERE id=NEW.item_id)
    BEGIN SELECT RAISE(ABORT,'Sprintの異なるitemは採択できません'); END;
  CREATE TABLE sprint_legacy_refs(
    cycle_id INTEGER PRIMARY KEY, sprint_id TEXT REFERENCES sprints(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK(kind IN ('imported','deleted')),
    CHECK((kind='imported' AND sprint_id IS NOT NULL) OR (kind='deleted' AND sprint_id IS NULL))
  );
  CREATE TABLE sprint_legacy_events(
    event_id INTEGER PRIMARY KEY, original TEXT NOT NULL
  );
  CREATE TABLE sprint_legacy_event_refs(
    event_id INTEGER NOT NULL REFERENCES sprint_legacy_events(event_id),
    cycle_id INTEGER NOT NULL REFERENCES sprint_legacy_refs(cycle_id),
    association TEXT NOT NULL CHECK(association IN ('recorded','ambiguous')),
    PRIMARY KEY(event_id,cycle_id)
  );`);
  const cycles = db.query('SELECT * FROM cycles ORDER BY id').all() as Record<string, any>[];
  const cadence = db.query('SELECT * FROM cycle_cadence WHERE id=1').get();
  const sequence = db.query("SELECT seq FROM sqlite_sequence WHERE name='cycles'").get() as {seq:number}|null;
  db.query('INSERT INTO sprint_migration_source VALUES(1,?)').run(JSON.stringify({schemaVersion:1,capturedAt,cadence,cycleSequence:sequence}));
  const next = Math.max(0, sequence?.seq ?? 0, ...cycles.map(c=>c.id), ((cadence as {next_number:number}|null)?.next_number ?? 1)-1)+1;
  db.query('INSERT INTO sprint_number_sequence VALUES(1,?)').run(next);
  const byId = new Map<number,Record<string,any>>();
  const events = db.query('SELECT * FROM events ORDER BY id').all() as {id:number;issue_id:number;actor:string;type:string;data:string;created_at:string}[];
  const issueRefs = new Map<number,Set<number>>();
  const explicitRefs = (event: typeof events[number]): Set<number> => {
    const data=JSON.parse(event.data);
    const values=event.type==='created' ? [data.cycle_id] : event.type==='cycle_changed' ? [data.from_id,data.to_id] : [];
    return new Set(values.filter(v=>Number.isSafeInteger(v) && v>0));
  };
  const issues = db.query('SELECT * FROM issues ORDER BY id').all() as Record<string,any>[];
  const snapshots = new Map<number,{sourceIssueKey:string;snapshot:string}>();
  for (const issue of issues) {
    if (issue.cycle_id != null) issueRefs.set(issue.id,new Set([issue.cycle_id]));
    const workspace=db.query('SELECT id,key,name FROM workspaces WHERE id=?').get(issue.workspace_id) as {id:number;key:string;name:string}|null;
    if (!workspace) throw new Error('移行元IssueのWorkspaceがありません');
    const labels=(db.query('SELECT label FROM issue_labels WHERE issue_id=? ORDER BY label').all(issue.id) as {label:string}[]).map(r=>r.label);
    const project=issue.project_id == null ? null : db.query('SELECT * FROM projects WHERE id=?').get(issue.project_id);
    snapshots.set(issue.id,{sourceIssueKey:`${workspace.key}-${issue.number}`,snapshot:JSON.stringify({schemaVersion:1,capturedAt,statusBasis:'migration_snapshot',workspace,issue,labels,project})});
  }
  for (const event of events) {
    const refs=issueRefs.get(event.issue_id) ?? new Set<number>();
    for (const ref of explicitRefs(event)) refs.add(ref);
    if (refs.size) issueRefs.set(event.issue_id,refs);
  }
  for (const cycle of cycles) {
    const id = crypto.randomUUID();
    byId.set(cycle.id,cycle);
    db.query(`INSERT INTO sprints(id,number,name,phase,start_date,end_date,legacy_cycle_id,legacy_data,created_at,updated_at)
      VALUES(?,?,?,'imported',?,?,?,?,?,?)`).run(id,cycle.id,cycle.name,cycle.start_date,cycle.end_date,cycle.id,
      JSON.stringify({schemaVersion:1,cycle,cadence,capturedAt,statusBasis:'migration_snapshot'}),cycle.created_at,cycle.updated_at);
    db.query("INSERT INTO sprint_legacy_refs VALUES(?,?,'imported')").run(cycle.id,id);
    for (const issue of issues) {
      const evidence=snapshots.get(issue.id)!;
      if (issue.cycle_id===cycle.id) db.query("INSERT INTO sprint_items VALUES(?,?,?,?,?,'imported')")
        .run(crypto.randomUUID(),id,issue.id,evidence.sourceIssueKey,evidence.snapshot);
      if (issueRefs.get(issue.id)?.has(cycle.id)) db.query('INSERT INTO sprint_legacy_issue_evidence VALUES(?,?,?,?)')
        .run(id,issue.id,evidence.sourceIssueKey,evidence.snapshot);
    }
  }
  for (const event of events) {
    const refs=issueRefs.get(event.issue_id);
    if (!refs?.size) continue;
    db.query('INSERT INTO sprint_legacy_events VALUES(?,?)').run(event.id,JSON.stringify(event));
    const explicit=explicitRefs(event);
    for (const ref of refs) {
      if (!byId.has(ref)) db.query("INSERT OR IGNORE INTO sprint_legacy_refs VALUES(?,NULL,'deleted')").run(ref);
      const cycle=byId.get(ref);
      // 当時の明示IDがあり、現行レコード作成後の記録だけを確定関連とする。
      // 現在所属やIssue全体の履歴から収集した根拠は当時の所属を確定しない。
      const association=explicit.has(ref) && cycle && Date.parse(event.created_at)>=Date.parse(cycle.created_at) ? 'recorded' : 'ambiguous';
      db.query('INSERT INTO sprint_legacy_event_refs VALUES(?,?,?)').run(event.id,ref,association);
    }
  }
  db.exec(`CREATE TRIGGER sprints_number_floor BEFORE INSERT ON sprints
    WHEN NEW.number < (SELECT next_number FROM sprint_number_sequence WHERE id=1)
    BEGIN SELECT RAISE(ABORT,'Sprint番号は再利用できません'); END;
    CREATE TRIGGER sprints_number_advance AFTER INSERT ON sprints
    BEGIN UPDATE sprint_number_sequence SET next_number=MAX(next_number,NEW.number+1) WHERE id=1; END;
    CREATE TRIGGER sprints_number_immutable BEFORE UPDATE OF number ON sprints WHEN NEW.number<>OLD.number
    BEGIN SELECT RAISE(ABORT,'Sprint番号は変更できません'); END;`);
  // 対応しない参照を明示値として保存し、検索範囲を広げない。
  const mapping = db.query('SELECT r.cycle_id,s.id,s.name FROM sprint_legacy_refs r JOIN sprints s ON s.id=r.sprint_id').all() as {cycle_id:number;id:string;name:string}[];
  const displayOf = (raw:string) => {
    const d=JSON.parse(raw);
    for(const key of ['groupBy','subGroupBy']) if(d[key]==='cycle') d[key]='sprint';
    return JSON.stringify(d);
  };
  for(const view of db.query('SELECT id,filter,display FROM views').all() as {id:number;filter:string;display:string}[]) {
    const f=JSON.parse(view.filter);
    if('cycle' in f) {
      const ref=String(f.cycle).trim();
      f.sprint = ['current','none'].includes(ref.toLowerCase()) ? ref.toLowerCase() :
        mapping.find(m=> /^\d+$/.test(ref) ? m.cycle_id===Number(ref) : m.name===ref)?.id ?? `legacy-cycle:${ref}`;
      delete f.cycle;
    }
    db.query('UPDATE views SET filter=?,display=? WHERE id=?').run(JSON.stringify(f),displayOf(view.display),view.id);
  }
  for(const page of db.query('SELECT page,display FROM page_displays').all() as {page:string;display:string}[]) {
    const m=/^cycle:(\d+)$/.exec(page.page);
    const mapped=m && mapping.find(r=>r.cycle_id===Number(m[1]));
    db.query('UPDATE page_displays SET page=?,display=? WHERE page=?').run(mapped ? `sprint:${mapped.id}` : page.page,displayOf(page.display),page.page);
  }
  // 実効SQLiteでは索引を外すとFK列もDROP COLUMNできる。再構築せず参照先のissuesを保つ。
  db.exec('DROP INDEX issues_cycle; ALTER TABLE issues DROP COLUMN cycle_id; DROP TABLE cycles; DROP TABLE cycle_cadence');
  if (db.query('PRAGMA foreign_key_check').all().length) throw new Error('Sprint移行後の外部キー整合性検査に失敗しました');
}
