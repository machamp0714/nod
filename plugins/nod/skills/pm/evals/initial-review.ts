import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ActivityItem } from "../../../../../packages/core/src";

export type ReviewRole = "standards" | "spec" | "refute" | "acceptance";
/** 反証担当が確定した結果。impactがある指摘は要対応、ない指摘は任意として扱う。 */
export type ReviewFinding = { id: string; category: string; evidence: string; commit: string; impact?: number; acceptance?: string; suggestion?: string };
export type ReviewAxis = { findings: ReviewFinding[]; evidence: string };
/** 確認が残る事項。最終状態と点数を変えず、マージ可否だけを止める。 */
export type RemainingCheck = { source: string; owner: string; reason: string };
export type AcceptanceJudgment = "確認済み" | "未充足" | "確かめられず";
/** 受け入れ確認担当が行ごとに分けて判定する部分。要求が求めない部分は「対象外（要求が求めていない）」になる。 */
export type AcceptancePart = "成果物の不変版の存在" | "作業・手順の実施" | "現在の配置" | "外部の正本との内容の一致" | "更新順序";
const acceptanceParts: AcceptancePart[] = ["成果物の不変版の存在", "作業・手順の実施", "現在の配置", "外部の正本との内容の一致", "更新順序"];
/**
 * 反証が対応表で「受け入れ確認担当」とした行と、受け入れ確認担当が有効な結果で返す判定。evidenceは証拠または不足理由。
 * parts を省いた行は作業記録の行として、成果物の不変版の存在と作業・手順の実施だけを判定する。verify と canonical は反証の「受け入れ確認担当の行」の節に書く確かめることと、名指しした外部の正本。
 */
export type AcceptanceRow = {
  source: string; judgment: AcceptanceJudgment; evidence: string;
  parts?: Partial<Record<AcceptancePart, AcceptanceJudgment>>; verify?: { artifact: string; work: string }; canonical?: string;
};
/** records.md の項目の種類。親は配置先かどうかを判断しないので、配置先・成果物の観測は「参照された記録」に入る。 */
export type EvidenceKind = "Activity" | "添付 Document" | "参照された記録" | "外部の正本";
/**
 * 受け入れ確認担当が結果の「判定に使った証拠」の節に挙げた、親の写しの項目（records.md の項目 ID・出典・固定時の指紋と、その証拠を使った行と使い方）。
 * origins は evidence/<n> について親が records.md に書いた参照元（Activity の項目 `activity:<id>`・Document `document:<ID>`）。
 */
export type UsedEvidence = { id: string; kind: EvidenceKind; source: string; sha256: string; rows: string[]; use: AcceptancePart; origins?: string[] };
/**
 * 保存直前に親が判定に使った証拠を取り直した結果。
 * changed は Activity 以外の項目（Document・evidence/<n>・参照元の Document）で、指紋が固定時と違ったもの（null は取り直せなかった・削除された・リンクが外れた）。
 * activity は8.1で写した Activity（fixed）と保存直前に取り直した Activity（current）、ownLogs は写しの後に親自身が Issue へ書いた記録（作業ログ・コメント）の id（own-logs.md）。
 * 判定に使った Activity の項目と参照元の Activity は、この2つで有無・本文の指紋・解決の状態を比べる。
 * 固定の後に足された Activity は、親自身の記録と Issue のイベントを除き、種類・書いた人・返信先・本文を問わず親以外の追記として扱う。親自身かどうかは actor ではなく ownLogs で決める。
 */
export type EvidenceRecheck = { changed?: Record<string, string | null>; activity?: { fixed: ActivityItem[]; current: ActivityItem[]; ownLogs: number[] } };
/** 親の手順3.2節の CI 判定。`成功` 以外はどれもマージ可否を不可にする。 */
export type CiVerdict = "成功" | "失敗" | "未確定" | "結果なし" | "取得できず" | "必須のチェックなし" | "必須のチェックを決められず";
export type CiSource = "branch-protection" | "rulesets" | "workspace-rules";
/** 必須のチェック1件の出典と結果。url と conclusion は使った check run（偽 GitHub）のもの。 */
export type CiCheck = { context: string; sources: CiSource[]; result: "成功" | "失敗" | "未確定" | "結果なし"; url?: string; conclusion?: string };
/** 親が scripts/ci-checks.ts で読む偽 GitHub の観測。base は基点の GitHub ブランチ名。 */
export type CiInput = { headSha: string; base: string; verdict: CiVerdict; required: CiCheck[] };
/** `parent/ci/<n>/result.json`（または照合しなかったときの not-run.md）に書いた照合の記録。 */
export type CiRecord = Omit<CiInput, "verdict"> & { verdict: CiVerdict | "照合せず（未実施）"; reason: string; observedAt: string; recordPath: string; sha256: string };
export type MergeReadiness = "可（人のレビューなしでマージ可）" | "不可（人の判断が要る）";
/** 報告の保存と作業ログの後に行う merge-ready の操作。 */
export type LabelOperation = "付けた" | "外した" | "付けていない";
/** 有効な結果を返さなかった試行。reason は親の検査や終了通知で分かった無効の理由、ompRetries は担当のセッション内でompが行った再試行（親の再委譲とは別）。 */
export type InvalidAttempt = { reason: string; ompRetries?: string[] };
/** 役割ごとの試行の記録。最初の無効な試行は後続へ渡さず、親専用の監査領域へ残す。 */
export type ReviewAttempt = {
  role: ReviewRole; attempt: 1 | 2; id: string; result: "有効" | "無効" | "利用枠の上限"; ompRetries: string[];
  reason?: string; redelegation?: string; saved?: { path: string; sha256: string };
};
export type InitialReviewInput = {
  dir: string; issueId: string; implementer: string; baseCommit: string; headCommit: string;
  /** 担当を1つも起動しなかった理由（委譲できない環境・差分なし・秘密候補・限定 clone を作れない）。指定すると未実施になる。 */
  notRun?: string;
  /** 起動した担当のうち有効な結果を返した担当。必要な担当がそろわなければ未完了になる。探索の片方が無ければ反証は、反証が無ければ受け入れ確認は起動しない。 */
  received?: ReviewRole[];
  /**
   * 利用枠の上限以外の、判定と関係しない理由で無効だった試行（役割ごとに試行の順）。親は同じ入力で1回だけ再委譲する。
   * received にある役割は1件（再委譲で有効）、received に無い起動済みの役割は2件（再委譲も無効）を持つ。
   */
  invalid?: Partial<Record<ReviewRole, InvalidAttempt[]>>;
  /** 利用枠の上限で失敗した役割。親は再委譲せずその時点で止め、まだ起動していない担当も起動しない。 */
  usageLimit?: { role: ReviewRole } & InvalidAttempt;
  standards: ReviewAxis; spec?: ReviewAxis;
  /** Spec軸の対応表のコードで判断した行の出典。複合要求を受け入れ確認担当の行と分けたときに、コードの部分を示す。 */
  requirementSource?: string;
  /** 反証担当が要求の出典・確かめる担当・理由を示して「未確認」とした対応表の行。有効な結果であり、完了のまま確認が残る事項になる。 */
  unconfirmed?: RemainingCheck[];
  /** 反証担当が対応表で「受け入れ確認担当」とした行。1行以上あれば受け入れ確認担当が必要な担当になり、反証の後に起動する。 */
  acceptanceRows?: AcceptanceRow[];
  /** 受け入れ確認担当が判定に使った証拠。受け入れ確認担当の有効な結果があるときだけ使う。 */
  usedEvidence?: UsedEvidence[];
  /** 保存直前の再照合で取り直した結果。変化は担当の判定本文・最終状態・点数を変えず、確認が残る事項としてマージ可否だけを止める。 */
  recheck?: EvidenceRecheck;
  /** 10節の8の直前に、同じ head SHA の CI を照合した結果。未実施では照合せず not-run.md だけを書く。 */
  ci: CiInput;
};
/** 実装を進行する親がnodへ書く経路。偽CLIは実nod CLI（--json）、setupはcore APIを渡す。log は書いた記録の id を返す。 */
export type ReviewRecorder = {
  createDocument(issueId: string, path: string, title: string, body: string): { id: number; path: string };
  log(issueId: string, body: string, kind: "progress" | "blocker" | "test"): { id: number };
  show(issueId: string): { labels: string[]; activity: ActivityItem[] };
  label(issueId: string, action: "add" | "remove", label: string): void;
};
export type InitialReview = {
  independent: true; issueId: string; implementer: string; baseCommit: string; headCommit: string;
  runId: string; workDirectory: string; status: "完了" | "未完了" | "未実施"; score: number | null;
  target: { baseSha: string; headSha: string };
  agents: Partial<Record<ReviewRole, { definition: string; id: string }>>;
  /** 起動した役割ごとの試行（最初の試行と、親による1回限りの再委譲）。 */
  attempts: ReviewAttempt[];
  reportDocument: { id: number; path: string };
  verdict: { path: string; sha256: string } | null;
  /** 受け入れ確認担当の結果 acceptance/result.md。起動して有効な結果を受け取ったときだけ。 */
  acceptance: { path: string; sha256: string } | null;
  /** 受け入れ確認担当が有効な結果で判定した行。点数には入れず、確認済み以外は確認が残る事項になる。 */
  acceptanceRows: AcceptanceRow[];
  /** 受け入れ確認担当が判定に使った証拠。13節の再照合で同じ方法で取り直す。 */
  usedEvidence: UsedEvidence[];
  ci: CiRecord;
  remainingChecks: RemainingCheck[];
  mergeReadiness: MergeReadiness;
  /** 報告の保存と作業ログの後に行った merge-ready の操作と、それを記録した --kind test の作業ログの id。 */
  mergeReady: LabelOperation;
  mergeReadyLog: number;
  standards: ReviewAxis; spec?: ReviewAxis;
};

