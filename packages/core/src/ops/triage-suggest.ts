import type { OpCtx } from "../ctx";
import { NodError } from "../errors";
import { findIssueRow, formatIssueId, type IssueRow } from "../issue-query";
import type {
  AssigneeSuggestion,
  DuplicateSuggestion,
  LabelSuggestion,
  Status,
  SuggestionReason,
  TriageSuggestions,
} from "../types";

// Triage の提案（#41）。LLM や外部サービスを使わず、同じ入力には同じ結果を返す。読み取りだけで DB を変えない
const BODY_LIMIT = 2000; // 本文は先頭だけを見る
const TITLE_WEIGHT = 0.7;
const DUPLICATE_THRESHOLD = 0.25;
const DUPLICATE_LIMIT = 5;
const SIMILAR_THRESHOLD = 0.15; // ラベル・担当の根拠にする類似 Issue
const SIMILAR_LIMIT = 10;
const LABEL_LIMIT = 3;
const ASSIGNEE_LIMIT = 2;
const SHARED_TERM_LIMIT = 5;
const STOPWORDS = new Set([
  "the", "and", "for", "to", "of", "in", "on", "is", "are", "be", "it", "with", "as", "at", "by", "or", "an", "this", "that", "from", "not",
]);
function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

// 語と文字を数値のキーにして Set<number> で比べる（文字列の Set より数倍速い）。
// 日本語などの文字は 0x3000〜0x9FFF（平仮名・片仮名・漢字）を 0〜CJK_SPAN-1 に詰める
const CJK_SPAN = 0x7000;
const UNIGRAM_BASE = CJK_SPAN * CJK_SPAN;
const WORD_BASE = 0x40000000;

function cjkIndex(code: number): number {
  const i = code - 0x3000;
  // 0x3000〜0x303F は句読点・括弧などの記号で、々（0x3005）と〆（0x3006）だけを文字として扱う
  if (i === 5 || i === 6 || (i >= 0x41 && i <= 0xff) || (i >= 0x400 && i < CJK_SPAN)) return i;
  return -1;
}

const isHiragana = (i: number) => i >= 0x41 && i <= 0x9f;

function isWordChar(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x7a) || code === 0x5f || (code >= 0xc0 && code <= 0x24f && code !== 0xd7 && code !== 0xf7);
}

// 正規化済みの文字列を走査し、トークンのキーと文字列上の位置を返す。
// 英数字は2文字以上の語、日本語などは文字 bigram（1文字だけの並びは1文字）にする。平仮名だけの組（「する」「ので」など）と英語の機能語は除く
function scan(s: string, emit: (key: number, start: number, end: number) => void): void {
  let i = 0;
  const n = s.length;
  while (i < n) {
    const code = s.charCodeAt(i);
    if (isWordChar(code)) {
      const start = i;
      let h = 0x811c9dc5;
      while (i < n && isWordChar(s.charCodeAt(i))) {
        h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
        i++;
      }
      if (i - start >= 2 && !(i - start <= 5 && STOPWORDS.has(s.slice(start, i)))) emit(WORD_BASE | (h & 0x3fffffff), start, i);
      continue;
    }
    const first = cjkIndex(code);
    if (first < 0) {
      i++;
      continue;
    }
    const start = i;
    let prev = first;
    i++;
    while (i < n) {
      const cur = cjkIndex(s.charCodeAt(i));
      if (cur < 0) break;
      if (!(isHiragana(prev) && isHiragana(cur))) emit(prev * CJK_SPAN + cur, i - 1, i + 1);
      prev = cur;
      i++;
    }
    if (i - start === 1 && !isHiragana(first)) emit(UNIGRAM_BASE + first, start, i);
  }
}

function keysOf(text: string, into = new Set<number>()): Set<number> {
  scan(normalize(text), (k) => into.add(k));
  return into;
}

// 確認・表示用。scan と同じ規則のトークンを文字列で返す
export function tokenize(text: string): Set<string> {
  const s = normalize(text);
  const out = new Set<string>();
  scan(s, (_k, start, end) => out.add(s.slice(start, end)));
  return out;
}

