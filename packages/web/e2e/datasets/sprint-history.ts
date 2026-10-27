import { createIssue, createView } from "@nod/core";
import { addActiveSprint } from "../../../core/test/fixtures/sprint";
import type { Dataset } from "../support/dataset";
import { loadLegacySprintDataset } from "../support/legacy-sprint-dataset";

// 旧版の移行と内部採択fixtureを使う。製品へ開始・採択操作を追加しない。
const dataset: Dataset = ({ db, dir }) => {
  loadLegacySprintDataset({ db, dir });
  const ctx = { db, actor: "me" };
  const refs = ["AAA-1", "AAA-2"];
  for (const status of ["in_progress", "triage", "needs_clarification", "canceled", "backlog"]) {
    const issue = createIssue(ctx, { workspaceId: 1, title: `採択 ${status}` });
    db.query("UPDATE issues SET status=? WHERE workspace_id=1 AND number=?").run(status, Number(issue.id.split("-")[1]));
    refs.push(issue.id);
  }
  const currentA = addActiveSprint(db, 1, 12, refs);
  addActiveSprint(db, 2, 14, ["BBB-1"]);
  const candidate = createIssue(ctx, { workspaceId: 1, title: "候補のみ" });
  const candidateId = (db.query("SELECT id FROM issues WHERE workspace_id=1 AND number=?").get(candidate.number) as { id: number }).id;
  db.query("INSERT INTO sprint_items(id,sprint_id,issue_id,source_issue_key,snapshot,origin) VALUES(?,?,?,?,?,'candidate')").run(crypto.randomUUID(), currentA, candidateId, candidate.id, "{}");
  for (const [phase, number, title] of [["ended", 20, "終了Sprintのみ"], ["canceled", 21, "中止Sprintのみ"]] as const) {
    const issue = createIssue(ctx, { workspaceId: 1, title });
    db.query("UPDATE sprints SET phase='draft' WHERE id=?").run(currentA);
    const excluded = addActiveSprint(db, 1, number, [issue.id]);
    db.query("UPDATE sprints SET phase=? WHERE id=?").run(phase, excluded);
    db.query("UPDATE sprints SET phase='active' WHERE id=?").run(currentA);
  }
  createView(db, { name: "現在の全タスク", color: "#7C5CFF", filter: { sprint: "current" }, display: { groupBy: "status", columns: ["status", "workspace", "sprint"] } });
};

export default dataset;
