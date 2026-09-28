import { describe, expect, test } from "bun:test";
import { askQuestion, startIssue } from "../src/ops/agent";
import { createIssue, updateIssue } from "../src/ops/issues";
import { createProject, getProject, listProjects } from "../src/ops/projects";
import { PROJECT_STATUSES } from "../src/types";
import { updateProject } from "../src/ops/projects";
import { initWorkspace } from "../src/ops/workspaces";
import { linkDocument } from "../src/ops/documents";
import { codeOf, setup } from "./helpers";

describe("Project", () => {
  test("作成し、進捗と LLM の状況つきで一覧する", () => {
    const { db, ws, me, llm } = setup();
    const p = createProject(me, { name: "検索", description: "検索を速くする" });
    expect(p).toMatchObject({ name: "検索", status: "planned", createdBy: "me" });
    const a = createIssue(me, { workspaceId: ws.id, title: "a", projectRef: "検索" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b", projectRef: "検索" });
    const c = createIssue(me, { workspaceId: ws.id, title: "c", projectRef: "検索" });
    updateIssue(me, a.id, { status: "done" });
    startIssue(llm, b.id);
    askQuestion(llm, b.id, "どちらにするか");
    updateIssue(me, c.id, { status: "canceled" });

    expect(listProjects(db)).toEqual([
      expect.objectContaining({ name: "検索", total: 2, done: 1, agents: { working: 0, awaitingInput: 1, awaitingReview: 0, error: 0 } }),
    ]);
    const detail = getProject(db, String(p.id));
    expect(detail.issues.map((i) => i.id)).toEqual([a.id, b.id, c.id]);
    expect(detail.documents).toEqual([]);
  });

  test("名前が重複すれば PROJECT_EXISTS、空なら INVALID_ARGS、ないものは NOT_FOUND", () => {
    const { db, me } = setup();
    createProject(me, { name: "検索" });
    expect(codeOf(() => createProject(me, { name: "検索" }))).toBe("PROJECT_EXISTS");
    expect(codeOf(() => createProject(me, { name: " " }))).toBe("INVALID_ARGS");
    expect(codeOf(() => createProject(me, { name: "123" }))).toBe("INVALID_ARGS");
    expect(createProject(me, { name: "v2" }).name).toBe("v2");
    expect(codeOf(() => getProject(db, "ない"))).toBe("NOT_FOUND");
  });

  test("閉じた Project は既定の一覧に出ない", () => {
    const { db, me } = setup();
    const p = createProject(me, { name: "古い" });
    db.query("UPDATE projects SET status = 'completed' WHERE id = ?").run(p.id);
    expect(listProjects(db)).toEqual([]);
    expect(listProjects(db, { includeClosed: true }).map((x) => x.name)).toEqual(["古い"]);
  });
});

describe("Project の更新とレビュー待ち", () => {
  test("四状態を相互変更し、同値は時刻を維持、IssueとDocumentsには連動しない", () => {
    const { db, ws, me } = setup();
    const codex = { db, actor: "codex" };
    const p = createProject(me, { name: "認証 基盤 v1.0", description: "説明" });
    createIssue(me, { workspaceId: ws.id, title: "未完了", projectRef: p.name });
    linkDocument(me, { projectId: p.id }, { path: "/tmp/project-spec.md", content: "# 設計" });
    const before = getProject(db, p.name);
    for (const from of PROJECT_STATUSES) {
      for (const to of PROJECT_STATUSES) {
        db.query("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?").run(from, "2000-01-01T00:00:00.000Z", p.id);
        const result = updateProject(codex, from === "planned" ? p.name : String(p.id), { status: to });
        const { updatedAt: _beforeTime, ...unchanged } = p;
        expect(result).toMatchObject({ ...unchanged, status: to });
        if (from === to) expect(result.updatedAt).toBe("2000-01-01T00:00:00.000Z");
        else expect(result.updatedAt).not.toBe("2000-01-01T00:00:00.000Z");
        const detail = getProject(db, p.name);
        expect(detail.issues).toEqual(before.issues);
        expect(detail.documents).toEqual(before.documents);
        expect(listProjects(db).some((v) => v.id === p.id)).toBe(to === "planned" || to === "started");
        expect(listProjects(db, { includeClosed: true })).toHaveLength(1);
      }
    }
  });

  test("不正statusと存在しないProjectを拒み、DBを変更しない", () => {
    const { db, me } = setup();
    const p = createProject(me, { name: "保持" });
    for (const status of ["", "done", "COMPLETED", " completed", null, undefined, 1]) {
      expect(codeOf(() => updateProject(me, p.name, { status } as any))).toBe("INVALID_ARGS");
      expect(getProject(db, p.name)).toMatchObject(p);
    }
    expect(codeOf(() => updateProject(me, "不存在", { status: "completed" }))).toBe("NOT_FOUND");
    expect(getProject(db, p.name)).toMatchObject(p);
  });

  test("レビュー待ちはWorkspaceと担当者を問わずin_reviewを数え、他指標とは独立する", () => {
    const { db, ws, me } = setup();
    const ws2 = initWorkspace(db, { path: "/tmp/project-other", key: "OTHER" }).workspace;
    const p = createProject(me, { name: "集計" });
    const empty = createProject(me, { name: "空" });
    const samples = [
      [ws.id, "in_review", null, "me", p.name],
      [ws2.id, "in_review", "error", "codex", p.name],
      [ws.id, "in_review", null, null, p.name],
      [ws.id, "in_progress", "working", "codex", p.name],
      [ws.id, "in_progress", "awaiting_input", "codex", p.name],
      [ws.id, "done", "working", "codex", p.name],
      [ws.id, "canceled", "error", "codex", p.name],
      [ws.id, "in_review", null, "codex", empty.name],
      [ws.id, "in_review", null, "codex", undefined],
    ] as const;
    for (const [workspaceId, status, agentState, assignee, projectRef] of samples) {
      const issue = createIssue(me, { workspaceId, title: status, projectRef });
      db.query("UPDATE issues SET status = ?, agent_state = ?, assignee = ? WHERE workspace_id = ? AND number = ?")
        .run(status, agentState, assignee, workspaceId, issue.number);
    }
    const summary = { total: 6, done: 1, agents: { working: 1, awaitingInput: 1, awaitingReview: 3, error: 1 } };
    expect(getProject(db, p.name)).toMatchObject(summary);
    expect(listProjects(db).find((x) => x.id === p.id)).toMatchObject(summary);
    updateProject(me, p.name, { status: "completed" });
    expect(getProject(db, p.name)).toMatchObject(summary);
    const zero = createProject(me, { name: "ゼロ" });
    expect(getProject(db, zero.name).agents).toEqual({ working: 0, awaitingInput: 0, awaitingReview: 0, error: 0 });
  });
});
