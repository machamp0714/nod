import type { Database } from "bun:sqlite";
import { isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { invalidSprint, sprintHash, sprintObject, sprintText } from "../sprint-validation";
import type { SprintClock } from "../sprint-types";
import type { AddSprintRecordInput, SprintFeedbackContent, SprintOutcomeContent, SprintRecord, SprintRecordLink } from "../sprint-record-types";
import { resolveSprint } from "./sprints";

interface RecordRow {
  id: string; sprint_id: string; kind: SprintRecord["kind"]; content: string;
  recorded_by: string; recorded_at: string; corrects_record_id: string | null; input_hash: string;
}

function toRecord(row: RecordRow): SprintRecord {
  return { id: row.id, sprintId: row.sprint_id, kind: row.kind, content: JSON.parse(row.content),
    recordedBy: row.recorded_by, recordedAt: row.recorded_at, correctsRecordId: row.corrects_record_id };
}

export function listSprintRecords(db: Database, ref: string): SprintRecord[] {
  const sprint = resolveSprint(db, ref);
  return (db.query("SELECT * FROM sprint_records WHERE sprint_id=? ORDER BY rowid").all(sprint.id) as RecordRow[]).map(toRecord);
}

function recordText(value: unknown, label: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 8000) return invalidSprint(`${label}は8000文字以内の文字列で指定してください`);
  return value.trim();
}

export function sprintRecordLinks(value: unknown): SprintRecordLink[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) return invalidSprint("関連リンクは50件以内の配列で指定してください");
  return value.map(raw => {
    const link = sprintObject(raw, ["kind", "ref", "label"], "関連リンク");
    if (!["document", "issue", "url"].includes(link.kind as string)) return invalidSprint("関連リンクの種類が不正です");
    const ref = sprintText(link.ref, "関連リンクの参照");
    if (ref.length > 2048) return invalidSprint("関連リンクが長すぎます");
    if (link.kind === "document" && !/^[1-9]\d*$/.test(ref)) return invalidSprint("DocumentはIDで指定してください");
    if (link.kind === "issue" && !/^[A-Z0-9]{2,6}-[1-9]\d*$/i.test(ref)) return invalidSprint("IssueはIssueキーで指定してください");
    if (link.kind === "url") {
      try { if (!["http:", "https:"].includes(new URL(ref).protocol)) return invalidSprint("URLはhttpまたはhttpsで指定してください"); }
      catch { return invalidSprint("有効なURLを指定してください"); }
    }
    const label = link.label === undefined ? undefined : sprintText(link.label, "リンク名");
    if (label && label.length > 255) return invalidSprint("リンク名は255文字以内で指定してください");
    return { kind: link.kind as SprintRecordLink["kind"], ref, ...(label ? { label } : {}) };
  });
}

function outcomeContent(value: unknown): SprintOutcomeContent {
  const content = sprintObject(value, ["summary", "howToTry", "tests", "testResult", "links"], "成果");
  const summary = recordText(content.summary, "変更の要約"), howToTry = recordText(content.howToTry, "試し方"), tests = recordText(content.tests, "実施したテスト");
  const links = sprintRecordLinks(content.links);
  const testResult = content.testResult === undefined ? "unverified" : content.testResult;
  if (!["passed", "failed", "unverified"].includes(testResult as string)) return invalidSprint("テスト結果は合格・不合格・未確認で指定してください");
  if (!summary && !howToTry && !tests && !links.length) return invalidSprint("空の成果は記録できません");
  return { summary, howToTry, tests, testResult: testResult as SprintOutcomeContent["testResult"], links };
}

function feedbackContent(value: unknown): SprintFeedbackContent {
  const content = sprintObject(value, ["helpful", "difficulties", "requests"], "利用者の感想");
  const helpful = recordText(content.helpful, "役立った点"), difficulties = recordText(content.difficulties, "困った点"), requests = recordText(content.requests, "次の要望");
  if (!helpful && !difficulties && !requests) return invalidSprint("空の感想は記録できません");
  return { helpful, difficulties, requests };
}

export function addSprintRecord(ctx: OpCtx, ref: string, input: AddSprintRecordInput, clock: SprintClock = {}): SprintRecord {
  sprintObject(input, ["requestKey", "kind", "content", "correctsRecordId"]);
  const requestKey = sprintText(input.requestKey, "requestKey");
  if (input.kind !== "outcome" && input.kind !== "feedback") return invalidSprint("記録の種類が不正です");
  if (input.kind === "feedback" && isLlm(ctx)) throw new NodError("FORBIDDEN_FOR_LLM", "利用者の感想は本人だけが記録できます");
  const content = input.kind === "outcome" ? outcomeContent(input.content) : feedbackContent(input.content);
  const correctsRecordId = input.correctsRecordId === undefined ? null : sprintText(input.correctsRecordId, "訂正元の記録");
  const inputHash = sprintHash({ kind: input.kind, content, correctsRecordId });
  return tx(ctx.db, () => {
    const sprint = resolveSprint(ctx.db, ref);
    const prior = ctx.db.query("SELECT * FROM sprint_records WHERE sprint_id=? AND recorded_by=? AND request_key=?").get(sprint.id, ctx.actor, requestKey) as RecordRow | null;
    if (prior) {
      if (prior.input_hash !== inputHash) throw new NodError("IDEMPOTENCY_CONFLICT", "同じrequestKeyに異なる記録は保存できません");
      return toRecord(prior);
    }
    if (!["active", "ended", "canceled"].includes(sprint.phase)) throw new NodError("INVALID_STATE", "記録は進行中・終了・中止のSprintに追記できます");
    if (correctsRecordId) {
      const original = ctx.db.query("SELECT * FROM sprint_records WHERE id=? AND sprint_id=? AND kind=?").get(correctsRecordId, sprint.id, input.kind);
      if (!original) return invalidSprint("訂正元は同じSprintの同じ種類の記録を指定してください");
    }
    const record: SprintRecord = { id: crypto.randomUUID(), sprintId: sprint.id, kind: input.kind, content, recordedBy: ctx.actor,
      recordedAt: clock.now?.toISOString() ?? now(), correctsRecordId } as SprintRecord;
    ctx.db.query(`INSERT INTO sprint_records(id,sprint_id,kind,content,recorded_by,recorded_at,corrects_record_id,request_key,input_hash)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(record.id, record.sprintId, record.kind, JSON.stringify(record.content), record.recordedBy, record.recordedAt, correctsRecordId, requestKey, inputHash);
    return record;
  });
}
