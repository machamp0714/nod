import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { askQuestion, completeIssue, nextIssue, startIssue, suggestIssue } from "../src/ops/agent";
import { attachDocument } from "../src/ops/documents";
import { acceptTriage, answerQuestion, getInbox, listTriage } from "../src/ops/human";
import {
  archiveIssue,
  commentIssue,
  copyIssue,
  createIssue,
  getIssue,
  listIssues,
  queryIssues,
  relateIssue,
  unarchiveIssue,
  updateIssue,
} from "../src/ops/issues";
import { setPlanTasks } from "../src/ops/plan";
import { getProject, listProjects } from "../src/ops/projects";
import { diagnoseIssues } from "../src/ops/diagnose";
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

test("人以外の非 LLM の書き手（自動アーカイブ）も呼べるよう、判定は isLlm に従う", () => {
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
  archiveIssue(me, issue.id);
  const doc = join(tempDbPath(), "..", "spec.md");
  writeFileSync(doc, "# 仕様\n");

  const attempts: [string, () => unknown][] = [
    ["update", () => updateIssue(me, issue.id, { title: "変更" })],
    ["comment", () => commentIssue(me, issue.id, "コメント")],
    ["relate", () => relateIssue(me, issue.id, { related: other.id })],
    ["relate to archived", () => relateIssue(me, other.id, { related: issue.id })],
    ["parent", () => updateIssue(me, other.id, { parentRef: issue.id })],
    ["create child", () => createIssue(me, { workspaceId: ws.id, title: "子", parentRef: issue.id })],
    ["answer", () => answerQuestion(me, issue.id, "回答")],
    ["ask", () => askQuestion(llm, issue.id, "追加")],
    ["done", () => completeIssue(llm, issue.id, { summary: "済" })],
    ["plan", () => setPlanTasks(llm, issue.id, ["a"])],
    ["attach", () => attachDocument(me, { issueRef: issue.id }, { path: doc })],
  ];
  for (const [name, run] of attempts) expect([name, codeOf(run)]).toEqual([name, "ISSUE_ARCHIVED"]);
  expect(codeOf(() => startIssue(llm, other.id))).toBeUndefined();

  const triage = createIssue(llm, { workspaceId: ws.id, title: "t" });
  archiveIssue(me, triage.id);
  expect(codeOf(() => acceptTriage(me, triage.id))).toBe("ISSUE_ARCHIVED");
});

test("アーカイブ済みの Issue を複製すると、複製はアーカイブされていない", () => {
  const { me, ws } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "x" });
  archiveIssue(me, issue.id);
  expect(copyIssue(me, issue.id).archivedAt).toBeNull();
});