const roles = [["standards", "Standards 探索", "code-reviewer-standards"], ["spec", "Spec 探索", "code-reviewer-spec"], ["refute", "反証", "code-reviewer-refute"], ["acceptance", "受け入れ確認", "code-reviewer-acceptance"]] as const;
const roleNames = Object.fromEntries(roles.map(([role, name]) => [role, name])) as Record<ReviewRole, string>;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** 偽workerの子nodを使い、実装者のnod操作として記録する。nod は --json を付けて返った JSON を返す。 */
export function nodCliRecorder(nod: (...args: string[]) => any): ReviewRecorder {
  return {
    createDocument: (issueId, path, title, body) => nod("doc", "create", path, "--title", title, "--kind", "doc", "--issue", issueId, "--body", body),
    log: (issueId, body, kind) => nod("issue", "log", issueId, body, "--kind", kind),
    show: issueId => nod("issue", "show", issueId),
    label: (issueId, action, label) => { nod("issue", "update", issueId, action === "add" ? "--add-label" : "--remove-label", label); },
  };
}

/** 偽 GitHub の CI の観測を作る。必須のチェックは Workspace の規約の `test` 1件（必須のチェックなし・決められずでは0件）。 */
export function simulatedCi(headSha: string, verdict: CiVerdict = "成功", base = "main"): CiInput {
  if (verdict === "必須のチェックなし" || verdict === "必須のチェックを決められず") return { headSha, base, verdict, required: [] };
  const result = verdict === "成功" || verdict === "失敗" || verdict === "未確定" ? verdict : "結果なし";
  const run = result === "結果なし" ? {} : { url: `https://github.com/evaluation/api/actions/runs/${headSha.slice(0, 8)}`, ...(result === "未確定" ? {} : { conclusion: result === "成功" ? "success" : "failure" }) };
  return { headSha, base, verdict, required: [{ context: "test", sources: ["workspace-rules"], result, ...run }] };
}

const ownLogsPath = (workDirectory: string) => join(workDirectory, "parent", "acceptance", "own-logs.md");
/** 写しの後・保存の後に親自身（や13節の前に実装を進める親・PM）が Issue へ書いた記録の id を own-logs.md に追記する。 */
export function recordOwnLog(workDirectory: string, id: number, what: string) {
  const path = ownLogsPath(workDirectory);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, "# 親自身の記録（Issue へ書いた記録の id）\n\n");
  appendFileSync(path, `- ${id}: ${what}\n`);
}
const readOwnLogs = (workDirectory: string) => existsSync(ownLogsPath(workDirectory)) ? [...readFileSync(ownLogsPath(workDirectory), "utf8").matchAll(/^- (\d+):/gm)].map(match => Number(match[1])) : [];

const ciReason = (ci: CiInput) => {
  const names = (result: CiCheck["result"]) => ci.required.filter(check => check.result === result).map(check => check.context).join("、");
  switch (ci.verdict) {
    case "成功": return `必須のチェック ${ci.required.length} 件がすべて head ${ci.headSha} で成功`;
    case "失敗": return `失敗した必須のチェックがある: ${ci.required.filter(check => check.result === "失敗").map(check => `${check.context}（${check.conclusion ?? "failure"}）`).join("、")}`;
    case "未確定": return `完了していない必須のチェックがある: ${names("未確定")}`;
    case "結果なし": return `head ${ci.headSha} に結果の無い必須のチェックがある（push 前・PR 前を含む）: ${names("結果なし")}`;
    case "取得できず": return "check run・commit status を取得できない";
    case "必須のチェックなし": return "ブランチ保護・ルールセット・Workspace の規約のどれにも必須のチェックが無い";
    case "必須のチェックを決められず": return "必須のチェックを決められない出典がある（ブランチ保護を読めない）";
  }
};
/** scripts/ci-checks.ts の result.json と同じ形で、偽 GitHub の観測を記録する。gh の生の応答は持たない（評価用の模擬）。 */
function writeCi(directory: string, ci: CiInput): CiRecord {
  mkdirSync(directory, { recursive: true });
  const observedAt = new Date().toISOString();
  const reason = ciReason(ci);
  const workspaceChecks = ci.required.filter(check => check.sources.includes("workspace-rules")).map(check => ({ context: check.context, appId: null }));
  const result = {
    ok: true, verdict: ci.verdict, repository: "evaluation/api", base: ci.base, head: ci.headSha, observedAt,
    sources: {
      branchProtection: ci.verdict === "必須のチェックを決められず" ? { status: "undetermined", message: "評価用の模擬: protected なのに required_status_checks が見えない", checks: [] } : { status: "none", message: "評価用の模擬: 保護なし", checks: [] },
      rulesets: { status: "none", message: "評価用の模擬: 規則なし", checks: [] },
      workspaceRules: { status: workspaceChecks.length ? "read" : "none", checks: workspaceChecks },
    },
    required: ci.required.map(check => ({ context: check.context, appId: null, sources: check.sources, result: check.result,
      runs: check.result === "結果なし" ? [] : [{ kind: "check-run", id: 1, name: check.context, status: check.result === "未確定" ? "in_progress" : "completed", conclusion: check.conclusion ?? null, appId: 15368, url: check.url ?? null, completedAt: check.result === "未確定" ? null : observedAt }] })),
    reason, files: {},
  };
  const body = `${JSON.stringify(result)}\n`;
  const recordPath = join(directory, "result.json");
  writeFileSync(recordPath, body);
  return { ...ci, reason, observedAt, recordPath, sha256: sha256(body) };
}
const ciSummary = (ci: CiRecord) => `CI 判定 ${ci.verdict}（必須のチェック: ${ci.required.map(check => `${check.context}=${check.result}（出典 ${check.sources.join("・")}${check.conclusion ? `、${check.conclusion}` : ""}${check.url ? `、${check.url}` : ""}）`).join("、") || "なし"}。${ci.reason}）`;
const ciPassed = (ci: CiRecord, head: string) => ci.verdict === "成功" && ci.headSha === head;

