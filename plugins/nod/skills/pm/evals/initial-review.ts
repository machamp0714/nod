import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ReviewRole = "standards" | "spec" | "refute";
/** 反証担当が確定した結果。impactがある指摘は要対応、ない指摘は任意として扱う。 */
export type ReviewFinding = { id: string; category: string; evidence: string; commit: string; impact?: number; acceptance?: string; suggestion?: string };
export type ReviewAxis = { findings: ReviewFinding[]; evidence: string };
/** 確認が残る事項。最終状態と点数を変えず、マージ可否だけを止める。 */
export type RemainingCheck = { source: string; owner: string; reason: string };
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
  /** 起動した担当のうち有効な結果を返した担当。3担当がそろわなければ未完了になる。探索の片方が無ければ反証は起動しない。 */
  received?: ReviewRole[];
  /**
   * 利用枠の上限以外の、判定と関係しない理由で無効だった試行（役割ごとに試行の順）。親は同じ入力で1回だけ再委譲する。
   * received にある役割は1件（再委譲で有効）、received に無い起動済みの役割は2件（再委譲も無効）を持つ。
   */
  invalid?: Partial<Record<ReviewRole, InvalidAttempt[]>>;
  /** 利用枠の上限で失敗した役割。親は再委譲せずその時点で止め、まだ起動していない担当も起動しない。 */
  usageLimit?: { role: ReviewRole } & InvalidAttempt;
  standards: ReviewAxis; spec?: ReviewAxis;
  /**
   * 反証担当が、コードレベルで結論を出せない理由（コード要求の中身を決める要求資料の不足・結論に必要な依存の契約の不足・要求間の矛盾・採否を確定できない候補）と
   * 確かめる担当を示して「未確認」とした対応表の行。有効な結果であり、完了のまま確認が残る事項になる。
   */
  unconfirmed?: RemainingCheck[];
  /** 10節の8の直前に、同じ head SHA の CI を照合した結果。未実施では照合せず not-run.md だけを書く。 */
  ci: CiInput;
  /** 10節の8・11節で、head を固定した元（ref・PR）から取り直した対象の現在の head。省略すると固定した head と同じ（追加コミットなし）。違えばマージ可否は不可。 */
  currentHead?: string;
  /** 10節の8・11節で、PR から取り直した現在の基点（`baseRefName`）。省略すると CI の照合に使った基点と同じ。違えばマージ可否は不可（基点が変わった）。 */
  currentBase?: string;
};
/** 実装を進行する親がnodへ書く経路。偽CLIは実nod CLI（--json）、setupはcore APIを渡す。log は書いた記録の id を返す。 */
export type ReviewRecorder = {
  createDocument(issueId: string, path: string, title: string, body: string): { id: number; path: string };
  log(issueId: string, body: string, kind: "progress" | "blocker" | "test"): { id: number };
  show(issueId: string): { title: string; description: string | null; labels: string[] };
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
  auditDocument: { id: number; path: string };
  verdict: { path: string; sha256: string } | null;
  ci: CiRecord;
  remainingChecks: RemainingCheck[];
  mergeReadiness: MergeReadiness;
  /** 報告の保存と作業ログの後に行った merge-ready の操作と、それを記録した --kind test の作業ログの id。 */
  mergeReady: LabelOperation;
  mergeReadyLog: number;
  standards: ReviewAxis; spec?: ReviewAxis;
};

const roles = [["standards", "Standards 探索", "code-reviewer-standards"], ["spec", "Spec 探索", "code-reviewer-spec"], ["refute", "反証", "code-reviewer-refute"]] as const;
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

/** 2.3節の要求の写し（評価用の模擬では Issue のタイトルと本文だけ）。10節の2と13節の4は固定時の `input/requirements/issue.md` と比べる。 */
const issueRequirement = (issue: { title: string; description: string | null }) => `# ${issue.title}\n\n${issue.description ?? ""}\n`;
const scopeNote = "このレビューはコードレベルの確認であり、ブラウザ検証・見た目やデザイン・実環境での動作・作業手順は確かめておらず、別のフローで扱う。";

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

