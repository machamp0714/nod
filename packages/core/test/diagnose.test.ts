import { expect, test } from "bun:test";
import { diagnoseIssues } from "../src/ops/diagnose";
import { createIssue, relateIssue, updateIssue } from "../src/ops/issues";
import { initWorkspace } from "../src/ops/workspaces";
import { findIssueRow } from "../src/issue-query";
import { addProjectRow, codeOf, setup } from "./helpers";

const at = "2026-09-29T00:00:00.000Z";
const old = "2026-09-22T00:00:00.000Z";
function fixture() {
  const s = setup();
  const make = (status = "in_progress", stamp = old, workspaceId = s.ws.id, projectRef?: string) => {
    const issue = createIssue(s.me, { workspaceId, title: status, projectRef });
    const id = findIssueRow(s.db, issue.id).id;
    s.db.query("UPDATE issues SET status=?, created_at=?, updated_at=? WHERE id=?").run(status, stamp, stamp, id);
    s.db.query("UPDATE events SET created_at=? WHERE issue_id=?").run(stamp, id);
    return { ...issue, rowId: id };
  };
  const diagnose = () => diagnoseIssues(s.db, { workspaceId: s.ws.id, staleDays: 7, evaluatedAt: at });
  return { ...s, make, diagnose };
}

test("停滞は対象3statusに限定し、UTCの閾値一致を含め、未来・不正日時を除く", () => {
  const { make, diagnose } = fixture();
  const first = make();
  const review = make("in_review", "2026-09-22T09:00:00+09:00");
  const clarification = make("needs_clarification", "2026-09-21T23:59:59.999Z");
  make("in_progress", "2026-09-22T00:00:00.001Z");
  for (const status of ["triage", "backlog", "todo", "done", "canceled"]) make(status);
  make("in_progress", "2027-01-01T00:00:00Z");
  make("in_progress", "2026-02-30T00:00:00Z");
  expect(diagnose().findings.map(f => f.issue.id)).toEqual([first.id, review.id, clarification.id]);
});

test("質問・回答・コメント・event・更新日時のいずれかが新しければ停滞を解除する", () => {
  const { db, make, diagnose } = fixture();
  for (const source of ["asked", "answered", "comment", "event", "updated"]) {
    const issue = make();
    const recent = "2026-09-28T00:00:00Z";
    if (source === "asked" || source === "answered") db.query("INSERT INTO questions(issue_id,question,asked_by,asked_at,answer,answered_by,answered_at) VALUES (?, '質問', 'me', ?, ?, ?, ?)").run(issue.rowId, source === "asked" ? recent : old, source === "answered" ? "回答" : null, source === "answered" ? "me" : null, source === "answered" ? recent : null);
    if (source === "comment") db.query("INSERT INTO comments(issue_id,author,body,created_at) VALUES (?, 'me', '記録', ?)").run(issue.rowId, recent);
    if (source === "event") db.query("INSERT INTO events(issue_id,actor,type,data,created_at) VALUES (?, 'me', 'document_attached', '{}', ?)").run(issue.rowId, recent);
    if (source === "updated") db.query("UPDATE issues SET updated_at=? WHERE id=?").run(recent, issue.rowId);
  }
  expect(diagnose().findings).toEqual([]);
});

test("直接ブロッカーは範囲外も理由に残し、終端・推移的関係を除き、全テーブルを変更しない", () => {
  const { db, ws, me, make, diagnose } = fixture();
  const other = initWorkspace(db, { path: "/tmp/diagnose-other", key: "OTHER" }).workspace;
  const target = make("todo");
  const first = make("todo", old, other.id);
  const second = make("todo", old, other.id);
  const indirect = make("todo", old, other.id);
  relateIssue(me, first.id, { blocks: target.id });
  relateIssue(me, second.id, { blocks: target.id });
  relateIssue(me, indirect.id, { blocks: first.id });
  const done = make("done"), canceled = make("canceled");
  relateIssue(me, done.id, { blocks: target.id });
  relateIssue(me, canceled.id, { blocks: target.id });
  relateIssue(me, first.id, { blocks: done.id });
  const before = db.serialize();
  const result = diagnose();
  expect(result.findings.map(f => f.issue.id)).toEqual([target.id]);
  expect(result.findings[0]?.reasons).toEqual([{ type: "blocked", blockedBy: [first.id, second.id] }]);
  expect(db.serialize()).toEqual(before);
  updateIssue(me, first.id, { status: "done" });
  updateIssue(me, second.id, { status: "canceled" });
  expect(diagnose().findings).toEqual([]);
  expect(ws.id).not.toBe(other.id);
});

test("snoozeは未来だけ停滞を抑制し、複数理由・Project・他担当を維持する", () => {
  const { db, ws, me, make, diagnose } = fixture();
  addProjectRow(db, "対象");
  const outside = make();
  const both = make("in_progress", old, ws.id, "対象");
  const snoozed = make();
  db.query("UPDATE issues SET assignee='other-agent', snoozed_until=? WHERE id=?").run(at, both.rowId);
  db.query("UPDATE issues SET snoozed_until='2026-09-29T00:00:00.001Z' WHERE id=?").run(snoozed.rowId);
  relateIssue(me, outside.id, { blocks: both.id });
  relateIssue(me, outside.id, { blocks: snoozed.id });
  const result = diagnoseIssues(db, { workspaceId: ws.id, projectRef: "対象", staleDays: 7, evaluatedAt: at });
  expect(result.findings.map(f => f.issue.id)).toEqual([both.id]);
  expect(result.findings[0]?.reasons.map(r => r.type)).toEqual(["blocked", "stale"]);
  expect(diagnose().findings.find(f => f.issue.id === snoozed.id)?.reasons).toEqual([{ type: "blocked", blockedBy: [outside.id] }]);
  expect(codeOf(() => diagnoseIssues(db, { workspaceId: ws.id, projectRef: "不存在", staleDays: 7 }))).toBe("NOT_FOUND");
});

test("coreも無効な閾値を拒否し、不正日時は有効な活動日時を上書きしない", () => {
  const { db, ws, make, diagnose } = fixture();
  const issue = make();
  db.query("UPDATE issues SET updated_at='壊れた日時' WHERE id=?").run(issue.rowId);
  expect(diagnose().findings[0]?.lastActivityAt).toBe(old);
  for (const staleDays of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    expect(codeOf(() => diagnoseIssues(db, { workspaceId: ws.id, staleDays }))).toBe("INVALID_ARGS");
  }
});
