import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { describeEvent } from "../src/activity-text";
import { openDb } from "../src/db";
import { createIssue, getIssue } from "../src/ops/issues";
import { listNotifications } from "../src/ops/notifications";
import { getRecurringIssue } from "../src/ops/recurring";
import { getSprintExecutionState } from "../src/ops/sprint-execution";
import { addIssueToSprint } from "../src/ops/sprint-planning";
import { getSprint, getUnresolvedSprintHistory } from "../src/ops/sprints";
import { listTriageProposals } from "../src/ops/triage-proposals";
import { MIGRATIONS } from "../src/schema";
import type { SprintExistingOwnership, SprintSession } from "../src/sprint-execution-types";
import type { SprintPlanContent } from "../src/sprint-types";
import { sprintHash } from "../src/sprint-validation";
import { tempDbPath } from "./helpers";

const description = '本文に書いた JSON {"assignee":"この文字列は保持"}';
const replayInput = { expectedVersion: 1, requestKey: "old-request", name: "再送" };
const plan: SprintPlanContent = {
  schemaVersion: 1, goal: "旧計画", verificationMethod: "確認",
  period: { startDate: "2026-01-15", endDate: "2026-01-28", timezone: "UTC",
    startsAt: "2026-01-15T00:00:00.000Z", endsAt: "2026-01-29T00:00:00.000Z", workingDays: [1, 2, 3, 4, 5] },
  items: [{ itemId: "candidate", contribution: "準備", executionPlan: "実装", requirement: { title: "旧Issue", description } }],
  definitionOfDone: [{ id: "check", text: "確認済み" }],
  constraints: { executionScope: "ローカル", notes: "設定を保持" },
};
const planHash = sprintHash(plan);

function version54Fixture(path: string): void {
  using db = new Database(path);
  for (const [index, migration] of MIGRATIONS.slice(0, 54).entries()) {
    if (index === 42) {
      db.exec(`INSERT INTO workspaces (id,key,name,path,next_number,created_at,color)
        VALUES (1,'API','元Workspace','/api',2,'2026-01-01','#123456');
        INSERT INTO cycles (id,name,start_date,end_date,created_by,created_at,updated_at)
          VALUES (1,'旧Cycle','2026-01-01','2026-01-14','me','2026-01-01','2026-01-01');`);
      db.query(`INSERT INTO issues (id,workspace_id,number,title,description,status,cycle_id,assignee,created_by,created_at,updated_at)
        VALUES (1,1,1,'旧Issue',?,'triage',1,'codex','me','2026-01-01','2026-01-01')`).run(description);
      db.exec(`INSERT INTO events (id,issue_id,actor,type,data,created_at) VALUES
        (1,1,'me','assignee_changed','{"from":null,"to":"codex"}','2026-01-02'),
        (2,1,'me','agent_state_changed','{"from":null,"to":"working","agent":"codex"}','2026-01-03'),
        (3,1,'me','cycle_changed','{"to":"名前だけのCycle"}','2026-01-04');
        INSERT INTO notifications (id,recipient,issue_id,kind,event_type,event_id,actor,data,created_at)
          VALUES (1,'me',1,'activity','assignee_changed',1,'me','{"from":null,"to":"codex"}','2026-01-02');`);
    }
    for (const step of migration) {
      if (typeof step === "string") db.exec(step);
      else step(db);
    }
  }
  db.exec(`PRAGMA user_version = 54;
    INSERT INTO recurring_issues (id,workspace_id,title,assignee,cadence,start_date,time_zone,created_by,created_at,updated_by,updated_at)
      VALUES (1,1,'定期Issue','claude-code','daily','2026-01-01','UTC','me','2026-01-01','me','2026-01-01');
    INSERT INTO triage_proposals (issue_id,actor,decision,labels,assignee,created_at,updated_at)
      VALUES (1,'claude-code','accept','["keep"]','codex','2026-01-01','2026-01-01');
    INSERT INTO sprints (id,number,workspace_id,name,phase,start_date,end_date,timezone,created_at,updated_at)
      VALUES ('draft',2,1,'新Sprint','draft','2026-01-15','2026-01-28','UTC','2026-01-01','2026-01-01');
    INSERT INTO sprint_items (id,sprint_id,issue_id,source_issue_key,snapshot,origin,added_by,added_at)
      SELECT 'candidate','draft',issue_id,source_issue_key,snapshot,'candidate','me','2026-01-01' FROM sprint_items WHERE origin='imported';`);
  db.query(`INSERT INTO sprint_plans (id,sprint_id,revision,content_hash,agreed_by,agreed_at,agreed_hash)
    VALUES ('plan','draft',1,?,'me','2026-01-01',?)`).run(planHash, planHash);
  db.query(`INSERT INTO sprint_plan_contents (plan_id,schema_version,content,change_reason,created_by,created_at)
    VALUES ('plan',1,?,'当初の計画','me','2026-01-01')`).run(JSON.stringify(plan));
  db.exec("INSERT INTO sprint_plan_items VALUES ('plan','candidate'); UPDATE sprints SET adopted_plan_id='plan' WHERE id='draft'");
  const retained: SprintExistingOwnership & { assignee: string } = {
    itemId: "candidate", issueId: 1, sourceIssueKey: "API-1", status: "in_progress",
    assignee: "codex", worktree: "/old", branch: "old-branch", observedAt: "2026-01-01",
    source: "採択Issueに保存された通常着手と実行場所",
    reason: { code: "EXISTING_EXECUTION_UNRECONCILED", message: "通常経路の所有と実行が未照合です" },
  };
  const session: SprintSession = {
    schemaVersion: 1, id: "session", sprintId: "draft", generation: 1, runId: "run-old",
    actor: "pm", caller: "coordinator", consumerGeneration: 1, runtimeId: "runtime-old",
    state: "active", requestKey: "old-session-request", inputHash: sprintHash({}),
    observedAt: "2026-01-01", source: "旧版の実行", handover: null,
    planId: "plan", planHash, unreconciledOwnership: [retained],
  };
  db.query("INSERT INTO sprint_sessions VALUES ('session','draft',1,?)").run(JSON.stringify(session));
  db.query(`INSERT INTO sprint_mutation_receipts VALUES ('draft','update',?,?,?,'2026-01-01')`).run(
    replayInput.requestKey, sprintHash({ actor: "me", input: replayInput }),
    JSON.stringify({ name: "再送", items: [{ snapshot: { issue: { description, assignee: "codex" } } }] }),
  );
}

