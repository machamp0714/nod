import type { Database } from "bun:sqlite";
import { HUMAN_ACTOR } from "../ctx";
import { NodError } from "../errors";
import { formatIssueId, type QuestionRow, toQuestion } from "../issue-query";
import { type Question, type Status, STATUSES } from "../types";
import { issueScope } from "./stats";

// 未回答の未決事項（確認依頼）の Issue 横断の一覧（#173）。読み取り専用。
// Inbox は LLM からの質問だけを出すので、人が付けたものも含めて見るにはこちらを使う。回答は answerQuestion で行う
export const OPEN_QUESTION_ASKERS = ["me", "llm"] as const;
export type OpenQuestionAsker = (typeof OPEN_QUESTION_ASKERS)[number];

export interface OpenQuestionsQuery {
  askedBy?: OpenQuestionAsker; // me は人が付けたもの、llm は LLM からのもの。省略時は両方
  workspace?: string[]; // Workspace のキー。どれかに合うもの
  project?: string; // Project の名前か ID
  status?: Status[]; // Issue のステータス。done と canceled は指定できない
  q?: string; // 文字列検索。Issue のタイトル・ID・いずれかの質問文に合えば、その Issue の未回答の質問をすべて返す
  limit?: number; // 返す Issue の数。省略時はすべて
}

export interface OpenQuestion extends Question {
  issueTitle: string;
  workspace: string;
  status: Status;
  priority: number;
  project: { id: number; name: string } | null;
  questionCount: { answered: number; total: number }; // その Issue の決定数と総数。絞り込みに左右されない
}

export interface OpenQuestions {
  total: number; // 条件に合う未回答の質問の数（limit で切る前）
  issueCount: number; // それらが付いている Issue の数（limit で切る前）
  more: number; // limit で入らなかった Issue の数
  questions: OpenQuestion[]; // Issue ごとにまとまった順
}

const CLOSED: Status[] = ["done", "canceled"];
const QUERY_KEYS = ["askedBy", "workspace", "project", "status", "q", "limit"];

function invalid(message: string): NodError {
  return new NodError("INVALID_ARGS", message);
}

// API のクエリパラメータを OpenQuestionsQuery にする。workspace と status は複数指定できる
export function openQuestionsQueryFromParams(params: URLSearchParams): OpenQuestionsQuery {
  const unknownKeys = [...new Set(params.keys())].filter((k) => !QUERY_KEYS.includes(k));
  if (unknownKeys.length) throw invalid(`${unknownKeys.join(", ")} は受け付けません（使えるもの: ${QUERY_KEYS.join(", ")}）`);
  const single = (key: string) => {
    const values = params.getAll(key);
    if (values.length > 1) throw invalid(`${key} は1つだけ指定してください`);
    return values[0];
  };
  const list = (key: string) => params.getAll(key).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  const q: OpenQuestionsQuery = {};
  const askedBy = single("askedBy");
  if (askedBy !== undefined) q.askedBy = parseOpenQuestionAsker(askedBy);
  const workspace = list("workspace");
  if (workspace.length) q.workspace = workspace;
  const project = single("project");
  if (project !== undefined) q.project = project;
  const status = list("status");
  if (status.length) {
    const unknown = status.filter((s) => !(STATUSES as readonly string[]).includes(s));
    if (unknown.length) throw invalid(`ステータス ${unknown.join(", ")} はありません（使えるもの: ${STATUSES.join(", ")}）`);
    q.status = status as Status[];
  }
  const text = single("q");
  if (text?.trim()) q.q = text.trim();
  const limit = single("limit");
  if (limit !== undefined) {
    if (!/^\d+$/.test(limit)) throw invalid(`limit は 1 以上の整数で指定してください（${limit}）`);
    q.limit = Number(limit);
  }
  return q;
}

export function parseOpenQuestionAsker(value: string): OpenQuestionAsker {
  if (!(OPEN_QUESTION_ASKERS as readonly string[]).includes(value)) {
    throw invalid(`質問者は ${OPEN_QUESTION_ASKERS.join(" か ")} で指定してください（${value}）`);
  }
  return value as OpenQuestionAsker;
}