/**
 * nod:implementの親が残す初回独立レビューの成果（作業ディレクトリ、報告Document、作業ログ）を再現する。
 * 最終状態・点数・確認が残る事項・マージ可否は親の規則どおりに書くだけで、PMの受理判断は行わない。モデルやgitの実行はしない。
 */
export function recordInitialReview(input: InitialReviewInput, recorder: ReviewRecorder): InitialReview {
  const required = roles.map(([role]) => role);
  const valid = new Set<ReviewRole>(input.notRun === undefined ? input.received ?? required : []);
  const explored = valid.has("standards") && valid.has("spec");
  if (valid.has("refute") && !explored) throw new Error("反証は両探索の有効な結果を受け取った後にだけ起動する");
  const launched = (role: ReviewRole) => input.notRun === undefined && (role !== "refute" || explored);
  const limited = input.usageLimit;
  if (limited && (valid.has(limited.role) || !launched(limited.role))) throw new Error("利用枠の上限で失敗した役割は、起動したが有効な結果の無い役割だけ");
  // 最終状態は3担当の有効な結果の有無だけで決める。
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
    const path = join(directory, role === "refute" ? "verdict.md" : "handoff.md");
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
  // 未確認が残っても、完了なら確定した要対応から点数を出す。
  const score = status === "完了" ? mustFix[0]?.impact ?? 5 : null;
  const unconfirmed = input.unconfirmed ?? [];
  // 確認が残る事項は、反証の未確認（コードレベルで結論を出せないもの）と保存直前の再照合の変化だけ。評価用の模擬では保存直前の要求資料は固定時と同じ。
  const remainingChecks = status === "完了" ? [...unconfirmed] : [];
  const specMustFix = mustFix.filter(finding => finding.axis === "Spec");
  const table = [
    { source: "requirements/issue.md", state: specMustFix.length ? "未充足" : "充足", evidence: input.spec?.evidence ?? "Spec 探索の結果なし", candidates: specMustFix.map(finding => finding.id).join(", ") || "-" },
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
  // 10節の8: CI の照合に続けて、head を固定した元から対象の現在の head（PR なら基点も）を取り直し、固定した head と CI の照合に使った基点と比べる（未実施では照合しない）。
  const currentHead = input.currentHead ?? input.headCommit;
  const headMoved = status !== "未実施" && currentHead !== input.headCommit;
  const currentBase = input.currentBase ?? ci.base;
  const baseMoved = status !== "未実施" && currentBase !== ci.base;
  // 対応表の「未充足」と要対応、「未確認」と確認が残る事項の対応は反証の形式の検査で担保するので、マージ可否の判定では対応表の行を別に数えない。
  // CI 判定は result.json の head が対象版の head と同じで成功のときだけ満たす。
  const mergeReadiness: MergeReadiness = status === "完了" && score === 5 && remainingChecks.length === 0 && ciPassed(ci, input.headCommit) && !headMoved && !baseMoved
    ? "可（人のレビューなしでマージ可）" : "不可（人の判断が要る）";
  const blockers = [
    ...status === "完了" ? [] : [`最終状態 ${status}`],
    ...score === 5 || score === null ? [] : [`確定した要対応の点数 ${score}`],
    ...remainingChecks.length ? [`確認が残る事項 ${remainingChecks.length} 件`] : [],
    ...ciPassed(ci, input.headCommit) ? [] : [`CI 判定 ${ci.verdict}（${ci.reason}。result.json の head ${ci.headSha === input.headCommit ? "は" : "が"}対象版の head と${ci.headSha === input.headCommit ? "一致" : "不一致"}）`],
    ...headMoved ? [`対象版が現在の head と違う（追加コミット。固定した head ${input.headCommit}、現在の head ${currentHead}）`] : [],
    ...baseMoved ? [`基点が変わった（CI の照合に使った基点 ${ci.base}、現在の基点 ${currentBase}）`] : [],
  ];
  const headCheck = status === "未実施" ? "照合せず（独立レビュー未実施）" : `固定した head ${input.headCommit}／現在の head ${currentHead}（${headMoved ? "不一致。対象版が現在の head と違う（追加コミット）" : "一致"}）、CI の照合に使った基点 ${ci.base}／現在の基点 ${currentBase}（${baseMoved ? "不一致。基点が変わった" : "一致"}）`;
  if (status !== "未実施") writeFileSync(join(workDirectory, "parent", "head-check.md"), [
    "# 現在の head と基点の照合（親の手順の10節の8・11節）", "",
    "- 取り直した元: 評価用の模擬（parent/head-source.md の PR の headRefOid と baseRefName）",
    `- マージ可否を決める直前: ${headCheck}`,
    ...mergeReadiness.startsWith("可") ? [`- merge-ready を付ける直前: ${headCheck}`] : [], "",
  ].join("\n"));
  // ラベルは報告の保存と作業ログの後に操作するが、報告には行う操作を書く。
  const labeled = recorder.show(input.issueId).labels.includes("merge-ready");
  const mergeReady: LabelOperation = mergeReadiness.startsWith("可") ? "付けた" : labeled ? "外した" : "付けていない";
  const remainingSummary = remainingChecks.map(check => `${check.source}（${check.owner}、${check.reason}）`).join("、");
  const target = `mode: commit／merge-base の SHA ${input.baseCommit}／head の SHA ${input.headCommit}`;

  mkdirSync(join(workDirectory, "refute"), { recursive: true });
  // 2.3節の要求の写し。10節の2（保存直前）と13節の4（CI の再照合）はこれと比べる。
  const requirement = issueRequirement(recorder.show(input.issueId));
  mkdirSync(join(workDirectory, "input", "requirements"), { recursive: true });
  writeFileSync(join(workDirectory, "input", "requirements", "issue.md"), requirement);

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
    "## 要求資料ごとのコード要求（確定）", "",
    "| 要求資料 | コード要求 |", "|---|---|",
    "| requirements/issue.md | あり |", "",
    "## コード要求の対応表（確定）", "",
    "| 要求の出典 | 状態 | 証拠または不足理由 | 候補ID |", "|---|---|---|---|",
    ...table.map(row => `| ${row.source} | ${row.state} | ${row.evidence} | ${row.candidates} |`), "",
    "## 表から除いた行", "", "なし", "",
    "## 未確認と理由", "",
    ...(unconfirmed.length ? [
      "| 要求の出典または候補ID | 軸 | 種別 | 理由 | 確かめる担当 | 不足箇所 |", "|---|---|---|---|---|---|",
      ...unconfirmed.map(check => `| ${check.source} | Spec | 対応表 | ${check.reason} | ${check.owner} | ${check.reason} |`),
    ] : ["なし"]), "",
    "## 判断を見送った事項", "", "なし", "",
    "## 採否一覧（監査用）", "",
    "| 候補 ID | 発見者の区分 | 判定 | 影響度 | 同一原因 | 根拠 |", "|---|---|---|---|---|---|",
    ...findings.map(finding => `| ${finding.id} | ${finding.finder} | ${finding.impact === undefined ? "任意" : "要対応"} | ${finding.impact ?? "-"} | - | ${finding.evidence} |`), "",
  ].join("\n") : null;
  if (verdict !== null) writeFileSync(verdictPath, verdict);

  const audit = [
    "## 管理情報（親が記入）", "",
    `- runId: ${runId}`, `- 作業ディレクトリ: ${workDirectory}`,
    `- 最終状態: ${status === "完了" ? "完了" : `${status}（理由: ${reason}）`}`,
    `- 確定した要対応の点数: ${score ?? "点数なし"}`,
    `- 点数の計算: ${status === "完了" ? `要対応 ${mustFix.length} 件（${mustFix.map(finding => `${finding.id}: ${finding.impact}`).join("、") || "なし"}）。最も重い影響度で ${score}。` : `${status}のため点数なし。`}点数は確定した要対応の影響度だけを表し、要求の確認率やマージ許可を表さない。`,
    `- 確認が残る事項: ${remainingChecks.length} 件（下の「確認が残る事項」の節）`,
    "- マージ可否・現在の head と基点の照合・merge-ready: CI の結果を含むので、次の ci-result の印の中だけに書く",
    "<!-- ci-result:begin -->",
    `- マージ可否: ${mergeReadiness}`,
    ...(mergeReadiness.startsWith("不可") ? [`  - 不可の理由: ${blockers.join("／")}`] : []),
    `- 現在の head と基点の照合: ${headCheck}（記録: ${join(workDirectory, "parent", "head-check.md")}）`,
    `- merge-ready: ${mergeReady}${mergeReady === "付けた" ? "" : `（${mergeReady === "外した" ? "付いていたが、" : ""}マージ可否が不可）`}。報告の保存と作業ログの直後に行う操作。ラベルは現在の判定の表示で、自動マージの指示ではない。操作の結果は判定した head SHA・現在の head の照合・基点・CI 判定・この報告の Document ID・runId とともに、本文が [ci-result] で始まる --kind test の作業ログに記録する`,
    "<!-- ci-result:end -->",
    `- 対象版: ${target}`, "",
    "### 確認が残る事項", "",
    ...(remainingChecks.length ? ["| 要求の出典 | 確かめる担当 | 理由 |", "|---|---|---|", ...remainingChecks.map(check => `| ${check.source} | ${check.owner} | ${check.reason} |`)] : ["なし"]), "",
    "### CI の結果（親だけが照合）", "",
    "CI の結果は次の ci-result の印の中だけに書く。", "",
    "<!-- ci-result:begin -->",
    "親はテストを実行せず、同じ head SHA に対する CI の結果を GitHub から読むだけにした（評価用の模擬。偽 GitHub の観測を scripts/ci-checks.ts の result.json の形で記録した）。CI の結果はレビュー担当へ渡していない。", "",
    ...(ci.verdict === "照合せず（未実施）" ? [`- CI 判定: ${ci.verdict}（${ci.reason}）`, `- 記録: ${ci.recordPath}（sha256 ${ci.sha256}）`] : [
      `- CI 判定: ${ci.verdict}（${ci.reason}）`,
      `- 必須のチェックと出典: ${ci.required.map(check => `${check.context}（app の指定なし。出典: ${check.sources.join("・")}）`).join("、") || "なし"}。ブランチ保護 ${ci.verdict === "必須のチェックを決められず" ? "決められず" : "0件（読めた）"}、ルールセット 0件（読めた）、Workspace の規約 ${ci.required.filter(check => check.sources.includes("workspace-rules")).length}件`,
      `- 必須のチェックごとの結果: ${ci.required.map(check => `${check.context}=${check.result}${check.conclusion ? `（${check.conclusion}）` : ""}${check.url ? ` ${check.url}` : ""}`).join("、") || "なし"}`,
      `- head SHA の一致: result.json の head ${ci.headSha} と target.md の head ${input.headCommit} が${ci.headSha === input.headCommit ? "一致" : "不一致"}`,
      `- 観測時刻: ${ci.observedAt}（CI の完了を待たず、この時点の結果で判定した）`,
      `- 記録: ${dirname(ci.recordPath)}/（result.json の sha256 ${ci.sha256}）`,
    ]),
    "<!-- ci-result:end -->", "",
    "### 保存時の要求変化の確認", "",
    `- requirements/issue.md: 固定時と保存直前の sha256 ${sha256(requirement)} が一致（変化なし。評価用の模擬）`, "",
    "### 担当", "",
    "| 役割 | 定義名 | 担当 ID | 終了状態 |", "|---|---|---|---|",
    ...roles.map(([role, name, definition]) => `| ${name} | ${definition} | ${agents[role]?.id ?? "未取得"} | ${agents[role] ? "有効な結果を受領" : launched(role) ? "有効な結果なし" : "未起動"} |`),
    "", `- 実装者との対応: 実装者 ${input.implementer} と各担当は別の担当。ID の違いだけで会話を引き継いでいないことの証明とは扱わない。`, "",
    "### 試行の記録", "",
    "omp 内部の再試行は担当のセッション内で omp が行った retry で、親による再委譲（新しいコンテキストでの新しい担当）とは別に記録する。無効な試行の出力は後続の担当へ渡さず、親専用の監査領域に残した。", "",
    "| 役割 | 試行 | 担当 ID | 結果 | 無効の理由 | 保存場所と sha256 | omp 内部の再試行 | 親による再委譲 |", "|---|---|---|---|---|---|---|---|",
    ...attempts.map(attempt => `| ${roleNames[attempt.role]} | ${attempt.attempt} | ${attempt.id} | ${attempt.result} | ${attempt.reason ?? "-"} | ${attempt.saved ? `${attempt.saved.path}（${attempt.saved.sha256}）` : "-"} | ${attempt.ompRetries.join("、") || "記録なし"} | ${attempt.redelegation ?? "-"} |`),
    "",
    "### 後続判断", "",
    status === "完了"
      ? `確定した要対応の点数 ${score}、要対応 ${mustFix.length} 件、確認が残る事項 ${remainingChecks.length} 件。マージ可否と CI の結果に触れる部分は、次の ci-result の印の中だけに書く。`
      : `独立レビュー${status}。Done・In Review・PR へ進めない。マージ可否と CI の結果に触れる部分は、次の ci-result の印の中だけに書く。`, "",
    "<!-- ci-result:begin -->",
    status === "完了"
      ? `CI 判定 ${ci.verdict}。マージ可否は${mergeReadiness}。${mergeReadiness.startsWith("不可") ? "人の判断なしにマージへ進めない。" : ""}${ci.verdict === "未確定" || ci.verdict === "結果なし" ? "CI の完了後に親の手順の13節の CI の再照合で判定し直す。" : ""}`
      : "マージ可否は不可（人の判断が要る）。",
    "<!-- ci-result:end -->", "",
    "### 独立性の限界", "",
    "探索と反証は別コンテキストで実行し、探索には異なるモデルを設定するが、見落としが共通する可能性は残り、設定だけで各実行の実効モデルの違いを証明するものではない。", "",
    "## 反証担当の判定本文（原文のまま）", "",
    `- 原本: ${verdict === null ? "未受領" : verdictPath}`, `- sha256: ${verdict === null ? "なし" : sha256(verdict)}`, `- 担当 ID: ${agents.refute?.id ?? "未取得"}`, "",
    "<!-- refute-verdict:begin -->",
    `${verdict ?? `未受領（${reason}）\n`}<!-- refute-verdict:end -->`, "",
  ].join("\n");
  writeFileSync(join(workDirectory, "parent", "audit.md"), audit);

  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const auditDocument = recorder.createDocument(input.issueId, `${input.issueId.toLowerCase()}-code-review-audit-${date}-${shortRun}.md`, `${input.issueId} コードレビュー監査（${shortRun}）`, audit);
  const cell = (text: string) => text.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
  const severity = (impact: number) => ["Critical", "Critical", "High", "Medium", "Low"][impact];
  const report = [
    "## 結果", "",
    `- 最終状態: ${status === "完了" ? status : `${status}（理由: ${reason}）`}`,
    `- 確定した要対応の点数: ${score ?? "点数なし"}`,
    `- 確認が残る事項: ${remainingChecks.length} 件`,
    `- 対象: ${input.headCommit}（基点 ${input.baseCommit}）`,
    `- 範囲: ${scopeNote}`,
    "<!-- ci-result:begin -->",
    `- マージ可否: ${mergeReadiness}`,
    ...(blockers.length ? [`- 理由: ${blockers.join("／")}`] : []),
    `- CI 判定: ${ci.verdict}`,
    `- merge-ready: ${mergeReady}`,
    "<!-- ci-result:end -->", "",
    "## 要対応", "",
    ...(mustFix.length ? [
      "| ID | Severity（影響度） | 問題 | 場所・影響の根拠 |",
      "|---|---|---|---|",
      ...mustFix.map(finding => `| ${cell(finding.id)} | ${severity(finding.impact!)}（${finding.impact}） | ${cell(finding.category)} | ${cell(finding.evidence)} |`),
    ] : ["なし"]), "",
    `## 未確認（${remainingChecks.length}件）`, "",
    ...(remainingChecks.length ? [
      "| 出典 | 確認する人・担当 | 不足している確認 |", "|---|---|---|",
      ...remainingChecks.map(check => `| ${cell(check.source)} | ${cell(check.owner)} | ${cell(check.reason)} |`),
    ] : ["なし"]), "",
    "## 監査記録", "",
    `- Document ${auditDocument.id}（${auditDocument.path}）`,
    `- runId: ${runId}`, "",
  ].join("\n");
  writeFileSync(join(workDirectory, "parent", "report.md"), report);
  const document = recorder.createDocument(input.issueId, `${input.issueId.toLowerCase()}-code-review-${date}-${shortRun}.md`, `${input.issueId} コードレビュー結果（${shortRun}）`, report);
  const assignment = roles.filter(([role]) => agents[role]).map(([role, name, definition]) => `${name}=${definition}/${agents[role]?.id}`).join("、");
  const invalidAttempts = attempts.filter(attempt => attempt.result !== "有効");
  const attemptSummary = invalidAttempts.length
    ? `無効な試行: ${invalidAttempts.map(attempt => `${roleNames[attempt.role]}の${attempt.attempt}回目 ${attempt.id}（${attempt.result}: ${attempt.reason}。親による再委譲${attempt.redelegation}）`).join("、")}。`
    : "";
  // CI 判定・マージ可否・merge-ready は要約に書かず、[ci-result] で始まる --kind test の記録だけに書く（3節）。
  const ciNote = `監査Document ${auditDocument.id}。CI判定・マージ可否・merge-readyは[ci-result]の作業ログを参照`;
  recorder.log(input.issueId, status === "完了"
    ? `初回独立レビュー完了。確定した要対応の点数${score}。要対応${mustFix.map(finding => finding.id).join("、") || "なし"}。確認が残る事項${remainingChecks.length}件${remainingSummary ? `（${remainingSummary}）` : ""}。${ciNote}。報告Document ${document.id}。runId ${runId}。担当: ${assignment}。${attemptSummary}`
    : `初回独立レビュー${status}。原因: ${reason}。取得できた担当: ${assignment || "なし"}。${attemptSummary}点数なし。${ciNote}。報告Document ${document.id}。runId ${runId}。Done・In Review・PRへ進めない。`,
    status === "完了" ? "progress" : "blocker");
  // 11節: 報告の保存と作業ログの後に merge-ready を付ける・外し、操作と根拠を --kind test に1件残す。
  if (mergeReady === "付けた") recorder.label(input.issueId, "add", "merge-ready");
  else if (mergeReady === "外した") recorder.label(input.issueId, "remove", "merge-ready");
  const mergeReadyLog = recorder.log(input.issueId, mergeReadyRecord({ operation: mergeReady, blockers, head: input.headCommit, currentHead: status === "未実施" ? undefined : currentHead, currentBase: status === "未実施" ? undefined : currentBase, base: `${ci.base}（merge-base ${input.baseCommit}）`, ci, mergeReadiness, documentId: document.id, runId }), "test").id;

  return {
    independent: true, issueId: input.issueId, implementer: input.implementer, baseCommit: input.baseCommit, headCommit: input.headCommit,
    runId, workDirectory, status, score,
    target: { baseSha: input.baseCommit, headSha: input.headCommit },
    agents,
    attempts,
    reportDocument: { id: document.id, path: document.path },
    auditDocument: { id: auditDocument.id, path: auditDocument.path },
    verdict: verdict === null ? null : { path: verdictPath, sha256: sha256(verdict) },
    ci,
    remainingChecks,
    mergeReadiness,
    mergeReady, mergeReadyLog,
    standards: input.standards,
    ...(input.spec ? { spec: input.spec } : {}),
  };
}

