import { describe, expect, test } from "bun:test";
import { createIssue, updateIssue, archiveIssue, relateIssue } from "../src/ops/issues";
import { initWorkspace, setWorkspaceSpecAssessment } from "../src/ops/workspaces";
import { askQuestion } from "../src/ops/agent";
import { createProject, getProjectFlow } from "../src/ops/projects";
import { codeOf, setup } from "./helpers";

describe("Project の依存フロー", () => {
  test("Project 内の非アーカイブ Issue を完了・中止を含めて主ノードにし、他 Project の Issue は含めない", () => {
    const { db, ws, me } = setup();
    const p = createProject(me, { name: "検索" });
    createProject(me, { name: "無関係" });
    const a = createIssue(me, { workspaceId: ws.id, title: "a", projectRef: "検索" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b", projectRef: "検索" });
    const c = createIssue(me, { workspaceId: ws.id, title: "c", projectRef: "検索" });
    const archived = createIssue(me, { workspaceId: ws.id, title: "archived", projectRef: "検索" });
    createIssue(me, { workspaceId: ws.id, title: "other", projectRef: "無関係" });
    createIssue(me, { workspaceId: ws.id, title: "none" });
    updateIssue(me, b.id, { status: "done" });
    updateIssue(me, c.id, { status: "canceled" });
    archiveIssue(me, archived.id);

    const flow = getProjectFlow(db, p.name);
    expect(flow.projectId).toBe(p.id);
    expect(flow.edges).toEqual([]);
    expect(flow.nodes).toEqual([
      { id: a.id, title: "a", status: "todo", workspace: ws.key, workspaceName: ws.name, project: { id: p.id, name: "検索" }, external: false, ready: true, openBlockers: [] },
      { id: b.id, title: "b", status: "done", workspace: ws.key, workspaceName: ws.name, project: { id: p.id, name: "検索" }, external: false, ready: false, openBlockers: [] },
      { id: c.id, title: "c", status: "canceled", workspace: ws.key, workspaceName: ws.name, project: { id: p.id, name: "検索" }, external: false, ready: false, openBlockers: [] },
    ]);
  });

  test("直接 blocks でつながる Project 外の Issue だけを参照ノードにし、その先は展開しない", () => {
    const { db, ws, me } = setup();
    const web = initWorkspace(db, { path: "/tmp/repos/web-app" }).workspace;
    const p = createProject(me, { name: "検索" });
    const other = createProject(me, { name: "基盤" });
    const a = createIssue(me, { workspaceId: ws.id, title: "a", projectRef: "検索" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b", projectRef: "検索" });
    const gone = createIssue(me, { workspaceId: ws.id, title: "gone", projectRef: "検索" });
    const ext = createIssue(me, { workspaceId: web.id, title: "ext", projectRef: "基盤" });
    const loose = createIssue(me, { workspaceId: ws.id, title: "loose" });
    const far = createIssue(me, { workspaceId: web.id, title: "far", projectRef: "基盤" });
    const rel = createIssue(me, { workspaceId: web.id, title: "rel" });
    const archivedExt = createIssue(me, { workspaceId: web.id, title: "archived ext" });
    const x = createIssue(me, { workspaceId: web.id, title: "x", projectRef: "基盤" });
    const y = createIssue(me, { workspaceId: web.id, title: "y", projectRef: "基盤" });
    relateIssue(me, ext.id, { blocks: a.id });
    relateIssue(me, a.id, { blocks: b.id });
    relateIssue(me, b.id, { blocks: a.id }); // 循環もそのまま返す
    relateIssue(me, b.id, { blocks: loose.id });
    relateIssue(me, far.id, { blocks: ext.id }); // 参照ノードの先は展開しない
    relateIssue(me, loose.id, { blocks: ext.id }); // 参照ノード同士の辺は返さない
    relateIssue(me, a.id, { related: rel.id }); // blocks 以外は辺にしない
    relateIssue(me, archivedExt.id, { blocks: b.id });
    relateIssue(me, gone.id, { blocks: b.id });
    relateIssue(me, x.id, { blocks: y.id }); // 無関係な Project の辺
    archiveIssue(me, archivedExt.id);
    archiveIssue(me, gone.id);

    const flow = getProjectFlow(db, String(p.id));
    expect(flow.nodes.map((n) => [n.id, n.external])).toEqual([
      [a.id, false],
      [b.id, false],
      [loose.id, true],
      [ext.id, true],
    ]);
    expect(flow.nodes.find((n) => n.id === ext.id)).toEqual({
      id: ext.id, title: "ext", status: "todo", workspace: web.key, workspaceName: web.name,
      project: { id: other.id, name: "基盤" }, external: true, ready: false, openBlockers: [loose.id, far.id],
    });
    expect(flow.nodes.find((n) => n.id === loose.id)?.project).toBeNull();
    expect(flow.edges).toEqual([
      { from: a.id, to: b.id },
      { from: b.id, to: a.id },
      { from: b.id, to: loose.id },
      { from: ext.id, to: a.id },
    ]);
  });

  test("完了・中止のブロック元は辺に残すが待ちの原因にせず、Ready は既存の判定に従う", () => {
    const { db, ws, me, llm } = setup();
    const p = createProject(me, { name: "検索" });
    const issue = (title: string) => createIssue(me, { workspaceId: ws.id, title, projectRef: "検索" });
    const done = issue("done");
    const canceled = issue("canceled");
    const free = issue("free");
    const open = issue("open");
    const waiting = issue("waiting");
    const asked = issue("asked");
    const snoozed = issue("snoozed");
    const woke = issue("woke");
    const started = issue("started");
    updateIssue(me, done.id, { status: "done" });
    updateIssue(me, canceled.id, { status: "canceled" });
    relateIssue(me, done.id, { blocks: free.id });
    relateIssue(me, canceled.id, { blocks: free.id });
    relateIssue(me, open.id, { blocks: waiting.id });
    relateIssue(me, done.id, { blocks: waiting.id });
    askQuestion(llm, asked.id, "どちらにするか");
    updateIssue(me, asked.id, { status: "todo" });
    db.query("UPDATE issues SET snoozed_until = '2999-01-01T00:00:00.000Z' WHERE title = 'snoozed'").run();
    db.query("UPDATE issues SET snoozed_until = '2000-01-01T00:00:00.000Z' WHERE title = 'woke'").run();
    updateIssue(me, started.id, { status: "in_progress" });
    setWorkspaceSpecAssessment(me, ws.key, true);
    const assessing = issue("assessing");

    const flow = getProjectFlow(db, p.name);
    const node = (id: string) => flow.nodes.find((n) => n.id === id);
    expect(node(asked.id)?.status).toBe("todo");
    expect(node(assessing.id)?.status).toBe("todo");
    expect(flow.nodes.filter((n) => n.ready).map((n) => n.id)).toEqual([free.id, open.id, woke.id]);
    expect(node(free.id)?.openBlockers).toEqual([]);
    expect(node(waiting.id)?.openBlockers).toEqual([open.id]);
    expect(flow.edges).toEqual([
      { from: done.id, to: free.id },
      { from: done.id, to: waiting.id },
      { from: canceled.id, to: free.id },
      { from: open.id, to: waiting.id },
    ]);
  });

  test("存在しない Project は NOT_FOUND", () => {
    const { db } = setup();
    expect(codeOf(() => getProjectFlow(db, "ない"))).toBe("NOT_FOUND");
  });
});