test("版54から担当の列とSprintの写しを消し、履歴・通知・実行情報を保持する", () => {
  const path = tempDbPath();
  version54Fixture(path);
  using db = openDb(path);
  for (const table of ["issues", "recurring_issues", "triage_proposals"]) {
    const columns = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
    expect(columns.map(({ name }) => name)).not.toContain("assignee");
  }

  const issue = getIssue(db, "API-1");
  const recurring = getRecurringIssue(db, "API", 1);
  const proposals = listTriageProposals(db, "API-1");
  const imported = getSprint(db, "1");
  const draft = getSprint(db, "draft");
  const unresolved = getUnresolvedSprintHistory(db);
  const execution = getSprintExecutionState(db, "draft");
  // 旧版の結果は現在のSprint戻り型へ読み替えず、保存済みJSONとして検証する。
  const receipt = db.query("SELECT result FROM sprint_mutation_receipts WHERE request_key = ?").get(replayInput.requestKey) as { result: string };
  const replay: unknown = JSON.parse(receipt.result);
  expect(issue.description).toBe(description);
  expect(recurring.title).toBe("定期Issue");
  expect(proposals).toMatchObject([{ actor: "claude-code", labels: ["keep"] }]);
  for (const snapshot of [imported.items[0]?.snapshot, draft.items[0]?.snapshot, imported.evidence[0]?.snapshot, unresolved.issues[0]?.snapshot]) {
    expect(snapshot?.issue.description).toBe(description);
  }
  expect(execution.unreconciledOwnership).toEqual([{
    itemId: "candidate", issueId: 1, sourceIssueKey: "API-1", status: "in_progress", worktree: "/old", branch: "old-branch",
    observedAt: "2026-01-01", source: "採択Issueに保存された通常着手と実行場所",
    reason: { code: "EXISTING_EXECUTION_UNRECONCILED", message: "通常経路の所有と実行が未照合です" },
  }]);
  expect(execution.occupied).toBe(1);
  expect(execution.session).toMatchObject({ actor: "pm", planHash });
  expect(replay).toEqual({ name: "再送", items: [{ snapshot: { issue: { description } } }] });
  expect(draft.plans).toMatchObject([{ content: plan, contentHash: planHash, agreedHash: planHash }]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

  const ctx = { db, actor: "me" };
  const created = createIssue(ctx, { workspaceId: 1, title: "新Issue" });
  const added = addIssueToSprint(ctx, "draft", { issueRef: created.id });
  const output = [issue, recurring, proposals, imported, draft, unresolved, execution, replay, created, added];
  const assigneeKeys: string[] = [];
  JSON.parse(JSON.stringify(output), (key, value: unknown) => {
    if (key === "assignee") assigneeKeys.push(key);
    return value;
  });
  expect(assigneeKeys).toEqual([]);

  const labels = { status: String, priority: String, agentState: String };
  const activity = issue.activity.flatMap(item => item.kind === "event" ? [describeEvent(item, labels)?.text] : []);
  expect(activity).toContain("me が担当者を なし から codex に変えた");
  expect(activity).toContain("me が codex の作業状況を working に変えた");
  expect(imported.events.map(event => event.original)).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "assignee_changed", data: '{"from":null,"to":"codex"}' }),
    expect.objectContaining({ type: "agent_state_changed", data: '{"from":null,"to":"working","agent":"codex"}' }),
  ]));
  expect(listNotifications(db)).toMatchObject([{ id: 1, eventType: "assignee_changed", actor: "me", data: { from: null, to: "codex" } }]);
});