type Comment = Extract<ActivityItem, { kind: "comment" }>;
type Question = Extract<ActivityItem, { kind: "question" }>;
type Appended = { id: string; at: string; order: number; actor: string; what: string; kept?: "親自身の記録" | "Issue のイベント" };
/**
 * 10節の3の受け入れ証拠の再照合。受け入れ確認担当が判定に使った証拠と、判定に使った evidence/<n> の参照元を取り直して固定時と比べる。
 * 固定の後に足された Activity のうち、親自身の記録（own-logs の id）と Issue のイベント以外は、種類・書いた人・返信先・本文を問わず親以外の追記として、
 * 判定に使った証拠を使ったすべての行に確認が残る事項を付ける。親と実装者は同じ actor で書くことがあるので、actor では分けない。
 * prefix は確認が残る事項の理由の頭（保存直前の再照合・13節の再照合）。
 */
function evidenceChecks(used: UsedEvidence[], changed: Record<string, string | null>, activity: EvidenceRecheck["activity"], prefix: string) {
  const recheckOwner = "受け入れ確認担当（新しい実行）";
  const check = (rows: string[], reason: string): RemainingCheck[] => rows.map(row => ({ source: row, owner: recheckOwner, reason: `${prefix}: ${reason}。この実行では判定し直さない` }));
  const usedRows = [...new Set(used.flatMap(item => item.rows))];
  const comments = (items: ActivityItem[]) => new Map(items.filter((item): item is Comment => item.kind === "comment").map(item => [item.id, item]));
  const fixed = comments(activity?.fixed ?? []);
  const current = comments(activity?.current ?? []);
  const own = new Set(activity?.ownLogs ?? []);
  // 親が見張る Activity: 判定に使った Activity の項目と、判定に使った evidence/<n> の参照元の Activity の項目。
  const watched = activity ? used.flatMap(item => [item.id, ...(item.origins ?? [])].filter(id => id.startsWith("activity:")).map(id => {
    const number = Number(id.slice("activity:".length));
    if (!fixed.has(number)) throw new Error(`${id} が固定時の Activity の写しに無い`);
    return { id, number, item, label: id === item.id ? `判定に使った証拠 ${id}` : `判定に使った証拠 ${item.id} の参照元 ${id}` };
  })) : [];
  const appended: Appended[] = [];
  // 判定に使った Activity・参照元の変化で、確認が残る事項を付けた判定に使った証拠。
  const affected = new Set<string>();
  if (activity) {
    const key = (item: ActivityItem) => JSON.stringify(item.kind === "question" ? [item.at, item.actor, item.question] : item.kind === "event" ? [item.at, item.actor, item.type, item.data] : [item.id]);
    const fixedQuestions = new Map(activity.fixed.filter((item): item is Question => item.kind === "question").map(item => [key(item), item]));
    const fixedKeys = new Set(activity.fixed.map(key));
    for (const item of activity.current) {
      if (item.kind === "event") {
        if (!fixedKeys.has(key(item))) appended.push({ id: `activity@${item.at}`, at: item.at, order: 0, actor: item.actor, what: `イベント ${item.type}`, kept: "Issue のイベント" });
      } else if (item.kind === "question") {
        const before = fixedQuestions.get(key(item));
        if (!before) appended.push({ id: `activity@${item.at}`, at: item.at, order: 0, actor: item.actor, what: "確認依頼" });
        else if (before.answer !== item.answer) appended.push({ id: `activity@${item.at}`, at: item.answeredAt ?? item.at, order: 0, actor: item.answeredBy ?? item.actor, what: "確認依頼の回答" });
      } else {
        const before = new Set(fixed.get(item.id)?.replies.map(reply => reply.id) ?? []);
        const entries = [
          ...fixed.has(item.id) ? [] : [{ id: item.id, at: item.at, actor: item.actor, what: item.logKind ? `作業ログ（${item.logKind}）` : "コメント" }],
          ...item.replies.filter(reply => !before.has(reply.id)).map(reply => ({ id: reply.id, at: reply.at, actor: reply.actor, what: `activity:${item.id} への返信` })),
        ];
        for (const entry of entries) appended.push({ id: `activity:${entry.id}`, at: entry.at, order: entry.id, actor: entry.actor, what: entry.what, ...own.has(entry.id) ? { kept: "親自身の記録" as const } : {} });
      }
    }
    appended.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
  }
  const others = appended.filter(entry => !entry.kept);
  const checks: RemainingCheck[] = [
    // Activity 以外の判定に使った項目は、取り直した指紋の違いで扱う。
    ...used.filter(item => !item.id.startsWith("activity:") && item.id in changed).flatMap(item => {
      const now = changed[item.id];
      const change = item.kind === "Activity" || item.kind === "添付 Document"
        ? now === null ? "証拠の削除" : "証拠の訂正（本文の指紋の変化）"
        : now === null ? "取り直せず（失効を含む）" : item.kind === "外部の正本" ? "外部の正本の変化" : "参照された記録（配置先・成果物を含む）の変化";
      return check(item.rows, `${change}（${item.id}: ${item.source}。固定時 ${item.sha256.slice(0, 12)}、取り直し ${now?.slice(0, 12) ?? "取り直せず"}）`);
    }),
    // 参照元の Document の削除・リンク外れ・訂正。
    ...used.flatMap(item => (item.origins ?? []).filter(id => !id.startsWith("activity:") && id in changed).flatMap(id => check(item.rows,
      `${changed[id] === null ? "証拠の削除（無い・リンクが外れた）" : "証拠の訂正（本文の指紋の変化）"}（判定に使った証拠 ${item.id} の参照元 ${id}。取り直し ${changed[id]?.slice(0, 12) ?? "取り直せず"}）`))),
    // 判定に使った Activity の項目と参照元の Activity の削除・訂正・解決の状態の変化。
    ...watched.flatMap(w => {
      const before = fixed.get(w.number)!;
      const after = current.get(w.number);
      const found = !after ? check(w.item.rows, `証拠の削除（${w.label} が無い）`) : [
        ...sha256(after.body) !== sha256(before.body) ? check(w.item.rows, `証拠の訂正（${w.label} の本文の指紋 ${sha256(before.body).slice(0, 12)} → ${sha256(after.body).slice(0, 12)}）`) : [],
        ...after.resolvedAt !== before.resolvedAt ? check(w.item.rows, `対応不明（撤回・訂正の可能性。${w.label} の解決の状態の変化。親は意味を判断しない）`) : [],
      ];
      if (found.length) affected.add(w.item.id);
      return found;
    }),
    // 親以外の追記は、どの証拠に関するかを親が決めないので、判定に使った証拠を使ったすべての行に付ける。
    ...others.flatMap(entry => check(usedRows, `親以外の追記（使用した証拠の有効性を確認できない。親は意味を判断しない。${entry.id}（${entry.what}、${entry.actor}、${entry.at}））`)),
  ];
  const origins = used.flatMap(item => (item.origins ?? []).map(id => `${id}（${item.id} の参照元）`));
  for (const item of used) if (item.id in changed || (item.origins ?? []).some(id => id in changed)) affected.add(item.id);
  return { checks, appended, others, affected, origins };
}