function jaccard(a: Set<number>, b: Set<number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let common = 0;
  for (const t of small) if (large.has(t)) common++;
  return common / (a.size + b.size - common);
}

interface Tokens {
  title: Set<number>;
  all: Set<number>;
}

function tokensOf(title: string, body: string | null): Tokens {
  const t = keysOf(title);
  const all = new Set(t);
  if (body) keysOf(body.slice(0, BODY_LIMIT), all);
  return { title: t, all };
}

function score(a: Tokens, b: Tokens): number {
  return TITLE_WEIGHT * jaccard(a.title, b.title) + (1 - TITLE_WEIGHT) * jaccard(a.all, b.all);
}

// タイトル 0.7、タイトル＋本文（先頭 2000 字）0.3 で加重した Jaccard 係数
export function similarity(a: { title: string; body: string | null }, b: { title: string; body: string | null }): number {
  return score(tokensOf(a.title, a.body), tokensOf(b.title, b.body));
}

// Web から続けて開いたときに数千件を毎回トークン化しないよう、DB・Workspace ごとにトークンを覚える。
// タイトル・本文が変わっていれば作り直し、今回見なかった Issue の分は捨てる
interface CacheEntry {
  title: string;
  body: string | null;
  tokens: Tokens;
}
const tokenCache = new WeakMap<object, Map<number, Map<number, CacheEntry>>>();

function cachedTokens(db: object, workspaceId: number, rows: { id: number; title: string; body: string | null }[]): Map<number, Tokens> {
  let perDb = tokenCache.get(db);
  if (!perDb) tokenCache.set(db, (perDb = new Map()));
  const old = perDb.get(workspaceId);
  const next = new Map<number, CacheEntry>();
  const out = new Map<number, Tokens>();
  for (const r of rows) {
    const hit = old?.get(r.id);
    const entry = hit && hit.title === r.title && hit.body === r.body ? hit : { title: r.title, body: r.body, tokens: tokensOf(r.title, r.body) };
    next.set(r.id, entry);
    out.set(r.id, entry.tokens);
  }
  perDb.set(workspaceId, next);
  return out;
}

interface CandidateRow {
  id: number;
  number: number;
  title: string;
  body: string | null;
  status: Status;
  assignee: string | null;
  created_at: string;
  labels: string | null;
  duplicate_of: number | null;
}

interface Scored {
  row: CandidateRow;
  ref: string;
  score: number;
  tokens: Tokens;
}

const byScore = <T extends { score: number; row: CandidateRow }>(a: T, b: T) =>
  b.score - a.score || a.row.created_at.localeCompare(b.row.created_at) || a.row.id - b.row.id;

// 根拠つきの提案を、重みの大きい順（同点は名前順）に上位 limit 件だけ返す
function rank(weights: Map<string, { weight: number; reasons: SuggestionReason[] }>, limit: number) {
  return [...weights.entries()]
    .sort(([a, x], [b, y]) => y.weight - x.weight || a.localeCompare(b))
    .slice(0, limit)
    .map(([key, v]) => ({ key, reasons: v.reasons }));
}

function add(weights: Map<string, { weight: number; reasons: SuggestionReason[] }>, key: string, weight: number, reason: SuggestionReason) {
  const cur = weights.get(key) ?? { weight: 0, reasons: [] };
  cur.weight += weight;
  cur.reasons.push(reason);
  weights.set(key, cur);
}

// 英数字だけのラベルは語の境界で、それ以外は部分文字列で探す
function containsLabel(text: string, label: string): boolean {
  const l = normalize(label);
  if (/^[\p{Script=Latin}\p{N}_\s-]+$/u.test(l)) {
    const escaped = l.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
    return new RegExp(`(^|[^\\p{Script=Latin}\\p{N}_])${escaped}($|[^\\p{Script=Latin}\\p{N}_])`, "u").test(text);
  }
  return text.includes(l);
}

