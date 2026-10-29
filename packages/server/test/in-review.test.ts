import { expect, test } from "bun:test";
import { createProject, createIssue, relateIssue, startIssue } from "@nod/core";
import { createApp } from "../src/app";
import { call, setup } from "./helpers";

test("PRなしでもレビュー中へ移し、取得と絞り込みで同じ状態を確認できる", async () => {
  const { app, db, me, ws } = setup();
  try {
    const issue = createIssue(me, { workspaceId: ws.id, title: "レビューに提出する" });
    startIssue(me, issue.id);
    const updated = await call(app, "POST", `/api/issues/${issue.id}/update`, { status: "in_review" });
    expect(updated.status).toBe(200);
    expect(updated.json.status).toBe("in_review");
    const detail = await call(app, "GET", `/api/issues/${issue.id}`);
    expect(detail.json.status).toBe("in_review");
    expect(detail.json.activity).toContainEqual(expect.objectContaining({
      kind: "event", type: "status_changed", data: expect.objectContaining({ to: "in_review", review_semantics: "pr_review" }),
    }));
    const list = await call(app, "GET", "/api/issues?status=in_review");
    expect(list.status).toBe(200);
    expect(list.json.issues.map((item: { id: string }) => item.id)).toEqual([issue.id]);
  } finally {
    db.close();
  }
});

test("レビュー中の表示名と出入りの禁止ルールを保存し、拒否時は状態を保つ", async () => {
  const { app, db, me, ws } = setup();
  try {
    const issue = createIssue(me, { workspaceId: ws.id, title: "レビュー制御" });
    const base = `/api/workspaces/${ws.key}`;
    expect((await call(app, "PUT", `${base}/status-names`, { names: { in_review: "レビュー中" } })).status).toBe(200);
    expect((await call(app, "GET", `${base}/status-names`)).json.names).toEqual({ in_review: "レビュー中" });
    const forbidden = [{ from: "todo", to: "in_review" }, { from: "in_review", to: "done" }];
    expect((await call(app, "PUT", `${base}/transitions`, { forbidden })).status).toBe(200);
    expect((await call(app, "GET", `${base}/transitions`)).json.forbidden).toEqual(forbidden);
    const denied = await call(app, "POST", `/api/issues/${issue.id}/update`, { status: "in_review" });
    expect(denied.status).toBe(409);
    expect(denied.json.error.code).toBe("TRANSITION_NOT_ALLOWED");
    expect(denied.json.error.message).toContain("Todo → レビュー中");
    expect((await call(app, "GET", `/api/issues/${issue.id}`)).json.status).toBe("todo");
    await call(app, "PUT", `${base}/transitions`, { forbidden: forbidden.slice(1) });
    expect((await call(app, "POST", `/api/issues/${issue.id}/update`, { status: "in_review" })).status).toBe(200);
    expect((await call(app, "POST", `/api/issues/${issue.id}/update`, { status: "done" })).json.error.code).toBe("TRANSITION_NOT_ALLOWED");
    expect((await call(app, "GET", `/api/issues/${issue.id}`)).json.status).toBe("in_review");
    await call(app, "POST", `/api/issues/${issue.id}/archive`, {});
    expect((await call(app, "POST", `/api/issues/${issue.id}/update`, { status: "todo" })).json.error.code).toBe("ISSUE_ARCHIVED");
  } finally {
    db.close();
  }
});