/**
 * nod:implementの親が残す初回独立レビューの成果（作業ディレクトリ、報告Document、作業ログ）を再現する。
 * 最終状態・点数・確認が残る事項・マージ可否は親の規則どおりに書くだけで、PMの受理判断は行わない。モデルやgitの実行はしない。
 */
export function recordInitialReview(input: InitialReviewInput, recorder: ReviewRecorder): InitialReview {
  const rows = input.acceptanceRows ?? [];
  // 受け入れ確認担当は、反証が対応表に「受け入れ確認担当」の行を作ったときだけ必要な担当になる。
  const required = roles.filter(([role]) => role !== "acceptance" || rows.length > 0).map(([role]) => role);
  const valid = new Set<ReviewRole>(input.notRun === undefined ? input.received ?? required : []);
  const explored = valid.has("standards") && valid.has("spec");
  if (valid.has("refute") && !explored) throw new Error("反証は両探索の有効な結果を受け取った後にだけ起動する");
  if (valid.has("acceptance") && (!valid.has("refute") || rows.length === 0)) throw new Error("受け入れ確認は、反証の有効な結果に受け入れ確認担当の行があるときだけ起動する");
  const launched = (role: ReviewRole) => input.notRun === undefined
    && (role === "refute" ? explored : role === "acceptance" ? valid.has("refute") && rows.length > 0 : true);
  const limited = input.usageLimit;
  if (limited && (valid.has(limited.role) || !launched(limited.role))) throw new Error("利用枠の上限で失敗した役割は、起動したが有効な結果の無い役割だけ");
  const status = input.notRun !== undefined ? "未実施" : required.every(role => valid.has(role)) ? "完了" : "未完了";
  const hex = sha256(`${input.issueId}:${input.headCommit}`);
  const runId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const shortRun = runId.slice(0, 8);
  const workDirectory = join(input.dir, "code-reviews", runId);
  const agents: Partial<Record<ReviewRole, { definition: string; id: string }>> = {};
  const attempts: ReviewAttempt[] = [];
  // 無効な試行の出力や終了通知は、担当が読まない親専用の監査領域 parent/attempts/<役割>-<試行> へ移して残す。
  const save = (role: ReviewRole, attempt: 1 | 2, id: string, text: string) => {
    const directory = join(workDirectory, "parent", "attempts", `${role}-${attempt}`);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, role === "refute" ? "verdict.md" : role === "acceptance" ? "result.md" : "handoff.md");
    const body = `# 無効な試行（評価用の模擬）\n\n- 担当 ID: ${id}\n- 試行: ${attempt}\n\n${text}\n`;
    writeFileSync(path, body);
    return { path, sha256: sha256(body) };
  };
  for (const [role, , definition] of roles) {
    if (!launched(role)) continue;
    const id = (attempt: 1 | 2) => `review-${role}-${shortRun}${attempt === 2 ? "-2" : ""}`;
    if (limited?.role === role) {
      attempts.push({ role, attempt: 1, id: id(1), result: "利用枠の上限", reason: limited.reason, ompRetries: limited.ompRetries ?? [], redelegation: "しない（利用枠の上限）", saved: save(role, 1, id(1), `終了通知: ${limited.reason}`) });
      continue;
    }
    const failures = input.invalid?.[role] ?? [];
    // 利用枠の上限以外の無効は、同じ入力・新しいコンテキストで1回だけ再委譲する。利用枠の上限で止めた後は再委譲しない。
    const allowed = valid.has(role) ? [0, 1] : limited ? [1, 2] : [2];
    if (!allowed.includes(failures.length)) throw new Error(`${role}: 無効な試行は ${allowed.join(" か ")} 件（再委譲は1回まで、利用枠の上限の後はしない）`);
    const redelegated = valid.has(role) || failures.length === 2;
    failures.forEach((failure, index) => {
      const attempt = index === 0 ? 1 : 2;
      const redelegation = attempt === 2 ? "しない（再委譲は1回まで）" : redelegated ? "した（同じ入力・同じ依頼本文で新しいコンテキストへ1回）" : "しない（利用枠の上限で止めた）";
      attempts.push({ role, attempt, id: id(attempt), result: "無効", reason: failure.reason, ompRetries: failure.ompRetries ?? [], redelegation, saved: save(role, attempt, id(attempt), `無効の理由: ${failure.reason}`) });
    });
    if (valid.has(role)) {
      const attempt = failures.length ? 2 : 1;
      attempts.push({ role, attempt, id: id(attempt), result: "有効", ompRetries: [] });
      agents[role] = { definition, id: id(attempt) };
    }
  }
  const invalid = roles.filter(([role]) => launched(role) && !valid.has(role) && limited?.role !== role).map(([, name]) => name);
  const stopped = explored ? "" : "。反証へ進めず、反証を起動しなかった";
  const reason = status === "未実施"
    ? `${input.notRun}。担当を1つも起動しなかった`
    : limited
      ? `利用枠の上限、有効な結果なし（${roleNames[limited.role]}。再委譲せずその時点で止めた${invalid.length ? `。${invalid.join("・")}も有効な結果なし` : ""}）${stopped}`
      : `有効な結果なし（${invalid.join("・")}。1回の再委譲の後も）${stopped}`;
  const findings = [
    ...input.standards.findings.map(finding => ({ ...finding, axis: "Standards", finder: "Standards 探索" })),
    ...(input.spec?.findings ?? []).map(finding => ({ ...finding, axis: "Spec", finder: "Spec 探索" })),
  ];
  const mustFix = findings.filter(finding => finding.impact !== undefined).sort((a, b) => (a.impact ?? 5) - (b.impact ?? 5));
  // 未確認が残っても、完了なら確定した要対応から点数を出す。受け入れ確認の結果は点数に入れない。
  const score = status === "完了" ? mustFix[0]?.impact ?? 5 : null;
  const unconfirmed = input.unconfirmed ?? [];
  const judged = agents.acceptance ? rows : [];
  // 保存直前の再照合（10節の3）。受け入れ確認担当の有効な結果があるときだけ、判定に使った証拠と参照元を取り直して比べる。
  const used = agents.acceptance ? input.usedEvidence ?? [] : [];
  const changed = input.recheck?.changed ?? {};
  const activity = agents.acceptance ? input.recheck?.activity : undefined;
  const { checks: recheckChecks, appended, others, affected, origins } = evidenceChecks(used, changed, activity, "保存直前の再照合");
  // 受け入れ確認の「未充足」「確かめられず」は、反証の未確認と同じく確認が残る事項としてマージ可否だけを止める。
  const remainingChecks = status === "完了" ? [
    ...unconfirmed,
    ...judged.filter(row => row.judgment !== "確認済み").map(row => ({ source: row.source, owner: "受け入れ確認担当", reason: `${row.judgment}: ${row.evidence}` })),
    ...recheckChecks,
  ] : [];
  const specMustFix = mustFix.filter(finding => finding.axis === "Spec");
  const table = [
    { source: input.requirementSource ?? "requirements/issue.md", state: specMustFix.length ? "未充足" : "充足", evidence: input.spec?.evidence ?? "Spec 探索の結果なし", candidates: specMustFix.map(finding => finding.id).join(", ") || "-" },
    ...rows.map(row => ({ source: row.source, state: "受け入れ確認担当", evidence: "作業記録・成果物・配置の証拠または外部の正本で確かめる（受け入れ確認担当の行の節）", candidates: "-" })),
    ...unconfirmed.map(check => ({ source: check.source, state: "未確認", evidence: `${check.reason}（確かめる担当: ${check.owner}）`, candidates: "-" })),
  ];
  // 10節の8の直前に CI を1回だけ照合して parent/ci/1/ に記録する。未実施では照合せず not-run.md に理由だけを書く。
  const ciDirectory = join(workDirectory, "parent", "ci", "1");
  let ci: CiRecord;
  if (status === "未実施") {
    mkdirSync(ciDirectory, { recursive: true });
    const body = "# CI の照合をしなかった\n\n- CI 判定: 照合せず（未実施）\n- 理由: 独立レビュー未実施（担当を1つも起動しなかった）\n";
    const recordPath = join(ciDirectory, "not-run.md");
    writeFileSync(recordPath, body);
    ci = { ...input.ci, verdict: "照合せず（未実施）", reason: "独立レビュー未実施のため照合しなかった", observedAt: new Date().toISOString(), recordPath, sha256: sha256(body) };
  } else ci = writeCi(ciDirectory, input.ci);
  const tableSatisfied = table.every(row => ["充足", "説明", "対象外"].includes(row.state) || (row.state === "受け入れ確認担当" && judged.some(judgedRow => judgedRow.source === row.source && judgedRow.judgment === "確認済み")));
  // 受け入れ確認担当の行は、受け入れ確認担当が確認済みとしたときだけマージ可否の判定で満たしたことにする。CI 判定は result.json の head が対象版の head と同じで成功のときだけ満たす。
  const mergeReadiness: MergeReadiness = status === "完了" && score === 5 && remainingChecks.length === 0 && tableSatisfied && ciPassed(ci, input.headCommit)
    ? "可（人のレビューなしでマージ可）" : "不可（人の判断が要る）";
  const blockers = [
    ...status === "完了" ? [] : [`最終状態 ${status}`],
    ...score === 5 || score === null ? [] : [`確定した要対応の点数 ${score}`],
    ...status === "完了" && !tableSatisfied ? ["対応表に満たしていない行がある"] : [],
    ...remainingChecks.length ? [`確認が残る事項 ${remainingChecks.length} 件`] : [],
    ...ciPassed(ci, input.headCommit) ? [] : [`CI 判定 ${ci.verdict}（${ci.reason}。result.json の head ${ci.headSha === input.headCommit ? "は" : "が"}対象版の head と${ci.headSha === input.headCommit ? "一致" : "不一致"}）`],
  ];
  // ラベルは報告の保存と作業ログの後に操作するが、報告には行う操作を書く。
  const labeled = recorder.show(input.issueId).labels.includes("merge-ready");
  const mergeReady: LabelOperation = mergeReadiness.startsWith("可") ? "付けた" : labeled ? "外した" : "付けていない";
  const remainingSummary = remainingChecks.map(check => `${check.source}（${check.owner}、${check.reason}）`).join("、");
  const target = `mode: commit／merge-base の SHA ${input.baseCommit}／head の SHA ${input.headCommit}`;

  mkdirSync(join(workDirectory, "refute"), { recursive: true });
  // 受け入れ確認への写しで固定した Activity。13節の再照合で同じ方法で比べる。
  if (activity) {
    mkdirSync(join(workDirectory, "acceptance-input", "records"), { recursive: true });
    writeFileSync(join(workDirectory, "acceptance-input", "records", "activity.json"), JSON.stringify(activity.fixed));
  }
  for (const id of activity?.ownLogs ?? []) recordOwnLog(workDirectory, id, "写しの後・保存の前に親が書いた記録");

  const verdictPath = join(workDirectory, "refute", "verdict.md");
  const verdict = agents.refute ? [
    "# 反証の判定", "",
    "## 担当と対象", "",
    "- 役割: 反証", "- 定義名: code-reviewer-refute", `- 担当 ID: ${agents.refute.id}`, "- モデル申告: 未確認",
    `- 対象版: ${target}`, "- 受け取った入力: refute-input/ の各ファイル（manifest.md の sha256 と一致）", `- 終了状態: ${unconfirmed.length ? "未確認を含む" : "完了"}`, "",
    "## 軸ごとの結果", "",
    ...["Standards", "Spec"].map(axis => `- ${axis}: 要対応 ${mustFix.filter(finding => finding.axis === axis).length} 件、未確認 ${axis === "Spec" ? unconfirmed.length : 0} 件`), "",
    "## 要対応（影響度の重い順）", "",
    ...(mustFix.length ? mustFix.flatMap(finding => [
      `### ${finding.id}: ${finding.category}`, "",
      `- 候補 ID と発見者の区分: ${finding.id}（${finding.finder}）`, `- 影響度: ${finding.impact}`, `- 軸: ${finding.axis}`, "- 起点: 今回の差分",
      `- 場所と証拠: ${finding.evidence}（${finding.commit}）`, `- 期待動作: ${finding.acceptance ?? "要求どおりに動く"}`, "- 反証の判定理由: 固定版の差分と要求の原文で再現できる", "",
    ]) : ["なし", ""]),
    "## 基点から存在する課題（別枠）", "", "なし", "",
    "## 要求ごとの対応表（確定）", "",
    "| 要求の出典 | 状態 | 証拠または不足理由 | 候補ID |", "|---|---|---|---|",
    ...table.map(row => `| ${row.source} | ${row.state} | ${row.evidence} | ${row.candidates} |`), "",
    "## 受け入れ確認担当の行", "",
    ...(rows.length ? [
      "| 要求の出典 | 確かめること（成果物） | 確かめること（作業・手順・配置） | 必要な外部の正本（出典の場所・版・版履歴の出典。要らなければ「なし」） |", "|---|---|---|---|",
      ...rows.map(row => `| ${row.source} | ${row.verify?.artifact ?? "作業ログに残した出力の記録"} | ${row.verify?.work ?? "対象版で要求されたコマンドを実行したこと"} | ${row.canonical ?? "なし"} |`),
    ] : ["なし"]), "",
    "## 未確認と理由", "",
    ...(unconfirmed.length ? unconfirmed.map(check => `- ${check.source}: 理由 ${check.reason}。確かめる担当: ${check.owner}`) : ["なし"]), "",
    "## 判断を見送った事項", "", "なし", "",
    "## 採否一覧（監査用）", "",
    "| 候補 ID | 発見者の区分 | 判定 | 影響度 | 同一原因 | 根拠 |", "|---|---|---|---|---|---|",
    ...findings.map(finding => `| ${finding.id} | ${finding.finder} | ${finding.impact === undefined ? "任意" : "要対応"} | ${finding.impact ?? "-"} | - | ${finding.evidence} |`), "",
  ].join("\n") : null;
  if (verdict !== null) writeFileSync(verdictPath, verdict);

  // 受け入れ確認担当の結果。親が写したActivity・添付Document・参照された記録・外部の正本・配置先の観測だけを証拠にし、
  // 成果物の不変版の存在・作業の実施・現在の配置・外部の正本との内容の一致・更新順序を分けて判定し、判定に使った証拠を挙げる。
  const acceptancePath = join(workDirectory, "acceptance", "result.md");
  const acceptanceResult = agents.acceptance ? [
    "# 受け入れ確認の結果", "",
    "## 担当と対象", "",
    "- 役割: 受け入れ確認", "- 定義名: code-reviewer-acceptance", `- 担当 ID: ${agents.acceptance.id}`, "- モデル申告: 未確認",
    `- 対象版: ${target}`, "- 受け取った入力: acceptance-input/ の各ファイル（manifest.md・records.md の sha256 と一致）",
    "- Activity・添付 Document の写し: records.md の取得時刻と指紋（評価用の模擬）", `- 終了状態: ${rows.some(row => row.judgment === "確かめられず") ? "確かめられずを含む" : "完了"}`, "",
    "## 行ごとの判定", "",
    ...rows.flatMap((row, index) => [
      `### 行 ${index + 1}: ${row.source}`, "",
      `- 要求の出典: ${row.source}`, `- 対象版: head の SHA ${input.headCommit}`, `- 判定: ${row.judgment}`,
      ...acceptanceParts.map(part => `- ${part}: ${(row.parts ?? { 成果物の不変版の存在: row.judgment === "確かめられず" ? "確認済み" : row.judgment, "作業・手順の実施": row.judgment })[part] ?? "対象外（要求が求めていない）"}`),
      `- 証拠: ${row.evidence}`, `- 不足理由: ${row.judgment === "確認済み" ? "なし" : row.evidence}`,
      "- 証拠にしなかった主張: Activity の「テスト成功」の自己申告", "",
    ]),
    "## 判定に使った証拠", "",
    ...(used.length ? [
      "| 項目 | 出典（`records.md` と同じ） | 使った行 | 使い方（5つの部分のどれか） |", "|---|---|---|---|",
      ...used.map(item => `| ${item.id} | ${item.source} | ${item.rows.join("、")} | ${item.use} |`),
    ] : ["なし"]), "",
    "## 反証の判定と矛盾する証拠", "", "なし", "",
    "## 判断を見送った事項", "", "なし", "",
  ].join("\n") : null;
  if (acceptanceResult !== null) {
    mkdirSync(join(workDirectory, "acceptance"), { recursive: true });
    writeFileSync(acceptancePath, acceptanceResult);
  }
  const acceptanceBody = acceptanceResult ?? (rows.length || !agents.refute ? `未受領（${reason}）\n` : "受け入れ確認担当の行なし（起動せず）\n");

  const report = [
    "## 管理情報（親が記入）", "",
    `- runId: ${runId}`, `- 作業ディレクトリ: ${workDirectory}`,
    `- 最終状態: ${status === "完了" ? "完了" : `${status}（理由: ${reason}）`}`,
    `- 確定した要対応の点数: ${score ?? "点数なし"}`,
    `- 点数の計算: ${status === "完了" ? `要対応 ${mustFix.length} 件（${mustFix.map(finding => `${finding.id}: ${finding.impact}`).join("、") || "なし"}）。最も重い影響度で ${score}。` : `${status}のため点数なし。`}点数は確定した要対応の影響度だけを表し、要求の確認率やマージ許可を表さない。`,
    `- 確認が残る事項: ${remainingChecks.length} 件（下の「確認が残る事項」の節）`,
    `- マージ可否: ${mergeReadiness}`,
    ...(mergeReadiness.startsWith("不可") ? [`  - 不可の理由: ${blockers.join("／")}`] : []),
    `- merge-ready: ${mergeReady}${mergeReady === "付けた" ? "" : `（${mergeReady === "外した" ? "付いていたが、" : ""}マージ可否が不可）`}。報告の保存と作業ログの直後に行う操作。ラベルは現在の判定の表示で、自動マージの指示ではない。操作の結果は判定した head SHA・基点・CI 判定・この報告の Document ID・runId とともに --kind test の作業ログに記録する`,
    `- 対象版: ${target}`, "",
    "### 確認が残る事項", "",
    ...(remainingChecks.length ? ["| 要求の出典 | 確かめる担当 | 理由 |", "|---|---|---|", ...remainingChecks.map(check => `| ${check.source} | ${check.owner} | ${check.reason} |`)] : ["なし"]), "",
    "### CI の結果（親だけが照合）", "",
    "親はテストを実行せず、同じ head SHA に対する CI の結果を GitHub から読むだけにした（評価用の模擬。偽 GitHub の観測を scripts/ci-checks.ts の result.json の形で記録した）。CI の結果はレビュー担当へ渡していない。", "",
    ...(ci.verdict === "照合せず（未実施）" ? [`- CI 判定: ${ci.verdict}（${ci.reason}）`, `- 記録: ${ci.recordPath}（sha256 ${ci.sha256}）`] : [
      `- CI 判定: ${ci.verdict}（${ci.reason}）`,
      `- 必須のチェックと出典: ${ci.required.map(check => `${check.context}（app の指定なし。出典: ${check.sources.join("・")}）`).join("、") || "なし"}。ブランチ保護 ${ci.verdict === "必須のチェックを決められず" ? "決められず" : "0件（読めた）"}、ルールセット 0件（読めた）、Workspace の規約 ${ci.required.filter(check => check.sources.includes("workspace-rules")).length}件`,
      `- 必須のチェックごとの結果: ${ci.required.map(check => `${check.context}=${check.result}${check.conclusion ? `（${check.conclusion}）` : ""}${check.url ? ` ${check.url}` : ""}`).join("、") || "なし"}`,
      `- head SHA の一致: result.json の head ${ci.headSha} と target.md の head ${input.headCommit} が${ci.headSha === input.headCommit ? "一致" : "不一致"}`,
      `- 観測時刻: ${ci.observedAt}（CI の完了を待たず、この時点の結果で判定した）`,
      `- 記録: ${dirname(ci.recordPath)}/（result.json の sha256 ${ci.sha256}）`,
    ]), "",
    "### 保存直前の受け入れ証拠の再照合", "",
    ...(agents.acceptance && status === "完了" ? [
      "- 取り直した時刻: 評価用の模擬（親が保存の直前に取り直した）",
      `- 比べた証拠: 受け入れ確認の結果の「判定に使った証拠」${used.length} 件`,
      ...(used.length ? ["", "| 項目 | 種類 | 出典 | 固定時の sha256 | 保存直前の sha256 | 結果 |", "|---|---|---|---|---|---|",
        ...used.map(item => `| ${item.id} | ${item.kind} | ${item.source} | ${item.sha256} | ${item.id in changed ? changed[item.id] ?? "取り直せず" : item.sha256} | ${affected.has(item.id) ? "変化（確認が残る事項）" : "変化なし"} |`), ""] : []),
      `- 取り直した参照元: ${origins.join("、") || "なし"}`,
      `- 固定の後に足された Activity: ${appended.length} 件（親以外の追記 ${others.length} 件${others.length ? `: ${others.map(entry => `${entry.id}（${entry.what}、${entry.actor}、${entry.at}）`).join("、")}` : ""}。止めなかった親自身の記録 ${appended.filter(entry => entry.kept === "親自身の記録").length} 件、Issue のイベント ${appended.filter(entry => entry.kept === "Issue のイベント").length} 件）`,
      "- 親以外の追記は、種類・書いた人・返信先・本文を問わず、使用した証拠の有効性を確認できないものとして、判定に使った証拠を使ったすべての行の確認が残る事項にした。親自身の記録かどうかは書いた人ではなく own-logs の id で決めた。",
      "- この再照合は観測時点までの確認であり、将来の配置状態は保証しない。変化があっても、この実行では新しい証拠へ差し替えて判定し直さず、担当の判定本文・最終状態・点数を変えない。",
    ] : ["対象なし（受け入れ確認担当の有効な結果なし）"]), "",
    "### 担当", "",
    "| 役割 | 定義名 | 担当 ID | 終了状態 |", "|---|---|---|---|",
    ...roles.map(([role, name, definition]) => `| ${name} | ${definition} | ${agents[role]?.id ?? "未取得"} | ${agents[role] ? "有効な結果を受領" : launched(role) ? "有効な結果なし" : role === "acceptance" && agents.refute ? "起動せず（受け入れ確認担当の行なし）" : "未起動"} |`),
    "", `- 実装者との対応: 実装者 ${input.implementer} と各担当は別の担当。ID の違いだけで会話を引き継いでいないことの証明とは扱わない。`, "",
    "### 試行の記録", "",
    "omp 内部の再試行は担当のセッション内で omp が行った retry で、親による再委譲（新しいコンテキストでの新しい担当）とは別に記録する。無効な試行の出力は後続の担当へ渡さず、親専用の監査領域に残した。", "",
    "| 役割 | 試行 | 担当 ID | 結果 | 無効の理由 | 保存場所と sha256 | omp 内部の再試行 | 親による再委譲 |", "|---|---|---|---|---|---|---|---|",
    ...attempts.map(attempt => `| ${roleNames[attempt.role]} | ${attempt.attempt} | ${attempt.id} | ${attempt.result} | ${attempt.reason ?? "-"} | ${attempt.saved ? `${attempt.saved.path}（${attempt.saved.sha256}）` : "-"} | ${attempt.ompRetries.join("、") || "記録なし"} | ${attempt.redelegation ?? "-"} |`),
    "",
    "### 後続判断", "",
    status === "完了"
      ? `確定した要対応の点数 ${score}、要対応 ${mustFix.length} 件、確認が残る事項 ${remainingChecks.length} 件、CI 判定 ${ci.verdict}。マージ可否は${mergeReadiness}。${mergeReadiness.startsWith("不可") ? "人の判断なしにマージへ進めない。" : ""}${ci.verdict === "未確定" || ci.verdict === "結果なし" ? "CI の完了後に親の手順の13節の CI の再照合で判定し直す。" : ""}`
      : `独立レビュー${status}。Done・In Review・PR へ進めない。マージ可否は不可（人の判断が要る）。`, "",
    "### 独立性の限界", "",
    "探索と反証と受け入れ確認は別コンテキストで実行し、探索には異なるモデルを設定するが、見落としが共通する可能性は残り、設定だけで各実行の実効モデルの違いを証明するものではない。", "",
    "## 反証担当の判定本文（原文のまま）", "",
    `- 原本: ${verdict === null ? "未受領" : verdictPath}`, `- sha256: ${verdict === null ? "なし" : sha256(verdict)}`, `- 担当 ID: ${agents.refute?.id ?? "未取得"}`, "",
    "<!-- refute-verdict:begin -->",
    `${verdict ?? `未受領（${reason}）\n`}<!-- refute-verdict:end -->`, "",
    "## 受け入れ確認担当の結果（原文のまま）", "",
    `- 原本: ${acceptanceResult === null ? "未受領" : acceptancePath}`, `- sha256: ${acceptanceResult === null ? "なし" : sha256(acceptanceResult)}`, `- 担当 ID: ${agents.acceptance?.id ?? "未取得"}`, "",
    "<!-- acceptance-result:begin -->",
    acceptanceBody,
  ].join("\n") + "<!-- acceptance-result:end -->\n";
  writeFileSync(join(workDirectory, "parent", "report.md"), report);

  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const document = recorder.createDocument(input.issueId, `${input.issueId.toLowerCase()}-code-review-${date}-${shortRun}.md`, `${input.issueId} コードレビュー結果（${shortRun}）`, report);
  const assignment = roles.filter(([role]) => agents[role]).map(([role, name, definition]) => `${name}=${definition}/${agents[role]?.id}`).join("、");
  const invalidAttempts = attempts.filter(attempt => attempt.result !== "有効");
  const attemptSummary = invalidAttempts.length
    ? `無効な試行: ${invalidAttempts.map(attempt => `${roleNames[attempt.role]}の${attempt.attempt}回目 ${attempt.id}（${attempt.result}: ${attempt.reason}。親による再委譲${attempt.redelegation}）`).join("、")}。`
    : "";
  const ciNote = `CI判定${ci.verdict}（head ${ci.headSha}）`;
  const summary = recorder.log(input.issueId, status === "完了"
    ? `初回独立レビュー完了。確定した要対応の点数${score}。要対応${mustFix.map(finding => finding.id).join("、") || "なし"}。${judged.length ? `受け入れ確認: ${judged.map(row => `${row.source}=${row.judgment}`).join("、")}。` : ""}確認が残る事項${remainingChecks.length}件${remainingSummary ? `（${remainingSummary}）` : ""}。${ciNote}。マージ可否${mergeReadiness}。報告Document ${document.id}。runId ${runId}。担当: ${assignment}。${attemptSummary}`
    : `初回独立レビュー${status}。原因: ${reason}。取得できた担当: ${assignment || "なし"}。${attemptSummary}点数なし。${ciNote}。マージ可否${mergeReadiness}。報告Document ${document.id}。runId ${runId}。Done・In Review・PRへ進めない。`,
    status === "完了" ? "progress" : "blocker");
  recordOwnLog(workDirectory, summary.id, "初回独立レビューの要約の作業ログ");
  // 11節: 報告の保存と作業ログの後に merge-ready を付ける・外し、操作と根拠を --kind test に1件残す。
  if (mergeReady === "付けた") recorder.label(input.issueId, "add", "merge-ready");
  else if (mergeReady === "外した") recorder.label(input.issueId, "remove", "merge-ready");
  const mergeReadyLog = recorder.log(input.issueId, mergeReadyRecord({ operation: mergeReady, blockers, head: input.headCommit, base: `${ci.base}（merge-base ${input.baseCommit}）`, ci, mergeReadiness, documentId: document.id, runId }), "test").id;
  recordOwnLog(workDirectory, mergeReadyLog, "merge-ready の操作の記録（--kind test）");

  return {
    independent: true, issueId: input.issueId, implementer: input.implementer, baseCommit: input.baseCommit, headCommit: input.headCommit,
    runId, workDirectory, status, score,
    target: { baseSha: input.baseCommit, headSha: input.headCommit },
    agents,
    attempts,
    reportDocument: { id: document.id, path: document.path },
    verdict: verdict === null ? null : { path: verdictPath, sha256: sha256(verdict) },
    acceptance: acceptanceResult === null ? null : { path: acceptancePath, sha256: sha256(acceptanceResult) },
    acceptanceRows: judged,
    usedEvidence: used,
    ci,
    remainingChecks,
    mergeReadiness,
    mergeReady, mergeReadyLog,
    standards: input.standards,
    ...(input.spec ? { spec: input.spec } : {}),
  };
}

