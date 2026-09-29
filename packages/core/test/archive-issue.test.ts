import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { askQuestion, completeIssue, failIssue, nextIssue, startIssue, suggestIssue } from "../src/ops/agent";
import { attachDocument, detachDocument, getDocument, unlinkDocumentById } from "../src/ops/documents";
import {
  acceptTriage,
  answerQuestion,
  approveReview,
  declineTriage,
  duplicateTriage,
  getInbox,
  listTriage,
  rejectReview,
  snoozeTriage,
} from "../src/ops/human";
import {
  archiveIssue,
  commentIssue,
  copyIssue,
  createIssue,
  getIssue,
  listIssues,
  queryIssues,
  relateIssue,
  resolveThread,
  unarchiveIssue,
  updateIssue,
} from "../src/ops/issues";
import { importPlan, setPlanTasks, setStep } from "../src/ops/plan";
import { getProject, listProjects } from "../src/ops/projects";
import { diagnoseIssues } from "../src/ops/diagnose";
import { isSubscribed, listNotifications, subscribeIssue, unsubscribeIssue } from "../src/ops/notifications";
import { validateIssueQuery } from "../src/issue-filter";
import { addProjectRow, codeOf, eventsOf, setup, tempDbPath } from "./helpers";

test("アーカイブすると archivedAt が入り、status は変わらず archived の event が残る", () => {
  const { me, ws, db } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "古い" });
  updateIssue(me, issue.id, { status: "in_progress" });
  const archived = archiveIssue(me, issue.id, { reason: "不要になった" });
  expect(archived.archivedAt).not.toBeNull();
  expect(archived.status).toBe("in_progress");
  expect(eventsOf(db, issue.id).at(-1)).toEqual({ type: "archived", actor: "me", data: { reason: "不要になった" } });

  const restored = unarchiveIssue(me, issue.id);
  expect(restored.archivedAt).toBeNull();
  expect(restored.status).toBe("in_progress");
  expect(eventsOf(db, issue.id).at(-1)).toEqual({ type: "unarchived", actor: "me", data: {} });
});

test("すでにアーカイブ済み・未アーカイブなら何もせず event も書かない", () => {
  const { me, ws, db } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "x" });
  unarchiveIssue(me, issue.id);
  const first = archiveIssue(me, issue.id);
  const again = archiveIssue(me, issue.id);
  expect(again.archivedAt).toBe(first.archivedAt);
  expect(eventsOf(db, issue.id).filter((e) => e.type === "archived" || e.type === "unarchived")).toHaveLength(1);
});

test("LLM はアーカイブも復元もできない", () => {
  const { me, llm, ws } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "x" });
  expect(codeOf(() => archiveIssue(llm, issue.id))).toBe("FORBIDDEN_FOR_LLM");
  archiveIssue(me, issue.id);
  expect(codeOf(() => unarchiveIssue(llm, issue.id))).toBe("FORBIDDEN_FOR_LLM");
  expect(getIssue(me.db, issue.id).archivedAt).not.toBeNull();
});

test("自動アーカイブ（#72）は me として呼び、理由を event に残せる", () => {
  const { me, ws, db } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "x" });
  // #72 の自動アーカイブは me として同じ関数を呼ぶ
  archiveIssue({ db, actor: "me" }, issue.id, { reason: "完了から30日" });
  expect(eventsOf(db, issue.id).at(-1)?.data).toEqual({ reason: "完了から30日" });
});

