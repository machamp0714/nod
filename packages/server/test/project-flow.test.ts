import { describe, expect, test } from "bun:test";
import { archiveIssue, createIssue, createProject, initWorkspace, relateIssue, updateIssue } from "@nod/core";
import { call, setup } from "./helpers";

describe("Project の依存フロー API", () => {
  test("名前と ID で Project 内の Issue と直接つながる Project 外の Issue を、blocks の向きのまま返す", async () => {
    const { app, db, ws, me } = setup();
    const web = initWorkspace(db, { path: "/tmp/repos/web-app" }).workspace;
    const p = createProject(me, { name: "検索 v2" });
    const other = createProject(me, { name: "基盤" });
    const a = createIssue(me, { workspaceId: ws.id, title: "a", projectRef: p.name });
    const b = createIssue(me, { workspaceId: ws.id, title: "b", projectRef: p.name });
    const archived = createIssue(me, { workspaceId: ws.id, title: "archived", projectRef: p.name });
    const ext = createIssue(me, { workspaceId: web.id, title: "ext", projectRef: "基盤" });
    const far = createIssue(me, { workspaceId: web.id, title: "far", projectRef: "基盤" });
    relateIssue(me, ext.id, { blocks: a.id });
    relateIssue(me, a.id, { blocks: b.id });
    relateIssue(me, far.id, { blocks: ext.id });
    relateIssue(me, archived.id, { blocks: b.id });
    archiveIssue(me, archived.id);
    updateIssue(me, ext.id, { status: "done" });

    for (const ref of [String(p.id), encodeURIComponent(p.name)]) {
      const res = await call(app, "GET", `/api/projects/${ref}/flow`);
      expect(res.status).toBe(200);
      expect(res.json).toEqual({
        projectId: p.id,
        nodes: [
          { id: a.id, title: "a", status: "todo", workspace: ws.key, workspaceName: ws.name, project: { id: p.id, name: p.name }, external: false, ready: true, openBlockers: [] },
          { id: b.id, title: "b", status: "todo", workspace: ws.key, workspaceName: ws.name, project: { id: p.id, name: p.name }, external: false, ready: false, openBlockers: [a.id] },
          { id: ext.id, title: "ext", status: "done", workspace: web.key, workspaceName: web.name, project: { id: other.id, name: "基盤" }, external: true, ready: false, openBlockers: [far.id] },
        ],
        edges: [
          { from: a.id, to: b.id },
          { from: ext.id, to: a.id },
        ],
      });
    }
  });

  test("存在しない Project は 404", async () => {
    const { app } = setup();
    const res = await call(app, "GET", "/api/projects/999/flow");
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe("NOT_FOUND");
  });
});