/** merge-ready の操作と判定の根拠の記録（11節・13節の --kind test）。 */
function mergeReadyRecord(record: { operation: LabelOperation; blockers: string[]; head: string; base: string; ci: CiRecord | null; mergeReadiness: MergeReadiness; documentId: number; runId: string; recheck?: string }) {
  const { operation, ci } = record;
  return [
    `merge-ready: ${operation}${operation === "付けた" ? "" : `（マージ可否が不可: ${record.blockers.join("、")}）`}。`,
    `判定した head SHA ${record.head}、基点 ${record.base}、${ci ? ciSummary(ci) : "CI は照合せず"}、マージ可否${record.mergeReadiness}、`,
    `報告Document ${record.documentId}、runId ${record.runId}${record.recheck ? `、${record.recheck}` : ""}、`,
    `CI の記録 ${ci ? `${dirname(ci.recordPath)}/（${ci.recordPath.endsWith("result.json") ? "result.json" : "not-run.md"} の sha256 ${ci.sha256}）` : "なし"}。`,
    "ラベルは現在の判定の表示で、自動マージの指示ではない。",
  ].join("");
}

export type CiRecheck = {
  number: number; reviewHead: string; currentHead: string; recordPath: string; reason: string;
  ci: CiRecord | null; remainingChecks: RemainingCheck[]; mergeReadiness: MergeReadiness; mergeReady: LabelOperation; log: number;
};
/**
 * 親の手順13節の CI の再照合（同じ head SHA）を、保存した初回レビューの作業ディレクトリで再現する。レビューはやり直さず、担当にも委譲しない。
 * head が違えば照合せず、merge-ready が付いていれば外して「判定が古い（追加コミット）」を記録する。head が同じなら10節の3を同じ方法で取り直し
 * （固定時の Activity と own-logs.md の id で比べる。要求の取り直しは評価用の模擬で変化なし）、CI を parent/ci/<n>/ に照合して10節の8と同じ規則でマージ可否を決める。
 * 親の規則どおりに書くだけで、PMの判断は代行しない。記録は parent/recheck-<n>/record.md に置く。
 */