test("アーカイブ済みは既定の一覧・検索・件数から除き、archived=true ではアーカイブ済みだけを返す", () => {
  const { me, ws, db } = setup();
  const keep = createIssue(me, { workspaceId: ws.id, title: "検索 残す" });
  const gone = createIssue(me, { workspaceId: ws.id, title: "検索 消す" });
  const doneGone = createIssue(me, { workspaceId: ws.id, title: "完了 消す" });
  updateIssue(me, doneGone.id, { status: "done" });
  archiveIssue(me, gone.id);
  archiveIssue(me, doneGone.id);

  expect(listIssues(db).map((i) => i.id)).toEqual([keep.id]);
  expect(listIssues(db, { statuses: ["todo", "done"] }).map((i) => i.id)).toEqual([keep.id]);
  expect(listIssues(db, { query: "検索" }).map((i) => i.id)).toEqual([keep.id]);
  expect(listIssues(db, { archived: true }).map((i) => i.id)).toEqual([gone.id, doneGone.id]);

  const all = queryIssues(db, {});
  expect(all.issues.map((i) => i.id)).toEqual([keep.id]);
  expect(all.counts.ready).toBe(1);
  const archivedOnly = queryIssues(db, { archived: true });
  expect(archivedOnly.issues.map((i) => i.id)).toEqual([gone.id, doneGone.id]);
  expect(archivedOnly.counts.ready).toBe(0);
  expect(queryIssues(db, { archived: true, q: "完了" }).issues.map((i) => i.id)).toEqual([doneGone.id]);
});

test("絞り込み条件の archived は真偽値だけを受け付け、false は省略と同じ", () => {
  expect(validateIssueQuery({ archived: true })).toEqual({ archived: true });
  expect(validateIssueQuery({ archived: false })).toEqual({});
  expect(() => validateIssueQuery({ archived: "yes" })).toThrow("archived");
});

test("アーカイブ済みは next・suggest・Triage・Inbox・Project の件数から外れる", () => {
  const { me, llm, ws, db } = setup();
  addProjectRow(db, "P");
  const ready = createIssue(me, { workspaceId: ws.id, title: "着手できる", projectRef: "P", priority: 1 });
  const triage = createIssue(llm, { workspaceId: ws.id, title: "トリアージ" });
  const asked = createIssue(me, { workspaceId: ws.id, title: "質問あり" });
  startIssue(llm, asked.id);
  askQuestion(llm, asked.id, "どうする？");
  const review = createIssue(me, { workspaceId: ws.id, title: "レビュー" });
  startIssue(llm, review.id);
  completeIssue(llm, review.id, { summary: "済" });
  for (const i of [ready, triage, asked, review]) archiveIssue(me, i.id);

  expect(suggestIssue(llm, { workspaceId: ws.id })).toBeNull();
  expect(nextIssue(llm, { workspaceId: ws.id })).toBeNull();
  expect(listTriage(db)).toEqual([]);
  const inbox = getInbox(db, { includeAnswered: true });
  expect(inbox.questions).toEqual([]);
  expect(inbox.reviews).toEqual([]);
  const project = getProject(db, "P");
  expect(project.issues).toEqual([]);
  expect(project.total).toBe(0);
  expect(listProjects(db)[0]?.total).toBe(0);
  expect(diagnoseIssues(db, { workspaceId: ws.id, staleDays: 1, evaluatedAt: "2100-01-01T00:00:00.000Z" }).findings).toEqual([]);
});

test("親をアーカイブしても子は残り、親の詳細の子一覧からはアーカイブ済みの子を除く", () => {
  const { me, ws, db } = setup();
  const parent = createIssue(me, { workspaceId: ws.id, title: "親" });
  const child = createIssue(me, { workspaceId: ws.id, title: "子", parentRef: parent.id });
  const archivedChild = createIssue(me, { workspaceId: ws.id, title: "消す子", parentRef: parent.id });
  archiveIssue(me, parent.id);
  archiveIssue(me, archivedChild.id);

  expect(getIssue(db, child.id).archivedAt).toBeNull();
  expect(getIssue(db, child.id).parentId).toBe(parent.id);
  expect(listIssues(db).map((i) => i.id)).toEqual([child.id]);
  expect(getIssue(db, parent.id).children.map((c) => c.id)).toEqual([child.id]);
  unarchiveIssue(me, parent.id);
  expect(getIssue(db, parent.id).children.map((c) => c.id)).toEqual([child.id]);
});

