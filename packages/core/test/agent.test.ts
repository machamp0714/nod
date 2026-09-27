import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { askQuestion, completeIssue, failIssue, nextIssue, startIssue } from "../src/ops/agent";
import { createIssue, getIssue, relateIssue, updateIssue } from "../src/ops/issues";
import { initWorkspace } from "../src/ops/workspaces";
import { addProjectRow, codeOf, eventsOf, setup, tempDbPath } from "./helpers";

describe("nextIssue", () => {
  test("優先度（Urgent が先、なしは最後）、作成順に取る", () => {
    const { ws, me, llm } = setup();
    const none = createIssue(me, { workspaceId: ws.id, title: "なし", priority: 0 });
    const medium = createIssue(me, { workspaceId: ws.id, title: "Medium", priority: 3 });
    const urgent = createIssue(me, { workspaceId: ws.id, title: "Urgent", priority: 1 });
    const picked = [1, 2, 3, 4].map(() => nextIssue(llm, { workspaceId: ws.id })?.id ?? null);
    expect(picked).toEqual([urgent.id, medium.id, none.id, null]);
  });

  test("着手し、担当を自分、作業状況を working にして、作業場所を記録する", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const picked = nextIssue(llm, { workspaceId: ws.id, location: { branch: "feat-x", worktree: "/wt/x" } });
    expect(picked).toMatchObject({
      id: i.id,
      status: "in_progress",
      assignee: "claude-code",
      agentState: "working",
      branch: "feat-x",
      worktree: "/wt/x",
    });
    expect(picked?.startedAt).not.toBeNull();
    expect(eventsOf(db, i.id).map((e) => e.type)).toEqual([
      "created",
      "status_changed",
      "assignee_changed",
      "agent_state_changed",
    ]);
  });

  test("Triage、後回し中、未回答の確認依頼あり、ブロック中、他人の担当は取らない", () => {
    const { db, ws, me, llm } = setup();
    createIssue(llm, { workspaceId: ws.id, title: "triage" });
    const snoozed = createIssue(me, { workspaceId: ws.id, title: "snoozed" });
    db.query("UPDATE issues SET snoozed_until = '2999-01-01T00:00:00.000Z' WHERE number = ?").run(snoozed.number);
    const asked = createIssue(me, { workspaceId: ws.id, title: "asked" });
    askQuestion(llm, asked.id, "どちらにするか");
    const blocker = createIssue(me, { workspaceId: ws.id, title: "blocker" });
    updateIssue(me, blocker.id, { status: "backlog" });
    const blocked = createIssue(me, { workspaceId: ws.id, title: "blocked" });
    relateIssue(me, blocker.id, { blocks: blocked.id });
    const others = createIssue(me, { workspaceId: ws.id, title: "others" });
    updateIssue(me, others.id, { assignee: "codex" });

    expect(nextIssue(llm, { workspaceId: ws.id })).toBeNull();
    updateIssue(me, blocker.id, { status: "canceled" });
    expect(nextIssue(llm, { workspaceId: ws.id })?.id).toBe(blocked.id);
  });

  test("Project で絞り込める", () => {
    const { db, ws, me, llm } = setup();
    addProjectRow(db, "検索");
    createIssue(me, { workspaceId: ws.id, title: "外" });
    const inside = createIssue(me, { workspaceId: ws.id, title: "中", projectRef: "検索" });
    expect(nextIssue(llm, { workspaceId: ws.id, projectRef: "検索" })?.id).toBe(inside.id);
  });

  test("別の接続から続けて取っても、1件は1回しか取られない", () => {
    const path = tempDbPath();
    const a = openDb(path);
    const ws = initWorkspace(a, { path: "/tmp/repos/api-server" }).workspace;
    createIssue({ db: a, actor: "me" }, { workspaceId: ws.id, title: "t" });
    const b = openDb(path);
    const first = nextIssue({ db: a, actor: "claude-code" }, { workspaceId: ws.id });
    const second = nextIssue({ db: b, actor: "codex" }, { workspaceId: ws.id });
    expect(first?.assignee).toBe("claude-code");
    expect(second).toBeNull();
  });
});

describe("startIssue", () => {
  test("指定した Issue に着手する。Triage なら NOT_ACCEPTED、閉じていれば ISSUE_CLOSED", () => {
    const { ws, me, llm } = setup();
    const backlog = createIssue(me, { workspaceId: ws.id, title: "b" });
    updateIssue(me, backlog.id, { status: "backlog" });
    expect(startIssue(llm, backlog.id)).toMatchObject({ status: "in_progress", assignee: "claude-code", agentState: "working" });
    const triage = createIssue(llm, { workspaceId: ws.id, title: "t" });
    expect(codeOf(() => startIssue(llm, triage.id))).toBe("NOT_ACCEPTED");
    const canceled = createIssue(me, { workspaceId: ws.id, title: "c" });
    updateIssue(me, canceled.id, { status: "canceled" });
    expect(codeOf(() => startIssue(llm, canceled.id))).toBe("ISSUE_CLOSED");
  });
});

describe("askQuestion", () => {
  test("作業状況を awaiting_input にし、同じ文面の未回答の質問は増やさない", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    startIssue(llm, i.id);
    const first = askQuestion(llm, i.id, "--force を外してよいか");
    const again = askQuestion(llm, i.id, "--force を外してよいか");
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, question: { id: first.question.id } });
    const detail = getIssue(db, i.id);
    expect(detail.agentState).toBe("awaiting_input");
    expect(detail.openQuestions.map((q) => q.question)).toEqual(["--force を外してよいか"]);
    expect(eventsOf(db, i.id).filter((e) => e.type === "question_asked")).toHaveLength(1);
    expect(codeOf(() => askQuestion(llm, i.id, " "))).toBe("INVALID_ARGS");
  });
});

describe("failIssue と completeIssue", () => {
  test("fail は作業状況を error にし、理由をコメントに残す", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    startIssue(llm, i.id);
    expect(failIssue(llm, i.id, "テストが通らない").agentState).toBe("error");
    expect(getIssue(db, i.id).activity.filter((a) => a.kind === "comment").at(-1)).toMatchObject({ body: "エラー: テストが通らない" });
    expect(eventsOf(db, i.id).at(-1)).toMatchObject({
      type: "agent_state_changed",
      data: { from: "working", to: "error", reason: "テストが通らない" },
    });
  });

  test("done は報告を残して in_review にし、着手中でなければ NOT_IN_PROGRESS", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    expect(codeOf(() => completeIssue(llm, i.id, { summary: "やった" }))).toBe("NOT_IN_PROGRESS");
    startIssue(llm, i.id);
    const done = completeIssue(llm, i.id, { summary: "インデックスを足した", prUrl: "https://example.com/pull/1" });
    expect(done).toMatchObject({ status: "in_review", agentState: "done", prUrl: "https://example.com/pull/1" });
    expect(getIssue(db, i.id).activity.some((a) => a.kind === "comment" && a.body === "インデックスを足した")).toBe(true);
  });
});