export function recheckReviewCi(review: InitialReview, input: { currentHead: string; ci?: CiInput; changed?: Record<string, string | null> }, recorder: ReviewRecorder): CiRecheck {
  const parent = join(review.workDirectory, "parent");
  const number = Math.max(readdirSync(join(parent, "ci")).length, readdirSync(parent).filter(name => name.startsWith("recheck-")).length) + 1;
  const directory = join(parent, `recheck-${number}`);
  mkdirSync(directory, { recursive: true });
  const issue = recorder.show(review.issueId);
  const labeled = issue.labels.includes("merge-ready");
  const stale = input.currentHead !== review.headCommit;
  const blocked = review.status !== "完了" || review.score !== 5 || review.remainingChecks.length > 0;
  let ci: CiRecord | null = null;
  let added: RemainingCheck[] = [];
  let reason: string;
  if (stale) reason = `判定が古い（追加コミット）。報告の head ${review.headCommit} と現在の head ${input.currentHead} が違うので照合しない。新しい head には新しいレビューが要る`;
  else if (blocked) reason = `照合し直しても可にならない（最終状態 ${review.status}、確定した要対応の点数 ${review.score ?? "点数なし"}、報告の確認が残る事項 ${review.remainingChecks.length} 件）`;
  else {
    const fixedPath = join(review.workDirectory, "acceptance-input", "records", "activity.json");
    const activity = existsSync(fixedPath) ? { fixed: JSON.parse(readFileSync(fixedPath, "utf8")) as ActivityItem[], current: issue.activity, ownLogs: readOwnLogs(review.workDirectory) } : undefined;
    added = evidenceChecks(review.usedEvidence, input.changed ?? {}, activity, `CI の再照合 ${number} の取り直し`).checks;
    if (!input.ci) throw new Error("同じ head の再照合には CI の観測が要る");
    ci = writeCi(join(parent, "ci", String(number)), input.ci);
    reason = added.length ? `確認が残る事項を ${added.length} 件加えた` : ciPassed(ci, review.headCommit) ? "報告の判定と同じ head SHA の CI 判定成功がそろった" : `CI 判定 ${ci.verdict}（${ci.reason}）`;
  }
  const mergeReadiness: MergeReadiness = !stale && !blocked && added.length === 0 && ci !== null && ciPassed(ci, review.headCommit) ? "可（人のレビューなしでマージ可）" : "不可（人の判断が要る）";
  const mergeReady: LabelOperation = mergeReadiness.startsWith("可") ? "付けた" : labeled ? "外した" : "付けていない";
  if (mergeReady === "付けた") recorder.label(review.issueId, "add", "merge-ready");
  else if (mergeReady === "外した") recorder.label(review.issueId, "remove", "merge-ready");
  const log = recorder.log(review.issueId, mergeReadyRecord({
    operation: mergeReady, blockers: [reason], head: review.headCommit, base: review.ci.base, ci, mergeReadiness, documentId: review.reportDocument.id, runId: review.runId,
    recheck: `CI の再照合 ${number}（現在の head ${input.currentHead}、記録 ${join(directory, "record.md")}、確認が残る事項の追加 ${added.length} 件${added.length ? `: ${added.map(check => `${check.source}（${check.reason}）`).join("、")}` : ""}）`,
  }), "test").id;
  recordOwnLog(review.workDirectory, log, `CI の再照合 ${number} の記録（--kind test）`);
  const recordPath = join(directory, "record.md");
  writeFileSync(recordPath, [
    `# CI の再照合 ${number}（親の手順の13節）`, "",
    `- 報告 Document: ${review.reportDocument.id}（runId ${review.runId}）。報告 Document は書き換えない`,
    `- 比べた head: 報告の head ${review.headCommit}／現在の head ${input.currentHead}（${stale ? "不一致。照合しない" : "一致"}）`,
    `- 要求・受け入れ証拠の再照合: ${stale || blocked ? "しない" : `要求は評価用の模擬で変化なし。受け入れ証拠は確認が残る事項を ${added.length} 件加えた`}`,
    ...added.map(check => `  - ${check.source}（${check.owner}）: ${check.reason}`),
    `- CI の記録: ${ci ? `${dirname(ci.recordPath)}/（result.json の sha256 ${ci.sha256}）。${ciSummary(ci)}` : "照合しない"}`,
    `- マージ可否: ${mergeReadiness}（${reason}）`,
    `- merge-ready: ${mergeReady}`,
    `- 書いた作業ログの id: ${log}（own-logs.md に記録）`, "",
  ].join("\n"));
  return { number, reviewHead: review.headCommit, currentHead: input.currentHead, recordPath, reason, ci, remainingChecks: added, mergeReadiness, mergeReady, log };
}