test("アーカイブ済みはブロッカーとして数えず、復元すると再びブロックする", () => {
  const { me, llm, ws, db } = setup();
  const blocker = createIssue(me, { workspaceId: ws.id, title: "先" });
  const blocked = createIssue(me, { workspaceId: ws.id, title: "後" });
  relateIssue(me, blocker.id, { blocks: blocked.id });
  archiveIssue(me, blocker.id);

  expect(getIssue(db, blocked.id).blockedBy).toEqual([]);
  expect(getIssue(db, blocked.id).relations.blockedBy).toEqual([blocker.id]);
  expect(queryIssues(db, { blocked: true }).issues).toEqual([]);
  expect(queryIssues(db, { ready: true }).issues.map((i) => i.id)).toEqual([blocked.id]);
  expect(suggestIssue(llm, { workspaceId: ws.id })?.id).toBe(blocked.id);

  unarchiveIssue(me, blocker.id);
  expect(getIssue(db, blocked.id).blockedBy).toEqual([blocker.id]);
  expect(codeOf(() => startIssue(llm, blocked.id))).toBe("BLOCKED");
});

test("アーカイブ済みの Issue は復元以外の書き込みを ISSUE_ARCHIVED で拒否する", () => {
  const { me, llm, ws, db } = setup();
  const other = createIssue(me, { workspaceId: ws.id, title: "別" });
  const issue = createIssue(me, { workspaceId: ws.id, title: "x" });
  startIssue(llm, issue.id);
  askQuestion(llm, issue.id, "質問");
  const thread = commentIssue(me, issue.id, "スレッド");
  setPlanTasks(llm, issue.id, ["a"]);
  const dir = join(tempDbPath(), "..");
  const doc = join(dir, "spec.md");
  writeFileSync(doc, "# 仕様\n");
  const linked = join(dir, "linked.md");
  writeFileSync(linked, "# 添付済み\n");
  const plan = join(dir, "plan.md");
  writeFileSync(plan, "### Task 1: 作る\n");
  const attached = attachDocument(me, { issueRef: issue.id }, { path: linked });
  archiveIssue(me, issue.id);

  const attempts: [string, () => unknown][] = [
    ["update", () => updateIssue(me, issue.id, { title: "変更" })],
    ["comment", () => commentIssue(me, issue.id, "コメント")],
    ["reply", () => commentIssue(me, issue.id, "返信", { replyTo: thread.id })],
    ["resolve thread", () => resolveThread(me, issue.id, thread.id, true)],
    ["relate", () => relateIssue(me, issue.id, { related: other.id })],
    ["relate to archived", () => relateIssue(me, other.id, { related: issue.id })],
    ["parent", () => updateIssue(me, other.id, { parentRef: issue.id })],
    ["create child", () => createIssue(me, { workspaceId: ws.id, title: "子", parentRef: issue.id })],
    ["answer", () => answerQuestion(me, issue.id, "回答")],
    ["ask", () => askQuestion(llm, issue.id, "追加")],
    ["done", () => completeIssue(llm, issue.id, { summary: "済" })],
    ["plan", () => setPlanTasks(llm, issue.id, ["a"])],
    ["import plan", () => importPlan(llm, issue.id, plan)],
    ["step", () => setStep(llm, issue.id, "1", "done")],
    ["attach", () => attachDocument(me, { issueRef: issue.id }, { path: doc })],
    ["detach", () => detachDocument(me, { issueRef: issue.id }, linked)],
    ["unlink", () => unlinkDocumentById(me, attached.id, { issueRef: issue.id })],
    ["start", () => startIssue(llm, issue.id)],
    ["fail", () => failIssue(llm, issue.id, "失敗")],
    ["approve", () => approveReview(me, issue.id)],
    ["reject", () => rejectReview(me, issue.id, "差し戻し")],
    ["estimate", () => updateIssue(me, issue.id, { estimate: 3 })],
    ["due date", () => updateIssue(me, issue.id, { dueDate: "2026-10-01" })],
  ];
  for (const [name, run] of attempts) expect([name, codeOf(run)]).toEqual([name, "ISSUE_ARCHIVED"]);
  expect(codeOf(() => startIssue(llm, other.id))).toBeUndefined();

  const triage = createIssue(llm, { workspaceId: ws.id, title: "t" });
  archiveIssue(me, triage.id);
  const triageAttempts: [string, () => unknown][] = [
    ["accept", () => acceptTriage(me, triage.id)],
    ["decline", () => declineTriage(me, triage.id, "不要")],
    ["snooze", () => snoozeTriage(me, triage.id, "2100-01-01")],
    ["duplicate", () => duplicateTriage(me, triage.id, other.id)],
  ];
  for (const [name, run] of triageAttempts) expect([name, codeOf(run)]).toEqual([name, "ISSUE_ARCHIVED"]);
});

