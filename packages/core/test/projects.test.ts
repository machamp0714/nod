import { describe, expect, test } from "bun:test";
import { askQuestion, startIssue } from "../src/ops/agent";
import { createIssue, updateIssue } from "../src/ops/issues";
import { createProject, getProject, listProjects } from "../src/ops/projects";
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
      expect.objectContaining({ name: "検索", total: 2, done: 1, agents: { working: 0, awaitingInput: 1, error: 0 } }),
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