/** PR作業で取った CI 判定（null は照合しなかった）。ready は In Review へ移せる（同じ head の CI 判定が成功で、再照合で確認が残る事項が増えていない）こと。 */
export type SubmissionCi = { headSha: string; verdict: CiRecord["verdict"] | null; ready: boolean; recheck?: CiRecheck };
/**
 * PR作業の終了条件（PMの実装手順）で、PR の head に対する CI 判定を取る。head が初回レビューの対象版と同じなら13節の再照合を行う。
 * 違えば13節の再照合はせず（merge-ready が付いていれば13節の2で外す）、新しい head の CI をレビューの作業ディレクトリの外へ照合して --kind test に残す。
 * 新しい head には merge-ready を付けない。
 */
export function checkSubmissionCi(review: InitialReview, input: { head: string; ci: CiInput }, recorder: ReviewRecorder): SubmissionCi {
  if (input.head === review.headCommit) {
    const recheck = recheckReviewCi(review, { currentHead: input.head, ci: input.ci }, recorder);
    const verdict = recheck.ci?.verdict ?? null;
    return { headSha: input.head, verdict, ready: verdict === "成功" && recheck.remainingChecks.length === 0, recheck };
  }
  if (recorder.show(review.issueId).labels.includes("merge-ready")) recheckReviewCi(review, { currentHead: input.head }, recorder);
  const parent = dirname(review.workDirectory);
  const ci = writeCi(join(parent, `ci-${input.head.slice(0, 12)}-${readdirSync(parent).filter(name => name.startsWith(`ci-${input.head.slice(0, 12)}`)).length + 1}`), input.ci);
  recorder.log(review.issueId, `PR の head ${input.head} の CI 判定（初回レビューの対象版 ${review.headCommit} と違うので13節の再照合はしない）: ${ciSummary(ci)}。基点 ${ci.base}。CI の記録 ${dirname(ci.recordPath)}/（result.json の sha256 ${ci.sha256}）。修正後の head には merge-ready を付けない（新しい head のマージ可否には新しいレビューが要る）。`, "test");
  return { headSha: input.head, verdict: ci.verdict, ready: ci.verdict === "成功" && ci.headSha === input.head };
}