export function suggestTriage(ctx: OpCtx, ref: string): TriageSuggestions {
  const target = findIssueRow(ctx.db, ref);
  const issueId = formatIssueId(target.ws_key, target.number);
  if (target.status !== "triage") {
    throw new NodError("NOT_IN_TRIAGE", `${ref} は ${target.status} です（triage の Issue だけに提案できます）`);
  }
  const mine = tokensOf(target.title, target.description);
  const rows = ctx.db
    .query(
      `SELECT i.id, i.number, i.title, substr(i.description, 1, ${BODY_LIMIT}) AS body, i.status, i.assignee, i.created_at,
         (SELECT group_concat(l.label, char(10)) FROM issue_labels l WHERE l.issue_id = i.id) AS labels,
         (SELECT min(r.to_id) FROM relations r WHERE r.from_id = i.id AND r.type = 'duplicate') AS duplicate_of
       FROM issues i WHERE i.workspace_id = ? AND i.id <> ?`,
    )
    .all(target.workspace_id, target.id) as CandidateRow[];
  const tokensById = cachedTokens(ctx.db, target.workspace_id, rows);
  const scored: Scored[] = [];
  for (const row of rows) {
    const tokens = tokensById.get(row.id)!;
    const s = score(mine, tokens);
    if (s > 0) scored.push({ row, ref: formatIssueId(target.ws_key, row.number), score: s, tokens });
  }
  scored.sort(byScore);

  return {
    issueId,
    duplicates: duplicates(ctx, target, scored, rows),
    labels: labels(ctx, target, scored),
    assignees: assignees(ctx, target, scored),
  };
}

function duplicates(ctx: OpCtx, target: IssueRow, scored: Scored[], rows: CandidateRow[]): DuplicateSuggestion[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const best = new Map<number, { score: number; row: CandidateRow; tokens: Tokens; via: string | null }>();
  for (const s of scored) {
    if (s.score < DUPLICATE_THRESHOLD) break;
    // 重複になっている Issue は候補にせず、元の Issue に寄せる
    const originalId = s.row.duplicate_of ?? s.row.id;
    if (originalId === target.id) continue;
    if (best.has(originalId)) continue; // 降順なので先に入ったものが最大
    const original = byId.get(originalId) ?? originalRow(ctx, originalId);
    best.set(originalId, { score: s.score, row: original, tokens: s.tokens, via: s.row.duplicate_of === null ? null : s.ref });
  }
  return [...best.values()]
    .sort(byScore)
    .slice(0, DUPLICATE_LIMIT)
    .map((b) => {
      const { key, number } = issueKey(ctx, b.row.id);
      return {
        id: formatIssueId(key, number),
        workspace: key,
        title: b.row.title,
        status: b.row.status,
        score: Math.round(b.score * 100) / 100,
        sharedTerms: sharedTerms(target, b.tokens),
        via: b.via,
      };
    });
}

function issueKey(ctx: OpCtx, id: number): { key: string; number: number } {
  return ctx.db.query("SELECT w.key, i.number FROM issues i JOIN workspaces w ON w.id = i.workspace_id WHERE i.id = ?").get(id) as {
    key: string;
    number: number;
  };
}

function originalRow(ctx: OpCtx, id: number): CandidateRow {
  return ctx.db
    .query("SELECT id, number, title, NULL AS body, status, assignee, created_at, NULL AS labels, NULL AS duplicate_of FROM issues WHERE id = ?")
    .get(id) as CandidateRow;
}

// 根拠として見せる共通語。英数字は語のまま、日本語などは一致した bigram が続く範囲を1つの句にまとめる。
// タイトル・本文の順に、Issue の文中に出る順で並べる
function sharedTerms(target: { title: string; description: string | null }, other: Tokens): string[] {
  const out: string[] = [];
  for (const text of [target.title, (target.description ?? "").slice(0, BODY_LIMIT)]) {
    const s = normalize(text);
    let span: [number, number] | null = null;
    const flush = () => {
      const term = span && s.slice(span[0], span[1]);
      if (term && out.length < SHARED_TERM_LIMIT && !out.includes(term)) out.push(term);
      span = null;
    };
    scan(s, (k, start, end) => {
      if (!other.all.has(k)) return;
      if (span && start < span[1]) span[1] = end; // bigram は1文字ずつ重なるので、続く一致を1つの句にする
      else {
        flush();
        span = [start, end];
      }
    });
    flush();
  }
  return out;
}