test("draft PRを紐付けて取得しても状態は変わらず、明示操作でレビュー中にできる", async () => {
  const { db, me, ws } = setup();
  const url = "https://github.com/example/nod/pull/1";
  const app = createApp({ db, ghRunner: async () => ({ kind: "exited", exitCode: 0, stderr: "", stdout: JSON.stringify({ number: 1, title: "変更", url, state: "OPEN", isDraft: true, reviewDecision: "REVIEW_REQUIRED", mergedAt: null, statusCheckRollup: [] }) }) });
  try {
    const issue = createIssue(me, { workspaceId: ws.id, title: "draftを提出" });
    startIssue(me, issue.id);
    expect((await call(app, "POST", `/api/issues/${issue.id}/link-pr`, { url })).json.status).toBe("in_progress");
    expect((await call(app, "POST", `/api/issues/${issue.id}/pr-status/refresh`)).json.status.isDraft).toBe(true);
    expect((await call(app, "GET", `/api/issues/${issue.id}`)).json.status).toBe("in_progress");
    expect((await call(app, "POST", `/api/issues/${issue.id}/update`, { status: "in_review" })).json.status).toBe("in_review");
    await call(app, "POST", `/api/issues/${issue.id}/pr-status/refresh`);
    expect((await call(app, "GET", `/api/issues/${issue.id}`)).json.status).toBe("in_review");
  } finally {
    db.close();
  }
});

test("レビュー中から完了報告を残し、後からレビューを依頼すると未完了へ戻る", async () => {
  const { app, db, me, ws } = setup();
  try {
    const issue = createIssue(me, { workspaceId: ws.id, title: "提出後に完了する" });
    startIssue(me, issue.id);
    await call(app, "POST", `/api/issues/${issue.id}/update`, { status: "in_review" });
    const done = await call(app, "POST", `/api/issues/${issue.id}/done`, { summary: "mergeと完了条件を確認しました" });
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ status: "done", agentState: "done" });
    expect(done.json.closedAt).not.toBeNull();
    const detail = (await call(app, "GET", `/api/issues/${issue.id}`)).json;
    expect(detail.activity).toContainEqual(expect.objectContaining({ kind: "comment", body: "mergeと完了条件を確認しました" }));
    const reopened = await call(app, "POST", `/api/issues/${issue.id}/update`, { status: "in_review" });
    expect(reopened.json).toMatchObject({ status: "in_review", agentState: null, closedAt: null });
  } finally {
    db.close();
  }
});

test("レビュー提出で稼働状態をクリアし、startで最初の着手日時を保って再開できる", async () => {
  const { app, db, me, ws, llm } = setup();
  try {
    const issue = createIssue(me, { workspaceId: ws.id, title: "指摘を修正する" });
    const started = startIssue(llm, issue.id);
    const review = await call(app, "POST", `/api/issues/${issue.id}/update`, { status: "in_review" });
    expect(review.json).toMatchObject({ status: "in_review", agentState: null, closedAt: null });
    await call(app, "POST", `/api/issues/${issue.id}/update`, { assignee: "me" });
    const resumed = await call(app, "POST", `/api/issues/${issue.id}/start`, {});
    expect(resumed.status).toBe(200);
    expect(resumed.json).toMatchObject({ status: "in_progress", startedAt: started.startedAt, closedAt: null, agentState: "working" });
    expect((await call(app, "POST", `/api/issues/${issue.id}/done`, { summary: "PR不要の作業を完了しました" })).json.status).toBe("done");
  } finally {
    db.close();
  }
});

