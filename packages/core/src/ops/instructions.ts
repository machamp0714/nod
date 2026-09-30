import type { Database } from "bun:sqlite";
import { isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { addComment } from "../events";
import { findIssueRow, findWritableIssueRow, formatIssueId, type IssueRow } from "../issue-query";
import {
  AGENT_INSTRUCTION_KINDS,
  type AgentInstruction,
  type AgentInstructionKind,
  type AgentInstructionSendState,
  type AgentTargets,
  type OrcaFailure,
} from "../types";
import { agentTerminals, listOrcaTerminals, ORCA_TIMEOUT_MS, orcaFailure, type OrcaRunner, readOrcaEnvelope } from "./orca";

// LLM への追加指示（#51）と差し戻しの対応依頼（#58）。記録と送信は人だけが行い、送信は人の明示操作でだけ行う（自動送信はしない）。
// 端末には本文ではなく、nod で読むよう促す短い定型文を送る。本文の正本は nod のコメントである

export const INSTRUCTION_KIND_LABEL: Record<AgentInstructionKind, string> = {
  instruction: "追加指示",
  review_fix: "対応依頼（指摘対応）",
  rebase: "対応依頼（rebase）",
};

// 送信中のまま残った記録（送信中に server が止まったなど）は、この時間を過ぎたら結果不明として扱う。
// 送信中の操作が終わる前に結果不明にして送り直せないよう、orca の時間切れより十分長くする
export const SENDING_STALE_MS = 60_000;
const SEND_OUTPUT_MAX_BYTES = 1024 * 1024;
const SUMMARY_MAX = 100;

interface InstructionRow {
  id: number;
  issue_id: number;
  comment_id: number;
  kind: AgentInstructionKind;
  created_by: string;
  created_at: string;
  send_state: AgentInstructionSendState;
  send_attempted_at: string | null;
  sent_at: string | null;
  sent_by: string | null;
  sent_terminal: string | null;
  sent_agent: string | null;
  send_request_id: string | null;
  send_error_code: string | null;
  send_error_message: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  body: string;
  ws_key: string;
  number: number;
}

const SELECT = `SELECT a.*, c.body, w.key AS ws_key, i.number FROM agent_instructions a
  JOIN comments c ON c.id = a.comment_id JOIN issues i ON i.id = a.issue_id JOIN workspaces w ON w.id = i.workspace_id`;

function isStaleSending(row: InstructionRow, at = Date.now()): boolean {
  return row.send_state === "sending" && (!row.send_attempted_at || at - Date.parse(row.send_attempted_at) > SENDING_STALE_MS);
}

function toInstruction(row: InstructionRow): AgentInstruction {
  const stale = isStaleSending(row);
  const sendState: AgentInstructionSendState = stale ? "unconfirmed" : row.send_state;
  const sendError: OrcaFailure | null = row.send_error_code
    ? { code: row.send_error_code as OrcaFailure["code"], message: row.send_error_message ?? "" }
    : stale
      ? { code: "TIMEOUT", message: "送信の結果が分かりません。Orca の端末で届いたか確かめてください" }
      : null;
  return {
    id: row.id,
    issueId: formatIssueId(row.ws_key, row.number),
    commentId: row.comment_id,
    kind: row.kind,
    body: row.body,
    createdBy: row.created_by,
    createdAt: row.created_at,
    sendState,
    sentAt: row.sent_at,
    sentBy: row.sent_by,
    sentTerminal: row.sent_terminal,
    sentAgent: row.sent_agent,
    sendError,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
  };
}

function instructionRow(db: Database, id: number): InstructionRow | null {
  return db.query(`${SELECT} WHERE a.id = ?`).get(id) as InstructionRow | null;
}

export function listInstructions(db: Database, ref: string): AgentInstruction[] {
  const row = findIssueRow(db, ref);
  return instructionsOfIssue(db, row.id);
}

export function instructionsOfIssue(db: Database, issueRowId: number): AgentInstruction[] {
  return (db.query(`${SELECT} WHERE a.issue_id = ? ORDER BY a.id`).all(issueRowId) as InstructionRow[]).map(toInstruction);
}

export function pendingInstructionsOfIssue(db: Database, issueRowId: number): AgentInstruction[] {
  return (
    db.query(`${SELECT} WHERE a.issue_id = ? AND a.acknowledged_at IS NULL ORDER BY a.id`).all(issueRowId) as InstructionRow[]
  ).map(toInstruction);
}

// ops/issues の requireText と同じ。issues が getIssue でこのモジュールを使うため、循環を避けて持つ
function requireText(value: string | undefined, what: string): string {
  if (!value || !value.trim()) throw new NodError("INVALID_ARGS", `${what}を指定してください`);
  return value;
}

function requireHuman(ctx: OpCtx, what: string): void {
  if (isLlm(ctx)) throw new NodError("FORBIDDEN_FOR_LLM", `LLM は${what}できません。追加指示の記録と送信は me が行います`);
}

// 追加指示を記録する（送信はしない）。rejectReview の対応依頼からも、差し戻しと同じトランザクションの中で呼ぶ
export function addInstruction(ctx: OpCtx, row: IssueRow, body: string, kind: AgentInstructionKind): AgentInstruction {
  const comment = addComment(ctx, row, body);
  const { lastInsertRowid } = ctx.db
    .query("INSERT INTO agent_instructions (issue_id, comment_id, kind, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(row.id, comment.id, kind, ctx.actor, comment.createdAt);
  return toInstruction(instructionRow(ctx.db, Number(lastInsertRowid)) as InstructionRow);
}

export function recordInstruction(ctx: OpCtx, ref: string, body: string): AgentInstruction {
  requireHuman(ctx, "追加指示を記録");
  requireText(body, "追加指示の本文");
  return tx(ctx.db, () => addInstruction(ctx, findWritableIssueRow(ctx.db, ref), body, "instruction"));
}

export function isAgentInstructionKind(value: string): value is AgentInstructionKind {
  return (AGENT_INSTRUCTION_KINDS as readonly string[]).includes(value);
}

// 追加指示の送信先の候補（worktree で稼働中の LLM の端末）を orca で調べる。DB は変えない
export async function getAgentTargets(db: Database, ref: string, run: OrcaRunner | null): Promise<AgentTargets> {
  const row = findIssueRow(db, ref);
  const issueId = formatIssueId(row.ws_key, row.number);
  if (!row.worktree) return { issueId, worktree: null, terminals: [], failure: orcaFailure("NO_WORKTREE") };
  const listed = await listOrcaTerminals(run, row.worktree);
  if ("failure" in listed) return { issueId, worktree: row.worktree, terminals: [], failure: listed.failure };
  const terminals = agentTerminals(listed.terminals);
  return { issueId, worktree: row.worktree, terminals, failure: terminals.length === 0 ? orcaFailure("NO_TERMINAL") : null };
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  const chars = [...line];
  return chars.length <= SUMMARY_MAX ? line : `${chars.slice(0, SUMMARY_MAX - 1).join("")}…`;
}

// 端末の入力として解釈される文字（\r・ESC などの制御文字）。定型文から除き、改行や端末の操作として働かないようにする
// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を取り除くための正規表現
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g;

// 端末に送る定型文。全文は nod に残るので、エスケープや長文の問題を避けるため短くし、制御文字を除く
export function instructionMessage(instruction: AgentInstruction): string {
  const id = instruction.issueId;
  if (instruction.kind === "instruction") {
    return `nod: ${id} に追加指示があります（#${instruction.id}）。nod issue show ${id} で読んでください`.replace(CONTROL_CHARS, " ");
  }
  const reason = firstLine(instruction.body.replace(/^.*\n理由: /s, ""));
  return `nod: ${id} が差し戻されました。${INSTRUCTION_KIND_LABEL[instruction.kind]}: ${reason}。nod issue start ${id} で再開し、nod issue show ${id} で指示を読んでください`.replace(
    CONTROL_CHARS,
    " ",
  );
}

// 受付の結果から accepted と受付 ID を探す（orca の版によって置き場所が違うため、浅い階層だけを探す）
function findField(value: unknown, keys: string[], depth = 0): unknown {
  if (!value || typeof value !== "object" || depth > 3) return undefined;
  for (const key of keys) {
    if (key in value) return (value as Record<string, unknown>)[key];
  }
  for (const child of Object.values(value)) {
    const found = findField(child, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function requestIdOf(stdout: string): string | null {
  try {
    const id = findField(JSON.parse(stdout), ["requestId", "request_id", "retryRequestId"]);
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

export interface SendInstructionInput {
  terminal: string; // 確認画面で選んだ端末の handle
  confirmResend?: boolean; // 結果不明（受付 ID なし）のものを、人が届いていないと確かめて送り直すとき
}

// 記録済みの追加指示を、選ばれた端末に1回だけ送る（#51）。人だけが行える。
// 送信前に端末を一覧し直し、選ばれた端末がその worktree で稼働中の LLM の端末のときだけ送る。
// 送信済みは送り直さない。結果不明は受付 ID で orca の再試行（--retry-request）を使い、新しく送らない
export async function sendInstruction(
  ctx: OpCtx,
  ref: string,
  instructionId: number,
  input: SendInstructionInput,
  run: OrcaRunner | null,
): Promise<AgentInstruction> {
  requireHuman(ctx, "追加指示を送信");
  requireText(input.terminal, "送信先の端末");
  const issue = findWritableIssueRow(ctx.db, ref);
  const current = instructionRow(ctx.db, instructionId);
  if (!current || current.issue_id !== issue.id) {
    throw new NodError("NOT_FOUND", `${formatIssueId(issue.ws_key, issue.number)} に追加指示 #${instructionId} はありません`);
  }
  const shown = toInstruction(current);
  if (shown.sendState === "sent") throw new NodError("INSTRUCTION_ALREADY_SENT", `追加指示 #${instructionId} は送信済みです`);
  if (shown.sendState === "sending") throw new NodError("INSTRUCTION_SENDING", `追加指示 #${instructionId} は送信中です`);
  const retryId = shown.sendState === "unconfirmed" ? current.send_request_id : null;
  if (shown.sendState === "unconfirmed" && !retryId && !input.confirmResend) {
    throw new NodError(
      "SEND_UNCONFIRMED",
      `追加指示 #${instructionId} は届いたか分かりません。Orca の端末で届いていないことを確かめてから送り直してください`,
    );
  }
  if (retryId && current.sent_terminal !== input.terminal) {
    throw new NodError("INVALID_ARGS", `結果が分からない送信は、同じ端末（${current.sent_terminal}）にだけ再試行できます`);
  }

  // 同じ指示を同時に送らないよう、読んだときの状態のままなら送信中にする
  const attemptedAt = now();
  const claimed = ctx.db
    .query("UPDATE agent_instructions SET send_state = 'sending', send_attempted_at = ? WHERE id = ? AND send_state = ? AND (send_attempted_at IS ? OR send_attempted_at = ?)")
    .run(attemptedAt, instructionId, current.send_state, current.send_attempted_at, current.send_attempted_at);
  if (claimed.changes === 0) throw new NodError("INSTRUCTION_SENDING", `追加指示 #${instructionId} はほかの操作が送信しています`);

  // 自分が送信中にした記録のときだけ結果を書く。結果不明とみなされたあとに別の操作が送り直していたら、その記録を上書きしない
  const finish = (state: AgentInstructionSendState, fields: { failure?: OrcaFailure | null; requestId?: string | null; agent?: string | null }) => {
    const updated = ctx.db
      .query(
        `UPDATE agent_instructions SET send_state = ?, sent_terminal = ?, sent_agent = COALESCE(?, sent_agent), send_request_id = ?,
          send_error_code = ?, send_error_message = ?, sent_at = ?, sent_by = ? WHERE id = ? AND send_state = 'sending' AND send_attempted_at = ?`,
      )
      .run(
        state,
        input.terminal,
        fields.agent ?? null,
        fields.requestId ?? null,
        fields.failure?.code ?? null,
        fields.failure?.message ?? null,
        state === "sent" ? now() : null,
        state === "sent" ? ctx.actor : null,
        instructionId,
        attemptedAt,
      );
    if (updated.changes > 0) ctx.db.query("UPDATE issues SET updated_at = ? WHERE id = ?").run(now(), issue.id);
    return toInstruction(instructionRow(ctx.db, instructionId) as InstructionRow);
  };

  try {
    const targets = await getAgentTargets(ctx.db, ref, run);
    const target = targets.terminals.find((t) => t.handle === input.terminal);
    if (!target) {
      // 一覧できなかったとき、選んだ端末が無くなったとき・別の worktree の端末のときは送らない
      const failure = targets.failure && targets.failure.code !== "NO_TERMINAL" ? targets.failure : orcaFailure("TERMINAL_NOT_FOUND");
      return finish(retryId ? "unconfirmed" : "failed", { failure, requestId: retryId });
    }
    const args = ["terminal", "send", "--terminal", target.handle, "--text", instructionMessage(shown), "--enter", "--json"];
    if (retryId) args.push("--retry-request", retryId);
    const result = await (run as OrcaRunner)(args, { timeoutMs: ORCA_TIMEOUT_MS, maxStdoutBytes: SEND_OUTPUT_MAX_BYTES });
    const requestId = (result.kind === "exited" ? requestIdOf(result.stdout) : null) ?? retryId;
    const envelope = readOrcaEnvelope(result);
    if (!envelope.ok) {
      // 届いていないと分かるのは、orca が起動しなかったとき（not_found・spawn_failed）と端末が無いときだけ。
      // それ以外（時間切れ・出力過大・非0終了・未知のエラーコード）は、届いたか分からないとして記録する
      const notSent =
        result.kind === "not_found" || result.kind === "spawn_failed" || envelope.failure.code === "TERMINAL_NOT_FOUND";
      return finish(notSent ? "failed" : "unconfirmed", { failure: envelope.failure, requestId, agent: target.agentIdentity });
    }
    if (findField(envelope.result, ["accepted"]) === false) {
      return finish("failed", { failure: orcaFailure("ORCA_ERROR", "端末が入力を受け付けませんでした"), requestId: null, agent: target.agentIdentity });
    }
    return finish("sent", { requestId, agent: target.agentIdentity });
  } catch (e) {
    finish("unconfirmed", { failure: orcaFailure("ORCA_ERROR", e instanceof Error ? e.message : String(e)), requestId: retryId });
    throw e;
  }
}

// 渡した追加指示だけを確認済みにする（読んだあとに記録された指示は未確認のまま残す）
function acknowledge(ctx: OpCtx, issueRowId: number, instructions: AgentInstruction[]): void {
  const ts = now();
  const query = ctx.db.query(
    "UPDATE agent_instructions SET acknowledged_at = ?, acknowledged_by = ? WHERE id = ? AND issue_id = ? AND acknowledged_at IS NULL",
  );
  for (const i of instructions) query.run(ts, ctx.actor, i.id, issueRowId);
}

// LLM が nod issue start で受け取る、未確認の追加指示・対応依頼。LLM が受け取ったら確認済みにする（人の start では確認済みにしない）
export function takePendingInstructions(ctx: OpCtx, ref: string): AgentInstruction[] {
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    const pending = pendingInstructionsOfIssue(ctx.db, row.id);
    if (isLlm(ctx) && pending.length > 0) acknowledge(ctx, row.id, pending);
    return pending;
  });
}

// 担当の LLM が nod issue show で読んだ未確認の追加指示を確認済みにする（作業中に読んだ指示を次の start で渡し直さないため）。
// 人や担当でない LLM の show では変えない。確認済みにした数を返す
export function acknowledgeShownInstructions(ctx: OpCtx, ref: string, shown: AgentInstruction[]): number {
  if (!isLlm(ctx) || shown.length === 0) return 0;
  return tx(ctx.db, () => {
    const row = findIssueRow(ctx.db, ref);
    if (row.assignee !== ctx.actor) return 0;
    const before = pendingInstructionsOfIssue(ctx.db, row.id).length;
    acknowledge(ctx, row.id, shown);
    return before - pendingInstructionsOfIssue(ctx.db, row.id).length;
  });
}