function similarIssues(scored: Scored[]): Scored[] {
  return scored.filter((s) => s.score >= SIMILAR_THRESHOLD).slice(0, SIMILAR_LIMIT);
}

const TEXT_WEIGHT = { title: 1, description: 0.5 } as const;

function labels(ctx: OpCtx, target: IssueRow, scored: Scored[]): LabelSuggestion[] {
  const current = new Set(target.labels?.split("\n") ?? []);
  const weights = new Map<string, { weight: number; reasons: SuggestionReason[] }>();
  const support = new Map<string, { weight: number; issues: string[] }>();
  for (const s of similarIssues(scored)) {
    for (const label of s.row.labels?.split("\n") ?? []) {
      if (current.has(label)) continue;
      const cur = support.get(label) ?? { weight: 0, issues: [] };
      cur.weight += s.score;
      cur.issues.push(s.ref);
      support.set(label, cur);
    }
  }
  for (const [label, s] of support) add(weights, label, s.weight, { kind: "similar", issues: s.issues });
  // 既存のラベル名がタイトル・本文に出ていれば候補にする（タイトルを優先し、根拠は1つだけ）
  const title = normalize(target.title);
  const body = normalize((target.description ?? "").slice(0, BODY_LIMIT));
  const known = ctx.db.query("SELECT DISTINCT label FROM issue_labels ORDER BY label").all() as { label: string }[];
  for (const { label } of known) {
    if (current.has(label)) continue;
    const field = containsLabel(title, label) ? "title" : containsLabel(body, label) ? "description" : null;
    if (field) add(weights, label, TEXT_WEIGHT[field], { kind: "text", field });
  }
  return rank(weights, LABEL_LIMIT).map(({ key, reasons }) => ({ label: key, reasons }));
}

const SOURCE_WEIGHT = 1;

function assignees(ctx: OpCtx, target: IssueRow, scored: Scored[]): AssigneeSuggestion[] {
  const weights = new Map<string, { weight: number; reasons: SuggestionReason[] }>();
  const support = new Map<string, { weight: number; issues: string[] }>();
  for (const s of similarIssues(scored)) {
    const a = s.row.assignee;
    if (!a || a === target.assignee) continue;
    const cur = support.get(a) ?? { weight: 0, issues: [] };
    cur.weight += s.score;
    cur.issues.push(s.ref);
    support.set(a, cur);
  }
  for (const [a, s] of support) add(weights, a, s.weight, { kind: "similar", issues: s.issues });
  const source = discoveredFrom(ctx, target.id);
  if (source) {
    const row = ctx.db
      .query("SELECT i.assignee FROM issues i JOIN workspaces w ON w.id = i.workspace_id WHERE w.key || '-' || i.number = ?")
      .get(source) as { assignee: string | null } | null;
    if (row?.assignee && row.assignee !== target.assignee) add(weights, row.assignee, SOURCE_WEIGHT, { kind: "source", issue: source });
  }
  return rank(weights, ASSIGNEE_LIMIT).map(({ key, reasons }) => ({ assignee: key, reasons }));
}

// created の event に記録した起票元（discovered_from）
function discoveredFrom(ctx: OpCtx, issueId: number): string | null {
  const row = ctx.db.query("SELECT data FROM events WHERE issue_id = ? AND type = 'created' ORDER BY id LIMIT 1").get(issueId) as {
    data: string;
  } | null;
  const value = row ? (JSON.parse(row.data) as { discovered_from?: unknown }).discovered_from : undefined;
  return typeof value === "string" ? value : null;
}