test("レビュー中の再開・完了も既存の保護と入力検証を守る", async () => {
  const { app, db, me, ws } = setup();
  try {
    const issue = createIssue(me, { workspaceId: ws.id, title: "保護を守る" });
    const path = `/api/issues/${issue.id}`;
    const review = () => call(app, "POST", `${path}/update`, { status: "in_review" });
    const expectRejected = async (operation: string, code: string, body: unknown = {}) => {
      const before = (await call(app, "GET", path)).json;
      const result = await call(app, "POST", `${path}/${operation}`, body);
      expect(result.json.error.code).toBe(code);
      const after = (await call(app, "GET", path)).json;
      expect(after).toMatchObject({ status: before.status, agentState: before.agentState, startedAt: before.startedAt, closedAt: before.closedAt, activity: before.activity });
    };
    await review();
    await call(app, "POST", `${path}/update`, { assignee: "codex" });
    await expectRejected("start", "ASSIGNED_TO_OTHER");
    await call(app, "POST", `${path}/update`, { assignee: null });
    const question = await call(app, "POST", `${path}/ask`, { question: "修正方針を確認したい" });
    await review();
    await expectRejected("start", "AWAITING_ANSWER");
    await call(app, "POST", `${path}/answer`, { questionId: question.json.question.id, answer: "現状の仕様で進める" });
    const blocker = createIssue(me, { workspaceId: ws.id, title: "先行作業" });
    relateIssue(me, blocker.id, { blocks: issue.id });
    await expectRejected("start", "BLOCKED");
    await call(app, "POST", `/api/issues/${blocker.id}/update`, { status: "done" });
    await call(app, "PUT", `/api/workspaces/${ws.key}/transitions`, { forbidden: [{ from: "in_review", to: "in_progress" }, { from: "in_review", to: "done" }] });
    await expectRejected("start", "TRANSITION_NOT_ALLOWED");
    await expectRejected("done", "TRANSITION_NOT_ALLOWED", { summary: "禁止中の報告" });
    for (const [operation, body] of [["done", {}], ["done", { summary: " " }], ["done", { summary: 1 }], ["done", { summary: "報告", actor: "codex" }], ["start", { actor: "codex" }]] as const) {
      const result = await call(app, "POST", `${path}/${operation}`, body);
      expect(result.status).toBe(400);
      expect(result.json.error.code).toBe("INVALID_ARGS");
    }
    await call(app, "POST", `${path}/archive`, {});
    await expectRejected("start", "ISSUE_ARCHIVED");
    await expectRejected("done", "ISSUE_ARCHIVED", { summary: "アーカイブ中の報告" });
  } finally {
    db.close();
  }
});

test("初回仕様判定が未完了のレビュー中Issueは再開できない", async () => {
  const { app, db, me, ws } = setup();
  try {
    await call(app, "PUT", `/api/workspaces/${ws.key}/spec-assessment`, { enabled: true });
    const issue = createIssue(me, { workspaceId: ws.id, title: "仕様判定を待つ" });
    await call(app, "POST", `/api/issues/${issue.id}/update`, { status: "in_review" });
    expect((await call(app, "POST", `/api/issues/${issue.id}/start`, {})).json.error.code).toBe("SPEC_ASSESSMENT_REQUIRED");
    expect((await call(app, "GET", `/api/issues/${issue.id}`)).json.status).toBe("in_review");
  } finally {
    db.close();
  }
});

test("PRの作成後の紐付け・付け替え・merge・close・reopen・取得失敗はIssue状態を変更しない", async () => {
  const { db, me, ws } = setup();
  let state = "OPEN";
  let isDraft = true;
  let failed = false;
  let url = "https://github.com/example/nod/pull/1";
  const app = createApp({ db, ghRunner: async () => failed
    ? { kind: "exited", exitCode: 4, stderr: "", stdout: "" }
    : { kind: "exited", exitCode: 0, stderr: "", stdout: JSON.stringify({ number: Number(url.split("/").at(-1)), title: "変更", url, state, isDraft, reviewDecision: "REVIEW_REQUIRED", mergedAt: state === "MERGED" ? "2026-10-29T00:00:00Z" : null, statusCheckRollup: [] }) } });
  try {
    const issue = createIssue(me, { workspaceId: ws.id, title: "PRと独立した状態" });
    const path = `/api/issues/${issue.id}`;
    for (const status of ["in_progress", "in_review", "done", "canceled"]) {
      await call(app, "POST", `${path}/update`, { status });
      const before = (await call(app, "GET", path)).json;
      for (const number of [1, 2]) {
        url = `https://github.com/example/nod/pull/${number}`;
        expect((await call(app, "POST", `${path}/link-pr`, { url })).json).toMatchObject({ status, prUrl: url });
      }
      for (const prState of ["OPEN", "MERGED", "CLOSED", "OPEN"]) {
        state = prState;
        isDraft = false;
        failed = false;
        expect((await call(app, "POST", `${path}/pr-status/refresh`)).json.status.state).toBe(prState);
        expect((await call(app, "GET", `${path}/pr-status`)).json.prUrl).toBe(url);
        expect((await call(app, "GET", path)).json).toMatchObject({ status, prUrl: url, closedAt: before.closedAt, agentState: before.agentState });
      }
      failed = true;
      expect((await call(app, "POST", `${path}/pr-status/refresh`)).json.fetchError.code).toBe("GH_AUTH");
      const after = (await call(app, "GET", path)).json;
      expect(after).toMatchObject({ status, prUrl: url, closedAt: before.closedAt, agentState: before.agentState });
      expect(after.activity.filter((item: { kind: string; type?: string }) => item.kind === "event" && item.type === "status_changed")).toEqual(before.activity.filter((item: { kind: string; type?: string }) => item.kind === "event" && item.type === "status_changed"));
    }
  } finally {
    db.close();
  }
});

