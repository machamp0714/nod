import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askQuestion, completeIssue, startIssue } from "../src/ops/agent";
import { acceptTriage, answerQuestion, getInbox } from "../src/ops/human";
import { createIssue, commentIssue, getIssue, updateIssue } from "../src/ops/issues";
import { attachDocument, detachDocument } from "../src/ops/documents";
import { addProjectRow, codeOf, eventsOf, setup } from "./helpers";

test("Reviewsは報告IDを優先し同一msの後続コメントと旧eventを区別する", () => {
  const { db, ws, me, llm } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "報告" });
  startIssue(llm, issue.id);
  completeIssue(llm, issue.id, { summary: "本来の報告" });
  commentIssue(me, issue.id, "後の雑談");
  db.query("UPDATE comments SET created_at = '2026-09-28T00:00:00Z'").run();
  db.query("UPDATE events SET created_at = '2026-09-28T00:00:00Z' WHERE type='status_changed' AND json_extract(data, '$.to')='in_review'").run();
  expect(getInbox(db).reviews[0]).toMatchObject({ reviewSummary: "本来の報告", reviewReport: { body: "本来の報告", actor: "claude-code" }, reviewSubmittedAt: "2026-09-28T00:00:00Z" });
  db.query("UPDATE events SET data=json_remove(data,'$.report_comment_id') WHERE type='status_changed'").run();
  expect(getInbox(db).reviews[0]!.reviewSummary).toBe("後の雑談");
  db.query("UPDATE events SET data=json_set(data,'$.report_comment_id',99999) WHERE type='status_changed'").run();
  expect(getInbox(db).reviews[0]!.reviewSummary).toBeNull();
  db.close();
});

test("acceptは属性と状態を原子的に保存し、失敗・再実行・LLMに部分更新を残さない", () => {
  const { db, ws, me, llm } = setup();
  const projectId = addProjectRow(db, "検索");
  const issue = createIssue(llm, { workspaceId: ws.id, title: "発見", labels: ["old"] });
  const before = getIssue(db, issue.id);
  const eventCount = eventsOf(db, issue.id).length;
  expect(codeOf(() => acceptTriage(me, issue.id, { priority: 1, projectRef: "不明" }))).toBe("NOT_FOUND");
  expect(getIssue(db, issue.id)).toEqual(before);
  expect(eventsOf(db, issue.id)).toHaveLength(eventCount);
  expect(codeOf(() => acceptTriage(llm, issue.id, { priority: 1 }))).toBe("FORBIDDEN_FOR_LLM");
  askQuestion(llm, issue.id, "判断");
  const accepted = acceptTriage(me, issue.id, { priority: 0, projectRef: String(projectId), addLabels: ["bug"], removeLabels: ["old"] });
  expect(accepted).toMatchObject({ status: "needs_clarification", priority: 0, project: { id: projectId }, labels: ["bug"] });
  expect(codeOf(() => acceptTriage(me, issue.id, { priority: 2 }))).toBe("NOT_IN_TRIAGE");
  answerQuestion(me, issue.id, "よい");
  expect(getIssue(db, issue.id).status).toBe("todo");
  db.close();
});

test("質問履歴はmeを除外して終端も含み、通常終端の回答は再開しない", () => {
  const { db, ws, me, llm } = setup();
  const active = createIssue(me, { workspaceId: ws.id, title: "未回答" });
  askQuestion(llm, active.id, "未回答LLM");
  askQuestion(me, active.id, "meの未決");
  const finished = createIssue(me, { workspaceId: ws.id, title: "終端" });
  const q = askQuestion(llm, finished.id, "終端で回答").question;
  updateIssue(me, finished.id, { status: "canceled" });
  expect(getInbox(db).questions.map(q => q.question)).toEqual(["未回答LLM"]);
  expect(getInbox(db, { includeAnswered: true }).questions).toHaveLength(2);
  answerQuestion(me, finished.id, "記録", { questionId: q.id });
  expect(getIssue(db, finished.id)).toMatchObject({ status: "canceled", agentState: null });
  expect(getInbox(db, { includeAnswered: true }).questions.find(x => x.id === q.id)?.answer).toBe("記録");
  db.close();
});

