import { describe, expect, test } from "bun:test";
import type { IssueQuery } from "../src/issue-filter";
import { askQuestion, startIssue } from "../src/ops/agent";
import { answerQuestion } from "../src/ops/human";
import {
  commentIssue,
  createIssue,
  getIssue,
  listIssues,
  queryIssues,
  relateIssue,
  updateIssue,
} from "../src/ops/issues";
import { initWorkspace } from "../src/ops/workspaces";
import { addProjectRow, codeOf, eventsOf, setup } from "./helpers";

describe("createIssue", () => {
  test("Workspace ごとの連番で ID を振り、私の起票は todo から始まる", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "検索が遅い" });
    const b = createIssue(me, { workspaceId: ws.id, title: "一覧が崩れる" });
    expect([a.id, b.id]).toEqual(["API-1", "API-2"]);
    expect(a).toMatchObject({ status: "todo", createdBy: "me", priority: 0, workspace: "API", number: 1 });
    const web = initWorkspace(db, { path: "/tmp/repos/web" }).workspace;
    expect(createIssue(me, { workspaceId: web.id, title: "x" }).id).toBe("WEB-1");
  });

  test("LLM の起票は triage から始まり、created を記録する", () => {
    const { db, ws, llm } = setup();
    const i = createIssue(llm, { workspaceId: ws.id, title: "t" });
    expect(i).toMatchObject({ status: "triage", createdBy: "claude-code" });
    expect(eventsOf(db, i.id)).toEqual([{ type: "created", actor: "claude-code", data: { status: "triage" } }]);
  });

  test("Sub-issue は同じ連番を使い、親の children に出る", () => {
    const { db, ws, me } = setup();
    const parent = createIssue(me, { workspaceId: ws.id, title: "親" });
    const child = createIssue(me, { workspaceId: ws.id, title: "子", parentRef: parent.id });
    expect(child).toMatchObject({ id: "API-2", parentId: "API-1" });
    expect(getIssue(db, parent.id).children.map((c) => c.id)).toEqual(["API-2"]);
  });

  test("ラベルは重複を除いて並べ、Project は名前で指定できる", () => {
    const { db, ws, me } = setup();
    const pid = addProjectRow(db, "検索");
    const i = createIssue(me, { workspaceId: ws.id, title: "t", labels: ["ui", "bug", "ui"], projectRef: "検索" });
    expect(i.labels).toEqual(["bug", "ui"]);
    expect(i.project).toEqual({ id: pid, name: "検索" });
    expect(codeOf(() => createIssue(me, { workspaceId: ws.id, title: "t", projectRef: "ない" }))).toBe("NOT_FOUND");
  });

  test("タイトルが空、優先度が範囲外なら INVALID_ARGS", () => {
    const { ws, me } = setup();
    expect(codeOf(() => createIssue(me, { workspaceId: ws.id, title: "  " }))).toBe("INVALID_ARGS");
    expect(codeOf(() => createIssue(me, { workspaceId: ws.id, title: "t", priority: 5 }))).toBe("INVALID_ARGS");
  });

  test("先頭が - のタイトルもそのまま保存する", () => {
    const { ws, me } = setup();
    expect(createIssue(me, { workspaceId: ws.id, title: "-p の扱いを直す" }).title).toBe("-p の扱いを直す");
  });
});

describe("Issue の ID", () => {
  test("小文字でも引け、形式が違えば INVALID_ARGS、なければ NOT_FOUND", () => {
    const { db, ws, me } = setup();
    createIssue(me, { workspaceId: ws.id, title: "t" });
    expect(getIssue(db, "api-1").id).toBe("API-1");
    expect(codeOf(() => getIssue(db, "12"))).toBe("INVALID_ARGS");
    expect(codeOf(() => getIssue(db, "API-99"))).toBe("NOT_FOUND");
  });
});

describe("listIssues", () => {
  test("既定では done と canceled を除き、ステータス、ラベル、Workspace で絞り込める", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a", labels: ["bug", "ui"] });
    const b = createIssue(llm, { workspaceId: ws.id, title: "b", labels: ["bug"] });
    const c = createIssue(me, { workspaceId: ws.id, title: "c" });
    updateIssue(me, c.id, { status: "done" });
    const web = initWorkspace(db, { path: "/tmp/repos/web" }).workspace;
    createIssue(me, { workspaceId: web.id, title: "w" });

    expect(listIssues(db, { workspaceId: ws.id }).map((i) => i.id)).toEqual([a.id, b.id]);
    expect(listIssues(db, { workspaceId: ws.id, statuses: ["done"] }).map((i) => i.id)).toEqual([c.id]);
    expect(listIssues(db, { workspaceId: ws.id, statuses: ["triage"] }).map((i) => i.id)).toEqual([b.id]);
    expect(listIssues(db, { workspaceId: ws.id, labels: ["bug", "ui"] }).map((i) => i.id)).toEqual([a.id]);
    expect(listIssues(db).map((i) => i.id)).toEqual(["API-1", "API-2", "WEB-1"]);
  });

  test("Project で絞り込める", () => {
    const { db, ws, me } = setup();
    addProjectRow(db, "検索");
    const a = createIssue(me, { workspaceId: ws.id, title: "a", projectRef: "検索" });
    createIssue(me, { workspaceId: ws.id, title: "b" });
    expect(listIssues(db, { projectRef: "検索" }).map((i) => i.id)).toEqual([a.id]);
  });
});

