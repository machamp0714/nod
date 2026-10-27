import type { Database } from "bun:sqlite";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, startIssue } from "../../../../../packages/core/src";

type FixtureIssue = "API-1" | "API-2";
type Row = Record<string, string | number | null>;
type StartFixture = { evaluationOnly: true; before: Row; after: Row; events: Row[] };
const issueRow = (db: Database, ref: FixtureIssue) => db.query(`SELECT i.* FROM issues i
  JOIN workspaces w ON w.id=i.workspace_id WHERE w.key || '-' || i.number=?`).get(ref) as Row;

/** 採択前の実core操作の写し。保存後はrollbackし、実行許可や架空の試行を作らない。 */
export function captureWorkerStartFixture(db: Database, directory: string, ref: FixtureIssue): void {
  const before = issueRow(db, ref);
  const last = db.query("SELECT COALESCE(MAX(id),0) AS id FROM events").get() as { id: number };
  db.exec("SAVEPOINT pm_worker_fixture");
  try {
    startIssue({ db, actor: "codex" }, ref);
    const fixture: StartFixture = {
      evaluationOnly: true, before, after: issueRow(db, ref),
      events: db.query("SELECT issue_id,actor,type,data,created_at FROM events WHERE id>? ORDER BY id").all(last.id) as Row[],
    };
    writeFileSync(join(directory, `${ref}-worker-fixture.json`), JSON.stringify(fixture));
  } finally {
    db.exec("ROLLBACK TO pm_worker_fixture; RELEASE pm_worker_fixture");
  }
}

/** 偽Orcaだけが使う評価データの配置。nod startは常に実CLIへ渡し、S02では拒否される。 */
export function installWorkerStartFixture(directory: string, ref: string): void {
  if (ref !== "API-1" && ref !== "API-2") throw new Error("評価対象外のIssueです");
  const db = openDb(join(directory, "nod.db"));
  try {
    db.transaction(() => {
      const row = issueRow(db, ref);
      // 既存実行はそのまま保持し、同actorの通常startへ戻さない。
      if (row.status === "in_progress" && row.assignee === "codex") return;
      const fixture: StartFixture = JSON.parse(readFileSync(join(directory, `${ref}-worker-fixture.json`), "utf8"));
      if (!fixture.evaluationOnly || JSON.stringify(row) !== JSON.stringify(fixture.before)) {
        throw new Error("採択前の評価fixtureと現在のIssueが一致しません");
      }
      const after = fixture.after;
      db.query(`UPDATE issues SET status=?,assignee=?,agent_state=?,started_at=?,closed_at=?,updated_at=? WHERE id=?`)
        .run(after.status!, after.assignee!, after.agent_state!, after.started_at!, after.closed_at!, after.updated_at!, row.id!);
      for (const event of fixture.events) db.query("INSERT INTO events(issue_id,actor,type,data,created_at) VALUES(?,?,?,?,?)")
        .run(event.issue_id!, event.actor!, event.type!, event.data!, event.created_at!);
      appendFileSync(join(directory, "operations.jsonl"), JSON.stringify({
        tool: "fixture", argv: ["worker-start-state", ref], actor: "codex", origin: "worker", simulated: true,
        note: "評価専用の状態再現。S02の実行許可・nod start成功を表さない", at: new Date().toISOString(),
      }) + "\n");
    }).immediate();
  } finally {
    db.close();
  }
}