test("レビュー中はReadyに混ざらず依存を解除せず、Projectの完了数にも含まれない", async () => {
  const { app, db, me, ws } = setup();
  try {
    const project = createProject(me, { name: "レビュー進捗" });
    const review = createIssue(me, { workspaceId: ws.id, title: "レビュー待ち", projectRef: String(project.id) });
    const blocked = createIssue(me, { workspaceId: ws.id, title: "依存先", projectRef: String(project.id) });
    relateIssue(me, review.id, { blocks: blocked.id });
    await call(app, "POST", `/api/issues/${review.id}/start`, {});
    await call(app, "POST", `/api/issues/${review.id}/update`, { status: "in_review" });
    const ready = await call(app, "GET", "/api/issues?ready=true");
    expect(ready.json).toMatchObject({ issues: [], counts: { ready: 0 } });
    expect((await call(app, "GET", `/api/issues/${blocked.id}`)).json.blockedBy).toEqual([review.id]);
    expect((await call(app, "POST", `/api/issues/${blocked.id}/start`, {})).json.error.code).toBe("BLOCKED");
    expect((await call(app, "GET", `/api/projects/${project.id}`)).json).toMatchObject({ total: 2, done: 0, agents: { working: 0 } });
    expect((await call(app, "GET", "/api/projects")).json[0]).toMatchObject({ total: 2, done: 0 });
    const flow = (await call(app, "GET", `/api/projects/${project.id}/flow`)).json;
    expect(flow.nodes).toContainEqual(expect.objectContaining({ id: review.id, status: "in_review", ready: false }));
    expect(flow.nodes).toContainEqual(expect.objectContaining({ id: blocked.id, ready: false, openBlockers: [review.id] }));
    await call(app, "POST", `/api/issues/${review.id}/done`, { summary: "完了条件を確認" });
    expect((await call(app, "GET", "/api/issues?ready=true")).json.issues.map((i: { id: string }) => i.id)).toEqual([blocked.id]);
    expect((await call(app, "GET", `/api/projects/${project.id}`)).json).toMatchObject({ total: 2, done: 1 });
  } finally {
    db.close();
  }
});

test("レビュー中の質問は状態や稼働状態を変える対象に追加しない", async () => {
  const { app, db, me, ws } = setup();
  try {
    const issue = createIssue(me, { workspaceId: ws.id, title: "レビュー中の確認" });
    await call(app, "POST", `/api/issues/${issue.id}/update`, { status: "in_review" });
    const asked = await call(app, "POST", `/api/issues/${issue.id}/ask`, { question: "レビュー観点を確認したい" });
    expect(asked.status).toBe(200);
    expect(asked.json.issue).toMatchObject({ status: "in_review", agentState: null });
    expect((await call(app, "GET", `/api/issues/${issue.id}`)).json).toMatchObject({ status: "in_review", agentState: null });
  } finally {
    db.close();
  }
});