describe("updateIssue", () => {
  test("手で needs_clarification にはできない", () => {
    const { db, ws, me } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    expect(codeOf(() => updateIssue(me, i.id, { status: "needs_clarification" }))).toBe("INVALID_ARGS");
    expect(getIssue(db, i.id).status).toBe("todo");
  });
  test("変わった項目だけを events に記録し、done で closed_at を入れる", () => {
    const { db, ws, me } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const updated = updateIssue(me, i.id, { title: "t", priority: 2, status: "done", reason: "直した" });
    expect(updated).toMatchObject({ priority: 2, status: "done", closeReason: "直した" });
    expect(updated.closedAt).not.toBeNull();
    expect(eventsOf(db, i.id).map((e) => [e.type, e.data])).toEqual([
      ["created", { status: "todo" }],
      ["priority_changed", { from: 0, to: 2 }],
      ["status_changed", { from: "todo", to: "done", reason: "直した" }],
    ]);
  });

  test("LLM は done にできない", () => {
    const { ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    expect(codeOf(() => updateIssue(llm, i.id, { status: "done" }))).toBe("FORBIDDEN_FOR_LLM");
  });

  test("ラベルの追加と削除を1つの event にまとめる", () => {
    const { db, ws, me } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t", labels: ["bug"] });
    const updated = updateIssue(me, i.id, { addLabels: ["ui", "ui"], removeLabels: ["bug", "none"] });
    expect(updated.labels).toEqual(["ui"]);
    expect(eventsOf(db, i.id).at(-1)).toMatchObject({ type: "labels_changed", data: { added: ["ui"], removed: ["bug"] } });
  });

  test("親と Project は表示用の値で記録し、空にもできる", () => {
    const { db, ws, me } = setup();
    addProjectRow(db, "検索");
    const p = createIssue(me, { workspaceId: ws.id, title: "親" });
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    updateIssue(me, i.id, { parentRef: p.id, projectRef: "検索" });
    const cleared = updateIssue(me, i.id, { parentRef: null, projectRef: null });
    expect(cleared).toMatchObject({ parentId: null, project: null });
    expect(eventsOf(db, i.id).slice(1).map((e) => [e.type, e.data])).toEqual([
      ["parent_changed", { from: null, to: "API-1" }],
      ["project_changed", { from: null, to: "検索" }],
      ["parent_changed", { from: "API-1", to: null }],
      ["project_changed", { from: "検索", to: null }],
    ]);
    expect(codeOf(() => updateIssue(me, i.id, { parentRef: i.id }))).toBe("INVALID_ARGS");
  });

  test("子孫を親にすると循環するので INVALID_ARGS（子、孫）", () => {
    const { ws, me } = setup();
    const top = createIssue(me, { workspaceId: ws.id, title: "top" });
    const child = createIssue(me, { workspaceId: ws.id, title: "child", parentRef: top.id });
    const grandchild = createIssue(me, { workspaceId: ws.id, title: "grandchild", parentRef: child.id });
    expect(codeOf(() => updateIssue(me, top.id, { parentRef: child.id }))).toBe("INVALID_ARGS");
    expect(codeOf(() => updateIssue(me, top.id, { parentRef: grandchild.id }))).toBe("INVALID_ARGS");
    expect(getIssue(me.db, top.id).parentId).toBeNull();
    const other = createIssue(me, { workspaceId: ws.id, title: "other" });
    expect(updateIssue(me, top.id, { parentRef: other.id }).parentId).toBe(other.id);
  });

  test("説明の変更は description_changed に記録し、同じ値なら記録しない", () => {
    const { db, ws, me } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t", description: "古い" });
    updateIssue(me, i.id, { description: "新しい" });
    updateIssue(me, i.id, { description: "新しい" });
    updateIssue(me, i.id, { description: null });
    expect(eventsOf(db, i.id).slice(1).map((e) => [e.type, e.data])).toEqual([
      ["description_changed", { from: "古い", to: "新しい" }],
      ["description_changed", { from: "新しい", to: null }],
    ]);
  });
});

describe("commentIssue と Activity", () => {
  test("コメントと events を時刻順に並べる", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    commentIssue(llm, i.id, "調べ始めた");
    const activity = getIssue(db, i.id).activity;
    expect(activity.map((a) => a.kind)).toEqual(["event", "comment"]);
    expect(activity[1]).toMatchObject({ kind: "comment", actor: "claude-code", body: "調べ始めた" });
    expect(codeOf(() => commentIssue(me, i.id, ""))).toBe("INVALID_ARGS");
  });
});

