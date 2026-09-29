import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startIssue, askQuestion, completeIssue } from "../src/ops/agent";
import { attachDocument } from "../src/ops/documents";
import { copyIssue, commentIssue, createIssue, getIssue, relateIssue, updateIssue } from "../src/ops/issues";
import { setPlanTasks } from "../src/ops/plan";
import { initWorkspace } from "../src/ops/workspaces";
import { addProjectRow, codeOf, eventsOf, setup, tempDbPath } from "./helpers";

// 複製元に、複製する項目と複製しない項目をすべて持たせる
function richSource() {
  const env = setup();
  const { db, ws, me, llm } = env;
  addProjectRow(db, "検索改善");
  const parent = createIssue(me, { workspaceId: ws.id, title: "親" });
  const other = createIssue(me, { workspaceId: ws.id, title: "別の Issue" });
  const source = createIssue(me, {
    workspaceId: ws.id,
    title: "検索 API の N+1 を解消",
    description: "## 背景\n遅い",
    projectRef: "検索改善",
    parentRef: parent.id,
    priority: 2,
    labels: ["backend", "perf"],
  });
  updateIssue(me, source.id, { assignee: "claude-code" });
  relateIssue(me, source.id, { blocks: other.id });
  relateIssue(me, other.id, { related: source.id });
  setPlanTasks(me, source.id, ["調べる", "直す"]);
  const doc = join(tempDbPath(), "..", "spec.md");
  writeFileSync(doc, "# 仕様\n");
  attachDocument(me, { issueRef: source.id }, { path: doc });
  commentIssue(me, source.id, "コメント");
  startIssue(llm, source.id, { location: { branch: "feat/x", worktree: "/tmp/wt" } });
  askQuestion(llm, source.id, "どちらにするか");
  return { ...env, source, parent, other };
}

const rowOf = (env: ReturnType<typeof setup>, id: string) =>
  env.db.query("SELECT i.* FROM issues i JOIN workspaces w ON w.id = i.workspace_id WHERE w.key || '-' || i.number = ?").get(id);

const counts = (env: ReturnType<typeof setup>) =>
  Object.fromEntries(
    ["issues", "issue_labels", "relations", "plan_tasks", "document_links", "questions", "comments", "events"].map((t) => [
      t,
      (env.db.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n,
    ]),
  );

test("タイトル・説明・Project・ラベル・優先度だけを新しい ID の Issue に複製し、元の Issue を変えない", () => {
  const env = richSource();
  const { db, me, source } = env;
  const before = { row: rowOf(env, source.id), detail: getIssue(db, source.id), events: eventsOf(db, source.id) };
  const copy = copyIssue(me, source.id);
  expect(copy.id).not.toBe(source.id);
  expect(copy.workspace).toBe(source.workspace);
  expect(copy).toMatchObject({
    title: "検索 API の N+1 を解消",
    description: "## 背景\n遅い",
    project: { name: "検索改善" },
    priority: 2,
    labels: ["backend", "perf"],
    status: "todo",
    assignee: null,
    agentState: null,
    parentId: null,
    prUrl: null,
    branch: null,
    worktree: null,
    createdBy: "me",
  });
  const detail = getIssue(db, copy.id);
  expect(detail.plan).toEqual(getIssue(db, createIssue(me, { workspaceId: env.ws.id, title: "空" }).id).plan);
  expect(detail.documents).toEqual([]);
  expect(detail.children).toEqual([]);
  expect(detail.relations).toEqual({ blocks: [], blockedBy: [], related: [], duplicateOf: [], duplicates: [] });
  expect(detail.questions).toEqual([]);
  expect(detail.activity.filter((a) => a.kind !== "event")).toEqual([]);
  expect(eventsOf(db, copy.id)).toEqual([{ type: "created", actor: "me", data: { status: "todo", copied_from: source.id } }]);
  const raw = rowOf(env, copy.id) as Record<string, unknown>;
  for (const col of ["snoozed_until", "plan_source", "close_reason", "started_at", "closed_at", "pr_url"]) expect(raw[col]).toBeNull();
  // 元の Issue は updated_at を含めて変わらない
  expect(rowOf(env, source.id)).toEqual(before.row);
  expect(getIssue(db, source.id)).toEqual(before.detail);
  expect(eventsOf(db, source.id)).toEqual(before.events);
});

test("PR 付きで完了した Issue や別 Workspace の Issue も複製でき、それぞれの Workspace で番号を進める", () => {
  const env = richSource();
  const { db, me, llm, source } = env;
  completeIssue(llm, source.id, { summary: "直した", prUrl: "https://github.com/o/r/pull/1" });
  updateIssue(me, source.id, { status: "done" });
  const copy = copyIssue(me, source.id);
  expect(copy).toMatchObject({ status: "todo", prUrl: null, agentState: null });
  const ws2 = initWorkspace(db, { path: "/tmp/repos/other", key: "OTHER" }).workspace;
  const elsewhere = createIssue(me, { workspaceId: ws2.id, title: "別" });
  expect(copyIssue(me, elsewhere.id.toLowerCase()).id).toBe("OTHER-2");
});

test("タイトルを上書きでき、LLM の複製は通常の起票と同じく Triage に入る", () => {
  const { me, llm, ws } = setup();
  const src = createIssue(me, { workspaceId: ws.id, title: "元" });
  expect(copyIssue(me, src.id, { title: "  新しい名前  " }).title).toBe("  新しい名前  ");
  const byLlm = copyIssue(llm, src.id);
  expect(byLlm).toMatchObject({ status: "triage", title: "元", createdBy: "claude-code" });
});

test("存在しない ID・不正な ID・空のタイトルでは何も作らず、番号も進めない", () => {
  const env = setup();
  const { db, me, ws } = env;
  const src = createIssue(me, { workspaceId: ws.id, title: "元", labels: ["a"] });
  const snapshot = () => ({ c: counts(env), ws: db.query("SELECT next_number FROM workspaces").all() });
  const before = snapshot();
  expect(codeOf(() => copyIssue(me, "API-999"))).toBe("NOT_FOUND");
  expect(codeOf(() => copyIssue(me, "../bad"))).toBe("INVALID_ARGS");
  expect(codeOf(() => copyIssue(me, src.id, { title: "" }))).toBe("INVALID_ARGS");
  expect(codeOf(() => copyIssue(me, src.id, { title: "   " }))).toBe("INVALID_ARGS");
  expect(snapshot()).toEqual(before);
});

test("途中で失敗したら部分的な複製を残さない", () => {
  const env = setup();
  const { db, me, ws } = env;
  const src = createIssue(me, { workspaceId: ws.id, title: "元", labels: ["ok", "boom"] });
  db.run("CREATE TEMP TRIGGER fail_label BEFORE INSERT ON issue_labels WHEN NEW.label = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END");
  const before = { c: counts(env), ws: db.query("SELECT next_number FROM workspaces").all() };
  expect(() => copyIssue(me, src.id)).toThrow();
  expect({ c: counts(env), ws: db.query("SELECT next_number FROM workspaces").all() }).toEqual(before);
});