test("アーカイブ済みの Issue を Triage の重複元にはできない", () => {
  const { me, llm, ws, db } = setup();
  const original = createIssue(me, { workspaceId: ws.id, title: "元" });
  archiveIssue(me, original.id);
  const triage = createIssue(llm, { workspaceId: ws.id, title: "t" });
  expect(codeOf(() => duplicateTriage(me, triage.id, original.id))).toBe("ISSUE_ARCHIVED");
  expect(getIssue(db, triage.id).status).toBe("triage");
  expect(getIssue(db, original.id).relations.duplicates).toEqual([]);
});

test("購読・購読解除は自分の通知設定なので、アーカイブ済みでもできる", () => {
  const { me, ws, db } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "x" });
  archiveIssue(me, issue.id);
  subscribeIssue(me, issue.id);
  expect(isSubscribed(db, issue.id)).toBe(true);
  unsubscribeIssue(me, issue.id);
  expect(isSubscribed(db, issue.id)).toBe(false);
});

test("Document の関連 Issue に、アーカイブ済みかどうかを含める", () => {
  const { me, ws, db } = setup();
  const live = createIssue(me, { workspaceId: ws.id, title: "生きている" });
  const gone = createIssue(me, { workspaceId: ws.id, title: "アーカイブ" });
  const path = join(tempDbPath(), "..", "doc.md");
  writeFileSync(path, "# d\n");
  const doc = attachDocument(me, { issueRef: live.id }, { path });
  attachDocument(me, { issueRef: gone.id }, { path });
  archiveIssue(me, gone.id);
  expect(getDocument(db, doc.id).issues.map((i) => [i.id, i.archived])).toEqual([[live.id, false], [gone.id, true]]);
});

test("アーカイブ済みの Issue を複製すると、複製はアーカイブされていない", () => {
  const { me, ws } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "x" });
  archiveIssue(me, issue.id);
  expect(copyIssue(me, issue.id).archivedAt).toBeNull();
});

test("アーカイブ済みの Issue の通知は Inbox の通知に出さず、復元すると戻る", () => {
  const { me, llm, ws, db } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "購読中" });
  subscribeIssue(me, issue.id);
  commentIssue(llm, issue.id, "進捗");
  expect(listNotifications(db).map((n) => n.issueId)).toEqual([issue.id]);
  archiveIssue(me, issue.id);
  expect(listNotifications(db, { includeRead: true })).toEqual([]);
  unarchiveIssue(me, issue.id);
  expect(listNotifications(db).map((n) => n.issueId)).toEqual([issue.id]);
});

test("親の完了候補は、アーカイブ済みの親を候補にせず、アーカイブ済みの子を数えない", () => {
  const { me, ws, db } = setup();
  const parent = createIssue(me, { workspaceId: ws.id, title: "親" });
  const done = createIssue(me, { workspaceId: ws.id, title: "済んだ子", parentRef: parent.id });
  updateIssue(me, done.id, { status: "done" });
  const left = createIssue(me, { workspaceId: ws.id, title: "残った子", parentRef: parent.id });
  expect(getIssue(db, parent.id).completionCandidate).toBe(false);

  // 未完了の子をアーカイブすると、残りの子がすべて完了なので候補になる
  archiveIssue(me, left.id);
  expect(getIssue(db, parent.id).completionCandidate).toBe(true);
  expect(listIssues(db, { completionCandidate: true }).map((i) => i.id)).toEqual([parent.id]);

  // アーカイブ済みの親は完了にできないので候補にしない
  archiveIssue(me, parent.id);
  expect(getIssue(db, parent.id).completionCandidate).toBe(false);
  unarchiveIssue(me, parent.id);

  // 完了した子もアーカイブすると、数える子が無いので候補にならない
  archiveIssue(me, done.id);
  expect(getIssue(db, parent.id).completionCandidate).toBe(false);
});