describe("relateIssue", () => {
  test("blocks は両側から見え、同じ関係を二度足しても記録は1件", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    expect(relateIssue(me, a.id, { blocks: b.id }).relations.blocks).toEqual([b.id]);
    relateIssue(me, a.id, { blocks: b.id });
    expect(getIssue(db, b.id).relations.blockedBy).toEqual([a.id]);
    expect(eventsOf(db, a.id).filter((e) => e.type === "relation_added")).toEqual([
      { type: "relation_added", actor: "me", data: { type: "blocks", to: b.id } },
    ]);
  });

  test("自分自身との関係や、指定が1つでないものは INVALID_ARGS", () => {
    const { ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    expect(codeOf(() => relateIssue(me, a.id, { related: a.id }))).toBe("INVALID_ARGS");
    expect(codeOf(() => relateIssue(me, a.id, {}))).toBe("INVALID_ARGS");
    expect(codeOf(() => relateIssue(me, a.id, { blocks: b.id, related: b.id }))).toBe("INVALID_ARGS");
  });
});

describe("queryIssues", () => {
  test("複数の Workspace、ステータス、Project、ラベルで絞り込み、ステータスを省くと閉じた Issue も含める", () => {
    const { db, ws, me } = setup();
    const web = initWorkspace(db, { path: "/tmp/repos/web" }).workspace;
    const ops = initWorkspace(db, { path: "/tmp/repos/ops" }).workspace;
    addProjectRow(db, "検索");
    const a = createIssue(me, { workspaceId: ws.id, title: "a", labels: ["bug"], projectRef: "検索" });
    const b = createIssue(me, { workspaceId: web.id, title: "b", labels: ["bug", "ui"] });
    const c = createIssue(me, { workspaceId: ops.id, title: "c" });
    updateIssue(me, a.id, { status: "done" });
    const ids = (q: IssueQuery) => queryIssues(db, q).issues.map((i) => i.id);
    expect(ids({})).toEqual([a.id, c.id, b.id]);
    expect(ids({ workspace: ["API", "web"] })).toEqual([a.id, b.id]);
    expect(ids({ status: ["todo"] })).toEqual([c.id, b.id]);
    expect(ids({ project: "検索" })).toEqual([a.id]);
    expect(ids({ label: ["bug", "ui"] })).toEqual([b.id]);
    expect(ids({ workspace: ["NONE"] })).toEqual([]);
  });

  test("ready は担当者に関係なく着手できる Issue だけを返す", () => {
    const { db, ws, me, llm } = setup();
    const free = createIssue(me, { workspaceId: ws.id, title: "free" });
    const others = createIssue(me, { workspaceId: ws.id, title: "others" });
    updateIssue(me, others.id, { assignee: "codex" });
    const blocker = createIssue(me, { workspaceId: ws.id, title: "blocker" });
    updateIssue(me, blocker.id, { status: "backlog" });
    const blocked = createIssue(me, { workspaceId: ws.id, title: "blocked" });
    relateIssue(me, blocker.id, { blocks: blocked.id });
    const snoozed = createIssue(me, { workspaceId: ws.id, title: "snoozed" });
    db.query("UPDATE issues SET snoozed_until = '2999-01-01T00:00:00.000Z' WHERE number = ?").run(snoozed.number);
    const unclear = createIssue(me, { workspaceId: ws.id, title: "unclear" });
    askQuestion(me, unclear.id, "対象はどれか");
    const working = createIssue(me, { workspaceId: ws.id, title: "working" });
    startIssue(llm, working.id);
    expect(queryIssues(db, { ready: true }).issues.map((i) => i.id)).toEqual([free.id, others.id]);
  });

  test("件数は Workspace、Project、ラベルの範囲で数え、ステータスと ready の絞り込みには左右されない", () => {
    const { db, ws, me } = setup();
    const web = initWorkspace(db, { path: "/tmp/repos/web" }).workspace;
    createIssue(me, { workspaceId: ws.id, title: "ready" });
    const unclear = createIssue(me, { workspaceId: ws.id, title: "unclear" });
    askQuestion(me, unclear.id, "対象はどれか");
    createIssue(me, { workspaceId: web.id, title: "web" });
    const counts = { ready: 1, needsClarification: 1 };
    expect(queryIssues(db, { workspace: ["API"] }).counts).toEqual(counts);
    expect(queryIssues(db, { workspace: ["API"], ready: true }).counts).toEqual(counts);
    expect(queryIssues(db, { workspace: ["API"], status: ["done"] }).counts).toEqual(counts);
    expect(queryIssues(db, {}).counts).toEqual({ ready: 2, needsClarification: 1 });
  });

  test("各 Issue に未決事項の決定数と総数を付ける", () => {
    const { db, ws, me } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    expect(i.questionCount).toEqual({ answered: 0, total: 0 });
    const first = askQuestion(me, i.id, "一つ目").question;
    askQuestion(me, i.id, "二つ目");
    answerQuestion(me, i.id, "決めた", { questionId: first.id });
    expect(queryIssues(db, {}).issues[0]?.questionCount).toEqual({ answered: 1, total: 2 });
    expect(getIssue(db, i.id).questionCount).toEqual({ answered: 1, total: 2 });
  });
});
