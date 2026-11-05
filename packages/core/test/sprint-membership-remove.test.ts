import { expect, test } from "bun:test";
import * as core from "../src/index";
import { codeOf, setup } from "./helpers";

function draft() {
  const f = setup();
  core.configureScrumWorkspace(f.me, f.ws.key, { expectedVersion: 0, requestKey: "設定", enabled: true, problem: "誤って入れた", productGoal: "所属を整理する", priorityRationale: "整理を優先" });
  const sprint = core.createSprint(f.llm, { startDate: "2026-03-08", endDate: "2026-03-08", timezone: "Asia/Tokyo", workspaceKey: f.ws.key, expectedVersion: 0, requestKey: "作成" });
  return { ...f, sprint };
}
const removals = (db: import("bun:sqlite").Database, ref: string) => core.getIssue(db, ref).activity
  .filter((a: any) => a.kind === "event" && a.type === "sprint_removed").map((a: any) => [a.actor, a.data]);

test("LLMは追加の記録だけを外し、同じitemを残して結果で外したかを返す。再送と所属でないIssueは何も書かない", () => {
  const { db, ws, me, llm, sprint } = draft();
  try {
    const issue = core.createIssue(me, { workspaceId: ws.id, title: "誤って入れた" });
    const added = core.addIssueToSprint(llm, sprint.id, { issueRef: issue.id });
    const removed = core.removeIssueFromSprint(llm, String(sprint.number), { issueRef: issue.id });
    expect(removed).toEqual({ sprint, removed: true,
      item: { ...added.item, addedBy: null, addedAt: null, member: false, association: null } });
    expect(core.getIssue(db, issue.id).sprints).toEqual([]);
    expect(removals(db, issue.id)).toEqual([[llm.actor, { sprintId: sprint.id, sprintNumber: sprint.number, sprintName: sprint.name }]]);

    expect(core.removeIssueFromSprint(llm, sprint.id, { issueRef: issue.id })).toEqual({ ...removed, removed: false });
    const outside = core.createIssue(me, { workspaceId: ws.id, title: "所属したことがない" });
    expect(core.removeIssueFromSprint(llm, sprint.id, { issueRef: outside.id })).toEqual({ sprint, item: null, removed: false });
    expect(removals(db, issue.id)).toHaveLength(1);
    expect(removals(db, outside.id)).toEqual([]);
    expect(core.getSprint(db, sprint.id).version).toBe(sprint.version);
  } finally { db.close(); }
});

test("未知のキー・採択の所属・閉じたSprint・アーカイブ済み・別Workspaceを拒否し、何も書かない", () => {
  const { db, ws, me, llm, sprint } = draft();
  try {
    const issue = core.createIssue(me, { workspaceId: ws.id, title: "採択する" });
    const added = core.addIssueToSprint(llm, sprint.id, { issueRef: issue.id });
    for (const input of [{ issueRef: issue.id, actor: "me" }, { issueRef: issue.id, expectedVersion: sprint.version }, {}, { issueRef: "" }]) {
      expect(codeOf(() => core.removeIssueFromSprint(llm, sprint.id, input as { issueRef: string }))).toBe("INVALID_ARGS");
    }
    const proposed = core.proposeSprintPlan(llm, sprint.id, { expectedVersion: added.sprint.version, requestKey: "計画", goal: "整理する", verificationMethod: "再取得",
      items: [{ itemId: added.item.id, contribution: "整理", executionPlan: "順に" }], definitionOfDone: [{ id: "確認", text: "所属を確認" }],
      constraints: { executionScope: "Workspace", notes: "既存権限" }, changeReason: "最初の計画" });
    core.acceptSprintPlan(me, sprint.id, proposed.plan.id, { expectedVersion: proposed.sprint.version, requestKey: "合意", contentHash: proposed.plan.contentHash });
    const before = [core.getSprint(db, sprint.id), core.getIssue(db, issue.id)];
    // 追加の記録が重なっていても、採用中の合意済み計画の項目は人も外せない。
    for (const ctx of [llm, me]) expect(codeOf(() => core.removeIssueFromSprint(ctx, sprint.id, { issueRef: issue.id }))).toBe("INVALID_STATE");
    expect([core.getSprint(db, sprint.id), core.getIssue(db, issue.id)]).toEqual(before);

    const other = core.initWorkspace(db, { path: "/tmp/repos/other-ws" }).workspace;
    expect(codeOf(() => core.removeIssueFromSprint(llm, sprint.id, { issueRef: core.createIssue(me, { workspaceId: other.id, title: "別" }).id }))).toBe("INVALID_ARGS");
    const archived = core.createIssue(me, { workspaceId: ws.id, title: "アーカイブ済み" });
    core.addIssueToSprint(llm, sprint.id, { issueRef: archived.id });
    core.archiveIssue(me, archived.id);
    expect(codeOf(() => core.removeIssueFromSprint(llm, sprint.id, { issueRef: archived.id }))).toBe("ISSUE_ARCHIVED");
    expect(core.getIssue(db, archived.id).sprints.map(s => s.association)).toEqual(["added"]);

    const current = core.getSprint(db, sprint.id);
    core.cancelSprint(me, sprint.id, { expectedVersion: current.version, requestKey: "中止", reason: "取りやめ" });
    const extra = core.createIssue(me, { workspaceId: ws.id, title: "閉じたSprint" });
    expect(codeOf(() => core.removeIssueFromSprint(llm, sprint.id, { issueRef: extra.id }))).toBe("INVALID_STATE");
    expect(codeOf(() => core.removeIssueFromSprint(llm, "999", { issueRef: extra.id }))).toBe("NOT_FOUND");
  } finally { db.close(); }
});