test("添付情報は現在linkの最新eventを使い、別Issue・重複・旧記録を混ぜない", () => {
  const { db, ws, me, llm } = setup();
  const path = join(mkdtempSync(join(tmpdir(), "nod-doc-")), "設計.md");
  writeFileSync(path, "# 設計\n本文");
  const a = createIssue(me, { workspaceId: ws.id, title: "A" });
  const b = createIssue(me, { workspaceId: ws.id, title: "B" });
  attachDocument(llm, { issueRef: a.id }, { path });
  attachDocument(me, { issueRef: b.id }, { path });
  const first = getIssue(db, a.id).documents[0]!;
  expect(first.attachedBy).toBe("claude-code");
  expect(first.attachedAt).toBeString();
  expect(getIssue(db, b.id).documents[0]!.attachedBy).toBe("me");
  attachDocument(me, { issueRef: a.id }, { path });
  expect(getIssue(db, a.id).documents[0]).toEqual(first);
  detachDocument(me, { issueRef: a.id }, path);
  expect(getIssue(db, a.id).documents).toEqual([]);
  attachDocument(me, { issueRef: a.id }, { path });
  expect(getIssue(db, a.id).documents[0]!.attachedBy).toBe("me");
  for (const value of ["2026-02-30T00:00:00Z", "2026-02-29T00:00:00Z", "2026-09-28", "2026-09-28T24:00:00Z", "bad"]) {
    db.query("UPDATE events SET created_at=? WHERE type='document_attached'").run(value);
    expect(getIssue(db, a.id).documents[0]!.attachedAt).toBeNull();
  }
  for (const value of ["2024-02-29T00:00:00Z", "2026-09-28T09:00:00+09:00", "2026-09-28T00:00:00.123Z"]) {
    db.query("UPDATE events SET created_at=? WHERE type='document_attached'").run(value);
    expect(getIssue(db, a.id).documents[0]!.attachedAt).toBe(value);
  }
  db.query("DELETE FROM events WHERE type='document_attached'").run();
  expect(getIssue(db, a.id).documents[0]).toMatchObject({ attachedBy: null, attachedAt: null });
  db.close();
});

test.each(["done", "canceled", "backlog"] as const)("旧%sのawaiting_inputは回答しても作業中にしない", (status) => {
  const { db, ws, me, llm } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "旧データ" });
  const q = askQuestion(llm, issue.id, "未回答").question;
  updateIssue(me, issue.id, { status });
  db.query("UPDATE issues SET agent_state='awaiting_input' WHERE number=?").run(issue.number);
  answerQuestion(me, issue.id, "記録", { questionId: q.id });
  expect(getIssue(db, issue.id)).toMatchObject({ status: status === "backlog" ? "backlog" : status, agentState: "awaiting_input" });
  db.close();
});

test("報告IDは別Issueのcommentや文字列IDを採用せず、報告がない手動reviewはnull", () => {
  const { db, ws, me, llm } = setup();
  const other = createIssue(me, { workspaceId: ws.id, title: "別のIssue" });
  const comment = commentIssue(me, other.id, "他人の報告");
  const issue = createIssue(me, { workspaceId: ws.id, title: "手動review" });
  updateIssue(me, issue.id, { status: "in_review" });
  expect(getInbox(db).reviews[0]?.reviewReport).toBeNull();
  db.query("UPDATE events SET data=json_set(data,'$.report_comment_id',?) WHERE json_extract(data,'$.to')='in_review'").run(comment.id);
  expect(getInbox(db).reviews[0]?.reviewReport).toBeNull();
  updateIssue(me, issue.id, { status: "in_progress" });
  completeIssue(llm, issue.id, { summary: "正しい報告" });
  expect(getInbox(db).reviews[0]?.reviewSummary).toBe("正しい報告");
  db.query("UPDATE events SET data=json_set(data,'$.report_comment_id',CAST(json_extract(data,'$.report_comment_id') AS TEXT)) WHERE json_extract(data,'$.to')='in_review'").run();
  expect(getInbox(db).reviews[0]?.reviewReport).toBeNull();
  db.close();
});