/** merge-ready の操作と判定の根拠の記録（11節・13節の --kind test）。本文は [ci-result] で始める（3節）。 */
function mergeReadyRecord(record: { operation: LabelOperation; blockers: string[]; head: string; currentHead?: string; currentBase?: string; base: string; ci: CiRecord | null; mergeReadiness: MergeReadiness; documentId: number; runId: string; recheck?: string }) {
  const { operation, ci } = record;
  return [
    `[ci-result] merge-ready: ${operation}${operation === "付けた" ? "" : `（マージ可否が不可: ${record.blockers.join("、")}）`}。`,
    `判定した head SHA ${record.head}${record.currentHead ? `、現在の head ${record.currentHead}（${record.currentHead === record.head ? "一致" : "不一致"}）` : ""}、基点 ${record.base}${record.currentBase && ci ? `、現在の基点 ${record.currentBase}（${record.currentBase === ci.base ? "一致" : "不一致"}）` : ""}、${ci ? ciSummary(ci) : "CI は照合せず"}、マージ可否${record.mergeReadiness}、`,
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
 * head が違えば照合せず、merge-ready が付いていれば外して「判定が古い（追加コミット）」を記録する。head が同じなら要求資料を取り直して固定時の
 * input/requirements/ と比べ（変化は保存時の要求の変化として確認が残る事項に加える）、CI を parent/ci/<n>/ に照合して10節の8と同じ規則でマージ可否を決める。
 * 保存の後に Issue へ書かれた記録（作業ログ・コメント）では止めない。親の規則どおりに書くだけで、PMの判断は代行しない。記録は parent/recheck-<n>/record.md に置く。
 */
export function recheckReviewCi(review: InitialReview, input: { currentHead: string; ci?: CiInput }, recorder: ReviewRecorder): CiRecheck {
  const parent = join(review.workDirectory, "parent");
  // 13節の1: 番号は parent/ci/ の番号と parent/recheck-<n>/ の番号のうち最大のものの次（照合せずに終えた再照合は ci/<n> を作らないので、件数では数えない）。
  const numbers = [...readdirSync(join(parent, "ci")), ...readdirSync(parent).filter(name => name.startsWith("recheck-")).map(name => name.slice("recheck-".length))].map(Number).filter(Number.isInteger);
  const number = Math.max(0, ...numbers) + 1;
  const directory = join(parent, `recheck-${number}`);
  mkdirSync(directory, { recursive: true });
  const issue = recorder.show(review.issueId);
  const labeled = issue.labels.includes("merge-ready");
  const stale = input.currentHead !== review.headCommit;
  const blocked = review.status !== "完了" || review.score !== 5 || review.remainingChecks.length > 0;
  let ci: CiRecord | null = null;
  let added: RemainingCheck[] = [];
  let requirements = "照合せず";
  let reason: string;
  if (stale) reason = `判定が古い（追加コミット）。報告の head ${review.headCommit} と現在の head ${input.currentHead} が違うので照合しない。新しい head には新しいレビューが要る`;
  else if (blocked) reason = `照合し直しても可にならない（最終状態 ${review.status}、確定した要対応の点数 ${review.score ?? "点数なし"}、報告の確認が残る事項 ${review.remainingChecks.length} 件）`;
  else {
    // 13節の4: 要求資料を parent/recheck-<n>/requirements/ へ取り直し、固定時の input/requirements/ と比べる。
    const fixed = readFileSync(join(review.workDirectory, "input", "requirements", "issue.md"), "utf8");
    const current = issueRequirement(issue);
    mkdirSync(join(directory, "requirements"), { recursive: true });
    writeFileSync(join(directory, "requirements", "issue.md"), current);
    const fingerprints = `固定時 ${sha256(fixed).slice(0, 12)}、取り直し ${sha256(current).slice(0, 12)}`;
    requirements = `requirements/issue.md ${fixed === current ? "変化なし" : "変化あり"}（${fingerprints}）`;
    if (fixed !== current) added = [{ source: "requirements/issue.md", owner: "人", reason: `保存時の要求の変化（CI の再照合 ${number} の取り直しで本文の指紋が変わった。${fingerprints}。現在の要求への適合を確かめていない）` }];
    if (!input.ci) throw new Error("同じ head の再照合には CI の観測が要る");
    ci = writeCi(join(parent, "ci", String(number)), input.ci);
    reason = added.length ? `確認が残る事項を ${added.length} 件加えた（保存時の要求の変化）` : ciPassed(ci, review.headCommit) ? "報告の判定と同じ head SHA の CI 判定成功がそろった" : `CI 判定 ${ci.verdict}（${ci.reason}）`;
  }
  const mergeReadiness: MergeReadiness = !stale && !blocked && added.length === 0 && ci !== null && ciPassed(ci, review.headCommit) ? "可（人のレビューなしでマージ可）" : "不可（人の判断が要る）";
  const mergeReady: LabelOperation = mergeReadiness.startsWith("可") ? "付けた" : labeled ? "外した" : "付けていない";
  if (mergeReady === "付けた") recorder.label(review.issueId, "add", "merge-ready");
  else if (mergeReady === "外した") recorder.label(review.issueId, "remove", "merge-ready");
  const log = recorder.log(review.issueId, mergeReadyRecord({
    operation: mergeReady, blockers: [reason], head: review.headCommit, base: review.ci.base, ci, mergeReadiness, documentId: review.reportDocument.id, runId: review.runId,
    recheck: `CI の再照合 ${number}（現在の head ${input.currentHead}、記録 ${join(directory, "record.md")}、確認が残る事項の追加 ${added.length} 件${added.length ? `: ${added.map(check => `${check.source}（${check.reason}）`).join("、")}` : ""}）`,
  }), "test").id;
  const recordPath = join(directory, "record.md");
  writeFileSync(recordPath, [
    `# CI の再照合 ${number}（親の手順の13節）`, "",
    `- 報告 Document: ${review.reportDocument.id}（runId ${review.runId}）。報告 Document は書き換えない`,
    `- 比べた head: 報告の head ${review.headCommit}／現在の head ${input.currentHead}（${stale ? "不一致。照合しない" : "一致"}）`,
    `- 要求資料の再照合: ${requirements}`,
    ...added.map(check => `  - ${check.source}（${check.owner}）: ${check.reason}`),
    `- CI の記録: ${ci ? `${dirname(ci.recordPath)}/（result.json の sha256 ${ci.sha256}）。${ciSummary(ci)}` : "照合しない"}`,
    `- マージ可否: ${mergeReadiness}（${reason}）`,
    `- merge-ready: ${mergeReady}`,
    `- 書いた作業ログの id: ${log}`, "",
  ].join("\n"));
  return { number, reviewHead: review.headCommit, currentHead: input.currentHead, recordPath, reason, ci, remainingChecks: added, mergeReadiness, mergeReady, log };
}

/**
 * PR作業で取った CI 判定（null は照合しなかった）。ready は In Review へ移せる（初回レビューが完了で確認が残る事項が無く、再照合で増えていない）こと。
 * CI 判定は記録・報告してマージ可否と merge-ready にだけ使い、`成功` でなくても ready を止めない。
 */
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
    return { headSha: input.head, verdict, ready: review.status === "完了" && review.remainingChecks.length === 0 && recheck.remainingChecks.length === 0, recheck };
  }
  if (recorder.show(review.issueId).labels.includes("merge-ready")) recheckReviewCi(review, { currentHead: input.head }, recorder);
  const parent = dirname(review.workDirectory);
  const ci = writeCi(join(parent, `ci-${input.head.slice(0, 12)}-${readdirSync(parent).filter(name => name.startsWith(`ci-${input.head.slice(0, 12)}`)).length + 1}`), input.ci);
  recorder.log(review.issueId, `[ci-result] PR の head ${input.head} の CI 判定（初回レビューの対象版 ${review.headCommit} と違うので13節の再照合はしない）: ${ciSummary(ci)}。基点 ${ci.base}。CI の記録 ${dirname(ci.recordPath)}/（result.json の sha256 ${ci.sha256}）。修正後の head には merge-ready を付けない（新しい head のマージ可否には新しいレビューが要る）。`, "test");
  return { headSha: input.head, verdict: ci.verdict, ready: true };
}