interface Row extends QuestionRow {
  ws_key: string;
  issue_number: number;
  issue_title: string;
  status: Status;
  priority: number;
  project_id: number | null;
  project_name: string | null;
  question_total: number;
  question_answered: number;
}

// 並びは Issue の優先度（Urgent から Low、なしは最後）、その Issue の最古の未回答の質問の古い順、Issue の順。Issue の中は質問の id 順。
// 最古の質問は、一覧に出す質問（質問者で絞った後）の中で選ぶ
const orderBy = (asker: string) => `ORDER BY CASE i.priority WHEN 0 THEN 5 ELSE i.priority END,
  (SELECT min(o.asked_at) FROM questions o WHERE o.issue_id = i.id AND o.answer IS NULL${asker}), w.key, i.number, q.id`;

export function listOpenQuestions(db: Database, query: OpenQuestionsQuery = {}): OpenQuestions {
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1)) {
    throw invalid(`limit は 1 以上の整数で指定してください（${query.limit}）`);
  }
  const closed = (query.status ?? []).filter((s) => CLOSED.includes(s));
  if (closed.length) throw invalid(`${closed.join(", ")} の Issue の未決事項は一覧に出しません`);
  const scope = issueScope(db, query);
  const where = [`q.answer IS NULL AND i.archived_at IS NULL AND i.status NOT IN (${CLOSED.map(() => "?").join(", ")})${scope.where}`];
  const params: (string | number)[] = [...CLOSED, ...scope.params];
  const asker = query.askedBy === undefined ? "" : query.askedBy === "me" ? "asked_by = ?" : "asked_by <> ?";
  if (asker) {
    where.push(`q.${asker}`);
    params.push(HUMAN_ACTOR);
  }
  if (query.status?.length) {
    where.push(`i.status IN (${query.status.map(() => "?").join(", ")})`);
    params.push(...query.status);
  }
  const rows = db
    .query(
      `SELECT q.*, w.key AS ws_key, i.number AS issue_number, i.title AS issue_title, i.status, i.priority, i.project_id, pr.name AS project_name,
        (SELECT count(*) FROM questions t WHERE t.issue_id = i.id) AS question_total,
        (SELECT count(*) FROM questions t WHERE t.issue_id = i.id AND t.answer IS NOT NULL) AS question_answered
       FROM questions q JOIN issues i ON i.id = q.issue_id JOIN workspaces w ON w.id = i.workspace_id
       LEFT JOIN projects pr ON pr.id = i.project_id
       WHERE ${where.join(" AND ")} ${orderBy(asker ? ` AND o.${asker}` : "")}`,
    )
    .all(...params, ...(asker ? [HUMAN_ACTOR] : [])) as Row[];

  // SQLite の lower は非ASCIIで Web と異なるため、検索は Issue 一覧と同じく JavaScript で判定する
  const needle = query.q?.trim().toLowerCase() ?? "";
  const found = rows.map(
    (r): OpenQuestion => ({
      ...toQuestion(r, formatIssueId(r.ws_key, r.issue_number)),
      issueTitle: r.issue_title,
      workspace: r.ws_key,
      status: r.status,
      priority: r.priority,
      project: r.project_id !== null && r.project_name !== null ? { id: r.project_id, name: r.project_name } : null,
      questionCount: { answered: r.question_answered, total: r.question_total },
    }),
  );
  // 検索は Issue 単位。質問文に合ったときも、その Issue の未回答の質問はすべて返す（まとめて決めるため。Web と同じ）
  const matched = new Set(found.filter((q) => [q.question, q.issueTitle, q.issueId].some((text) => text.toLowerCase().includes(needle))).map((q) => q.issueId));
  const questions = needle ? found.filter((q) => matched.has(q.issueId)) : found;

  const issueIds = [...new Set(questions.map((q) => q.issueId))];
  const kept = new Set(query.limit === undefined ? issueIds : issueIds.slice(0, query.limit));
  return {
    total: questions.length,
    issueCount: issueIds.length,
    more: issueIds.length - kept.size,
    questions: questions.filter((q) => kept.has(q.issueId)),
  };
}
