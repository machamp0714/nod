import { describe, expect, test } from "bun:test";
import { suggestIssue, nextIssue, startIssue, askQuestion } from "../src/ops/agent";
import { createIssue, relateIssue, updateIssue } from "../src/ops/issues";
import { initWorkspace } from "../src/ops/workspaces";
import { addProjectRow, codeOf, setup } from "./helpers";

describe("suggestIssue", () => {
  test("提案は全テーブルを変更せず、同順位の作成時刻・ID順と無優先度最後を維持する", () => {
    const { db, ws, me, llm } = setup();
    const none = createIssue(me, { workspaceId: ws.id, title: "なし" });
    const later = createIssue(me, { workspaceId: ws.id, title: "後", priority: 1 });
    const first = createIssue(me, { workspaceId: ws.id, title: "先", priority: 1 });
    const second = createIssue(me, { workspaceId: ws.id, title: "同時刻", priority: 1 });
    db.exec("UPDATE issues SET created_at = '2026-01-01T00:00:00.000Z'");
    db.query("UPDATE issues SET created_at = '2026-01-02T00:00:00.000Z' WHERE number = ?").run(later.number);
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
    const snapshot = () => tables.map(({ name }) => db.query(`SELECT * FROM "${name}" ORDER BY rowid`).all());
    const before = snapshot();
    expect(suggestIssue(llm, { workspaceId: ws.id })?.id).toBe(first.id);
    expect(suggestIssue(llm, { workspaceId: ws.id })?.id).toBe(first.id);
    expect(snapshot()).toEqual(before);
    expect([first, second, later, none].map(() => {
      const candidate = suggestIssue(llm, { workspaceId: ws.id });
      expect(nextIssue(llm, { workspaceId: ws.id })?.id).toBe(candidate?.id);
      return candidate?.id;
    })).toEqual([first.id, second.id, later.id, none.id]);
    expect(suggestIssue(llm, { workspaceId: ws.id })).toBeNull();
  });

  test("別Workspace・他担当・Triage・snooze・未回答・未完了ブロッカーを除外する", () => {
    const { db, ws, me, llm } = setup();
    const other = initWorkspace(db, { path: "/tmp/repos/other", key: "OTHER" }).workspace;
    createIssue(me, { workspaceId: other.id, title: "別Workspace", priority: 1 });
    createIssue(llm, { workspaceId: ws.id, title: "Triage" });
    const assigned = createIssue(me, { workspaceId: ws.id, title: "他担当" });
    updateIssue(me, assigned.id, { assignee: "codex" });
    const snoozed = createIssue(me, { workspaceId: ws.id, title: "後回し" });
    db.query("UPDATE issues SET snoozed_until = '2999-01-01T00:00:00.000Z' WHERE number = ? AND workspace_id = ?").run(snoozed.number, ws.id);
    const asked = createIssue(me, { workspaceId: ws.id, title: "未回答" });
    askQuestion(llm, asked.id, "どちら？");
    // todo に残っていても未回答の質問を除外する。
    db.query("UPDATE issues SET status = 'todo' WHERE number = ? AND workspace_id = ?").run(asked.number, ws.id);
    const blocker = createIssue(me, { workspaceId: ws.id, title: "ブロッカー" });
    updateIssue(me, blocker.id, { status: "backlog" });
    const blocked = createIssue(me, { workspaceId: ws.id, title: "ブロック中" });
    relateIssue(me, blocker.id, { blocks: blocked.id });
    expect(suggestIssue(llm, { workspaceId: ws.id })).toBeNull();
    updateIssue(me, blocker.id, { status: "done" });
    expect(suggestIssue(llm, { workspaceId: ws.id })?.id).toBe(blocked.id);
    nextIssue(llm, { workspaceId: ws.id });
    db.query("UPDATE issues SET snoozed_until = ? WHERE number = ? AND workspace_id = ?").run(new Date().toISOString(), snoozed.number, ws.id);
    expect(suggestIssue(llm, { workspaceId: ws.id })?.id).toBe(snoozed.id);
  });

  test("Project・自分の担当で絞り込み、不正Projectを拒否する", () => {
    const { db, ws, me, llm } = setup();
    addProjectRow(db, "検索");
    createIssue(me, { workspaceId: ws.id, title: "外", priority: 1 });
    const inside = createIssue(me, { workspaceId: ws.id, title: "中", projectRef: "検索" });
    updateIssue(me, inside.id, { assignee: llm.actor });
    expect(suggestIssue(llm, { workspaceId: ws.id, projectRef: "検索" })?.id).toBe(inside.id);
    expect(codeOf(() => suggestIssue(llm, { workspaceId: ws.id, projectRef: "不存在" }))).toBe("NOT_FOUND");
  });

  test("提案は予約せず、他actorのclaim後はstartが拒否しnextは次候補を取得する", () => {
    const { ws, me, llm } = setup();
    const first = createIssue(me, { workspaceId: ws.id, title: "先", priority: 1 });
    const second = createIssue(me, { workspaceId: ws.id, title: "次" });
    expect(suggestIssue(llm, { workspaceId: ws.id })?.id).toBe(first.id);
    nextIssue({ ...llm, actor: "codex" }, { workspaceId: ws.id });
    expect(codeOf(() => startIssue(llm, first.id))).toBe("ASSIGNED_TO_OTHER");
    expect(nextIssue(llm, { workspaceId: ws.id })).toMatchObject({ id: second.id, status: "in_progress" });
  });
});
