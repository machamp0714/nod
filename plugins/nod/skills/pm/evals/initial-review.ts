import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Gh, type RequiredChecks, readRequiredChecks } from "./required-checks";

export type ReviewRole = "standards" | "spec" | "refute";
/** 反証担当が確定した結果。impactがある指摘は要対応、ない指摘は任意として扱う。 */
export type ReviewFinding = { id: string; category: string; evidence: string; commit: string; impact?: number; acceptance?: string; suggestion?: string };
export type ReviewAxis = { findings: ReviewFinding[]; evidence: string };
/** 確認が残る事項。最終状態と点数を変えず、マージ可否だけを止める。 */
export type RemainingCheck = { source: string; owner: string; reason: string };
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
  /** 担当を1つも起動しなかった理由（委譲できない環境・差分なし・限定 clone を作れない）。指定すると未実施になる。 */
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
  /** 10節の8・11節で、head を固定した元（PR）から取り直した対象の現在の head。省略すると固定した head と同じ（追加コミットなし）。違えばマージ可否は不可。 */
  currentHead?: string;
  /** 10節の8・11節で、PR から取り直した現在の基点（`baseRefName`）。省略するとレビューした基点と同じ。違えばマージ可否は不可（基点が変わった）。 */
  currentBase?: string;
};
/** 実装を進行する親がnodへ書く経路。偽CLIは実nod CLI（--json）、setupはcore APIを渡す。log は書いた記録の id を返す。 */
export type ReviewRecorder = {
  createDocument(issueId: string, path: string, title: string, body: string): { id: number; path: string };
  log(issueId: string, body: string, kind: "progress" | "blocker"): { id: number };
  show(issueId: string): { title: string; description: string | null; labels: string[] };
  label(issueId: string, action: "add" | "remove", label: string): void;
};
export type InitialReview = {
  independent: true; issueId: string; implementer: string; baseCommit: string; headCommit: string;
  runId: string; workDirectory: string; status: "完了" | "未完了" | "未実施"; score: number | null;
  target: { baseSha: string; headSha: string };
  /** レビューした基点（基点の指定を GitHub のブランチ名に解決したもの）。 */
  reviewedBase: string;
  agents: Partial<Record<ReviewRole, { definition: string; id: string }>>;
  /** 起動した役割ごとの試行（最初の試行と、親による1回限りの再委譲）。 */
  attempts: ReviewAttempt[];
  reportDocument: { id: number; path: string };
  auditDocument: { id: number; path: string };
  verdict: { path: string; sha256: string } | null;
  remainingChecks: RemainingCheck[];
  mergeReadiness: MergeReadiness;
  /** 報告の保存と作業ログの後に行った merge-ready の操作と、それを記録した [merge-ready] で始まる --kind progress の作業ログの id。 */
  mergeReady: LabelOperation;
  mergeReadyLog: number;
  standards: ReviewAxis; spec?: ReviewAxis;
};
/** PR作業の結果。ready は既存の提出条件で In Review へ移せること。 */
export type Submission = { headSha: string; ready: boolean; requiredChecks: RequiredChecks };

const roles = [["standards", "Standards 探索", "code-reviewer-standards"], ["spec", "Spec 探索", "code-reviewer-spec"], ["refute", "反証", "code-reviewer-refute"]] as const;
const roleNames = Object.fromEntries(roles.map(([role, name]) => [role, name])) as Record<ReviewRole, string>;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const MERGE_OK: MergeReadiness = "可（人のレビューなしでマージ可）";
const MERGE_NG: MergeReadiness = "不可（人の判断が要る）";
const MERGE_READY_LOG = "[merge-ready]";
/** 評価用の模擬の基点の指定。ブランチ名なので、そのままレビューした基点になる。 */
const BASE_SPEC = "main";

/** 偽workerの子nodを使い、実装者のnod操作として記録する。nod は --json を付けて返った JSON を返す。 */
export function nodCliRecorder(nod: (...args: string[]) => any): ReviewRecorder {
  return {
    createDocument: (issueId, path, title, body) => nod("doc", "create", path, "--title", title, "--kind", "doc", "--issue", issueId, "--body", body),
    log: (issueId, body, kind) => nod("issue", "log", issueId, body, "--kind", kind),
    show: issueId => nod("issue", "show", issueId),
    label: (issueId, action, label) => { nod("issue", "update", issueId, action === "add" ? "--add-label" : "--remove-label", label); },
  };
}

/** 2.3節の要求の写し（評価用の模擬では Issue のタイトルと本文だけ）。10節の2は固定時の `input/requirements/issue.md` と比べる。 */
const issueRequirement = (issue: { title: string; description: string | null }) => `# ${issue.title}\n\n${issue.description ?? ""}\n`;
const scopeNote = "このレビューはコードレベルの確認であり、ブラウザ検証・見た目やデザイン・実環境での動作・作業手順は確かめておらず、別のフローで扱う。";
/** 共通規則の影響度から機械的に表示する Severity（0・1=Critical、2=High、3=Medium、4=Low）。 */
const SEVERITY = ["Critical", "Critical", "High", "Medium", "Low"];

/**
 * nod:implementの親が残す初回独立レビューの成果（作業ディレクトリ、報告Document、作業ログ）を再現する。
 * 最終状態・点数・確認が残る事項・マージ可否は親の規則（review.ts finalize）どおりに書くだけで、PMの受理判断は行わない。モデルやgitの実行はしない。
 * マージ可否は最終状態・確定した要対応・確認が残る事項・現在の head と基点の照合だけで決め、CI の結果は照合しない。
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
  const statusLine = status === "完了" ? status : `${status}（理由: ${reason}）`;
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
  // 2.3節の要求の写し。10節の2（保存直前）はこれと比べる。
  const requirement = issueRequirement(recorder.show(input.issueId));
  mkdirSync(join(workDirectory, "input", "requirements"), { recursive: true });
  writeFileSync(join(workDirectory, "input", "requirements", "issue.md"), requirement);
  const specMustFix = mustFix.filter(finding => finding.axis === "Spec");
  // Spec 探索の対応表。要求の出典は行範囲で書く。
  const table = [
    { source: `requirements/issue.md:L1-L${requirement.split("\n").length - 1}`, state: specMustFix.length ? "未充足" : "充足", evidence: input.spec?.evidence ?? "Spec 探索の結果なし", candidates: specMustFix.map(finding => finding.id).join(", ") || "-" },
    ...unconfirmed.map(check => ({ source: check.source, state: "未確認", evidence: `${check.reason}（確かめる担当: ${check.owner}）`, candidates: "-" })),
  ];
  // 反証は充足の行を確かめ直さず、未充足・未確認の行だけを確定して判定本文に書く（評価用の模擬では Spec 探索の状態のまま確定する）。
  const refuted = table.filter(row => row.state !== "充足");
  // 10節の8: head を固定した元（PR の headRefOid と baseRefName）から対象の現在の head と基点を取り直し、固定した head とレビューした基点と比べる（未実施では照合しない）。
  const reviewedBase = BASE_SPEC;
  const head = status === "未実施" ? null : (() => {
    const currentHead = input.currentHead ?? input.headCommit;
    const currentBase = input.currentBase ?? reviewedBase;
    const headOk = currentHead === input.headCommit;
    const baseOk = currentBase === reviewedBase;
    const problems = [
      ...headOk ? [] : [`対象版が現在の head と違う（追加コミット。現在の head ${currentHead}）`],
      ...baseOk ? [] : [`基点が変わった（レビューした基点 ${reviewedBase}、現在の基点 ${currentBase}）`],
    ];
    return { at: new Date().toISOString(), command: "評価用の模擬（PR の headRefOid と baseRefName）", currentHead, currentBase, headOk, baseOk, problems };
  })();
  // 対応表の「未充足」と要対応、「未確認」と確認が残る事項の対応は反証の形式の検査で担保するので、マージ可否の判定では対応表の行を別に数えない。
  const blockers = [
    ...status === "完了" ? [] : [`最終状態 ${statusLine}`],
    ...score === 5 ? [] : [score === null ? "点数なし" : `確定した要対応の点数 ${score}`],
    ...remainingChecks.length ? [`確認が残る事項 ${remainingChecks.length} 件`] : [],
    ...head?.problems ?? [],
  ];
  const mergeReadiness = blockers.length === 0 ? MERGE_OK : MERGE_NG;
  if (head) {
    // 可なら11節で付ける直前にも取り直す（評価用の模擬では同じ値）。
    const section = (label: string) => [
      `## ${label}（${head.at}）`, "",
      `- コマンド: \`${head.command}\``,
      `- 固定した head: \`${input.headCommit}\``,
      `- 現在の head: \`${head.currentHead}\`（${head.headOk ? "一致" : "不一致"}）`,
      `- レビューした基点: ${reviewedBase}`,
      `- 現在の基点: ${head.currentBase}（${head.baseOk ? "一致" : "不一致"}）`,
      `- 結果: ${head.problems.join("・") || "一致"}`, "",
    ];
    mkdirSync(join(workDirectory, "parent"), { recursive: true });
    writeFileSync(join(workDirectory, "parent", "head-check.md"), [
      "# 現在の head と基点の照合", "",
      "head を固定した元（parent/head-source.md）から取り直した現在の head と基点を、固定した head とレビューした基点（基点の指定をブランチ名に解決したもの）と比べた記録。", "",
      ...section("マージ可否を決める直前"),
      ...mergeReadiness === MERGE_OK ? section("merge-ready を付ける直前") : [],
    ].join("\n"));
  }
  // ラベルは報告の保存と作業ログの後に操作するが、報告には行う予定を書く。
  const labeled = recorder.show(input.issueId).labels.includes("merge-ready");
  const mergeReady: LabelOperation = mergeReadiness === MERGE_OK ? "付けた" : labeled ? "外した" : "付けていない";
  const labelPlan = mergeReadiness === MERGE_OK ? "付ける予定（付ける直前に現在の head と基点を取り直す）" : labeled ? "外す予定" : "付けない";
  const target = `mode: commit／merge-base の SHA ${input.baseCommit}／head の SHA ${input.headCommit}`;

  mkdirSync(join(workDirectory, "refute"), { recursive: true });
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
    "## コード要求の対応表（反証で確定した行）", "",
    "| 要求の出典 | 状態 | 証拠または不足理由 | 候補ID |", "|---|---|---|---|",
    ...refuted.map(row => `| ${row.source} | ${row.state} | ${row.evidence} | ${row.candidates} |`), "",
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

  const headLine = head
    ? `- 現在の head と基点の照合: 現在の head ${head.currentHead}（${head.headOk ? "固定した head と一致" : "不一致。対象版が現在の head と違う（追加コミット）"}）、現在の基点 ${head.currentBase}（${head.baseOk ? `レビューした基点 ${reviewedBase} と一致` : `レビューした基点 ${reviewedBase} と不一致。基点が変わった`}）。取得: \`${head.command}\`（${head.at}）。記録: \`${join(workDirectory, "parent", "head-check.md")}\``
    : "- 現在の head と基点の照合: 照合せず（未実施）";
  const cell = (text: string) => text.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
  const audit = [
    "## 管理情報（親が記入）", "",
    `- runId: ${runId}`, `- 作業ディレクトリ: ${workDirectory}`,
    `- 最終状態: ${statusLine}`,
    `- 確定した要対応の点数: ${score ?? "点数なし"}`,
    `- 点数の計算: ${status === "完了" ? `要対応 ${mustFix.length} 件（${mustFix.map(finding => `${finding.id}: ${finding.impact}`).join("、") || "なし"}）。最も重い影響度で ${score}。` : `${status}のため点数なし。`}点数は確定した要対応の影響度だけを表し、要求の確認率やマージ許可を表さない。`,
    `- 確認が残る事項: ${remainingChecks.length} 件（下の「確認が残る事項」の節）。最終状態と点数を変えず、マージ可否だけを止める。`,
    `- マージ可否: ${mergeReadiness}`,
    ...(blockers.length ? [`  - 不可の理由: ${blockers.join("／")}`] : []),
    "  - 可は、最終状態が完了・確定した要対応0件（点数 5）・確認が残る事項0件・現在の head と基点がレビューした版と同じ（次の照合）のときだけ。mode: local は対象外で常に不可。CI の結果は見ない（CI が落ちた PR のマージを止めるのは GitHub の必須ステータスチェック）。",
    "  - 「完了・確定した要対応の点数 5・確認が残る事項あり・マージ不可」は正常な結果である。可でもリポジトリの既存のマージ条件（ブランチ保護・必須のレビューなど）は省かない。",
    headLine,
    `- merge-ready: ${labelPlan}。報告の保存と作業ログの直後に行う操作として書く。ラベルは現在の判定の表示で、自動マージの指示ではない。操作の結果は、判定した head SHA・現在の head と基点の照合・レビューした基点・マージ可否・この報告の Document ID・runId とともに、本文が ${MERGE_READY_LOG} で始まる --kind progress の作業ログに記録する`,
    `- 対象版: 基点の指定 \`${BASE_SPEC}\`／merge-base \`${input.baseCommit}\`／head \`${input.headCommit}\`／mode commit`, "",
    "### 確認が残る事項", "",
    ...(remainingChecks.length ? ["| 要求の出典 | 確かめる担当 | 理由 |", "|---|---|---|", ...remainingChecks.map(check => `| ${check.source} | ${check.owner} | ${check.reason} |`)] : ["なし"]), "",
    "### 保存時の要求変化の確認", "",
    `- requirements/issue.md: 固定時と保存直前の sha256 ${sha256(requirement)} が一致（変化なし。評価用の模擬）`, "",
    "### コード要求の対応表（確定）", "",
    `Spec 探索の対応表に、反証が判定本文に書いた行（Spec 探索の未充足・未確認の行の確定した状態と、充足から未充足に変えた行）を重ねた表（記録: \`${join(workDirectory, "parent", "refute-structure.json")}\`）。確定した担当が「Spec 探索」の行は、反証が確かめ直さず Spec 探索の判定をそのまま使った充足の行。Spec 探索の担当はその行を書いた Spec 探索の担当。`, "",
    ...(verdict === null ? ["なし（反証の有効な結果なし）"] : [
      "要求資料ごとのコード要求（Spec 探索の引き渡し）: `requirements/issue.md` あり", "",
      "| 要求の出典 | 状態 | 確定した担当 | Spec 探索の担当 | Spec 探索の状態 | 証拠または不足理由 | 候補ID |", "|---|---|---|---|---|---|---|",
      ...table.map(row => `| ${cell(row.source)} | ${row.state} | ${refuted.includes(row) ? "反証" : "Spec 探索"} | spec | ${row.state} | ${cell(row.evidence)} | ${row.candidates === "-" ? "なし" : cell(row.candidates)} |`),
    ]), "",
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
      ? `確定した要対応の点数 ${score}、要対応 ${mustFix.length} 件、確認が残る事項 ${remainingChecks.length} 件。${remainingChecks.length ? "完了でも確認が残る事項は、提出・完了に必要な確認の不足として既存の提出・完了条件へ委ねる。" : ""}`
      : `独立レビュー${status}（${reason}）。試行の記録と受領済みの成果は上の担当と試行の記録の節。Done・In Review・PR へ進めない（委譲し直しや利用枠の回復待ちで代替しない）。`, "",
    `マージ可否は${mergeReadiness}。${mergeReadiness === MERGE_OK ? "" : "人の判断なしにマージへ進めない。"}`, "",
    "### 独立性の限界", "",
    "探索と反証は別コンテキストで実行し、探索には異なるモデルを設定するが、見落としが共通する可能性は残り、設定だけで各実行の実効モデルの違いを証明するものではない。", "",
    "## 反証担当の判定本文（原文のまま）", "",
    `- 原本: ${verdict === null ? "未受領" : verdictPath}`, `- sha256: ${verdict === null ? "なし" : sha256(verdict)}`, `- 担当 ID: ${agents.refute?.id ?? "未取得"}`, "",
    "<!-- refute-verdict:begin -->",
    `${verdict ?? `未受領（${reason}）\n`}<!-- refute-verdict:end -->`, "",
  ].join("\n");
  mkdirSync(join(workDirectory, "parent"), { recursive: true });
  writeFileSync(join(workDirectory, "parent", "audit.md"), audit);

  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const auditDocument = recorder.createDocument(input.issueId, `${input.issueId.toLowerCase()}-code-review-audit-${date}-${shortRun}.md`, `${input.issueId} コードレビュー監査（${shortRun}）`, audit);
  const report = [
    "## 結果", "",
    `- 最終状態: ${statusLine}`,
    `- 確定した要対応の点数: ${score ?? "点数なし"}`,
    `- 確認が残る事項: ${remainingChecks.length} 件`,
    `- 対象: ${input.headCommit}（基点 ${BASE_SPEC}、merge-base ${input.baseCommit}、mode commit）`,
    `- 範囲: ${scopeNote}`,
    `- マージ可否: ${mergeReadiness}`,
    ...(blockers.length ? [`- 理由: ${blockers.join("／")}`] : []),
    `- merge-ready: ${labelPlan}。実際の操作結果は保存後の ${MERGE_READY_LOG} で始まる作業ログを参照`, "",
    "## 要対応", "",
    ...(mustFix.length ? [
      "| ID | Severity（影響度） | 問題 | 場所・影響の根拠 |",
      "|---|---|---|---|",
      ...mustFix.map(finding => `| ${cell(finding.id)} | ${SEVERITY[finding.impact!]}（${finding.impact}） | ${cell(finding.category)} | ${cell(finding.evidence)} |`),
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
  // 11節の要約の作業ログ（完了は progress、未実施・未完了は blocker）。マージ可否・merge-ready は書かず [merge-ready] の記録を参照する。
  const assignment = attempts.map(attempt => `${roleNames[attempt.role]}=${roles.find(([role]) => role === attempt.role)![2]}/${attempt.id}（試行 ${attempt.attempt}${attempt.result === "有効" ? "" : "、無効"}）`).join("、") || "なし";
  const invalidAttempts = attempts.filter(attempt => attempt.result !== "有効");
  const attemptSummary = invalidAttempts.length
    ? `無効な試行: ${invalidAttempts.map(attempt => `${roleNames[attempt.role]}の試行 ${attempt.attempt} ${attempt.id}（${attempt.result}: ${attempt.reason}。親による再委譲${attempt.redelegation}）`).join("、")}。`
    : "";
  const documents = `結果Document ${document.id}、監査Document ${auditDocument.id}`;
  const mergeNote = `マージ可否・merge-ready は ${MERGE_READY_LOG} で始まる作業ログを参照`;
  recorder.log(input.issueId, status === "完了"
    ? `独立コードレビュー完了。確定した要対応の点数 ${score}。${mustFix.length ? `要対応: ${mustFix.map(finding => `${finding.id}（${SEVERITY[finding.impact!]}、影響度 ${finding.impact}: ${finding.category}）`).join("、")}。` : "要対応: なし。"}確認が残る事項 ${remainingChecks.length} 件${remainingChecks.length ? `（${remainingChecks.map(check => `${check.source}（${check.owner}、${check.reason}）`).join("、")}）` : ""}。${documents}。runId ${runId}。担当: ${assignment}。${attemptSummary}${mergeNote}。`
    : `独立コードレビュー${status}。原因: ${reason}。試行: ${assignment}。${attemptSummary}受領済みの成果: ${attempts.filter(attempt => attempt.result === "有効").map(attempt => `${roleNames[attempt.role]}の試行 ${attempt.attempt}`).join("、") || "なし"}。点数なし。${documents}。runId ${runId}。Done・In Review・PR へ進めない。${mergeNote}。`,
    status === "完了" ? "progress" : "blocker");
  // 11節: 報告の保存と作業ログの後に merge-ready を付ける・外し、操作と根拠を本文 [merge-ready] で始まる --kind progress に1件残す。
  if (mergeReady === "付けた") recorder.label(input.issueId, "add", "merge-ready");
  else if (mergeReady === "外した") recorder.label(input.issueId, "remove", "merge-ready");
  const mergeReadyLog = recorder.log(input.issueId, [
    `${MERGE_READY_LOG} merge-ready: ${mergeReady}${blockers.length ? `（マージ可否が不可: ${blockers.join("、")}）` : ""}。`,
    `判定した head SHA ${input.headCommit}${head ? `、現在の head ${head.currentHead}（${head.headOk ? "一致" : "不一致"}）` : "、現在の head と基点は照合せず"}、`,
    `レビューした基点 ${reviewedBase}（基点の指定 ${BASE_SPEC}、merge-base ${input.baseCommit}）`,
    head ? `、現在の基点 ${head.currentBase}（${head.baseOk ? "一致" : "不一致"}）、` : "、",
    `マージ可否 ${mergeReadiness}、`,
    `報告Document ${document.id}、runId ${runId}。`,
    "ラベルは現在の判定の表示で、自動マージの指示ではない。",
  ].join(""), "progress").id;

  return {
    independent: true, issueId: input.issueId, implementer: input.implementer, baseCommit: input.baseCommit, headCommit: input.headCommit,
    runId, workDirectory, status, score,
    target: { baseSha: input.baseCommit, headSha: input.headCommit },
    reviewedBase,
    agents,
    attempts,
    reportDocument: { id: document.id, path: document.path },
    auditDocument: { id: auditDocument.id, path: auditDocument.path },
    verdict: verdict === null ? null : { path: verdictPath, sha256: sha256(verdict) },
    remainingChecks,
    mergeReadiness,
    mergeReady, mergeReadyLog,
    standards: input.standards,
    ...(input.spec ? { spec: input.spec } : {}),
  };
}

/**
 * 追加コミット・指摘対応の再開・PR作業の提出で、merge-ready が付いていれば、判定した head とレビューした基点を現在の head と基点に比べ、
 * 違えば外して、理由（判定が古い（追加コミット）・基点が変わった）・判定した head SHA・現在の head・レビューした基点・現在の基点を、本文を [merge-ready] で始めて --kind progress に1件残す。
 * 付いていない、または head と基点が同じなら何もしない。新しい head・基点のマージ可否は新しいレビューでだけ決まるので、付け直さない。
 */
export function dropStaleMergeReady(review: InitialReview, current: { head: string; base?: string }, recorder: ReviewRecorder) {
  const base = current.base ?? review.reviewedBase;
  const headOk = current.head === review.headCommit;
  const baseOk = base === review.reviewedBase;
  if ((headOk && baseOk) || !recorder.show(review.issueId).labels.includes("merge-ready")) return;
  const reasons = [
    ...headOk ? [] : [`判定が古い（追加コミット。判定した head ${review.headCommit}、現在の head ${current.head}）`],
    ...baseOk ? [] : [`基点が変わった（レビューした基点 ${review.reviewedBase}、現在の基点 ${base}）`],
  ];
  recorder.label(review.issueId, "remove", "merge-ready");
  recorder.log(review.issueId, [
    `${MERGE_READY_LOG} merge-ready: 外した（${reasons.join("・")}。新しい${headOk ? "基点" : baseOk ? " head " : " head と基点"}のマージ可否は新しいレビューでだけ決まる）。`,
    `判定した head SHA ${review.headCommit}、現在の head ${current.head}（${headOk ? "一致" : "不一致"}）、`,
    `レビューした基点 ${review.reviewedBase}、現在の基点 ${base}（${baseOk ? "一致" : "不一致"}）、`,
    `報告Document ${review.reportDocument.id}、runId ${review.runId}。`,
    "ラベルは現在の判定の表示で、自動マージの指示ではない。",
  ].join(""), "progress");
}

/**
 * PR作業（push・PR作成・nodへの提出）の終了時に実装担当が行うことを再現する。CI の結果は待たず、照合も記録もしない。
 * merge-ready が付いていれば、PR の head と基点（headRefOid・baseRefName）を初回レビューの判定した head とレビューした基点に比べ、違えば外して [merge-ready] に記録する。
 * 基点ブランチの必須チェックの設定を偽GitHubから gh で読み、設定あり・未設定・確認できないのどれかを報告に書く。報告事項で、提出の条件にも merge-ready にも使わない。
 * ready は既存の提出条件: 修正なしなら初回レビューが完了で確認が残る事項が無いこと、修正ありなら独立確認を経ていること（PMが確かめる）。
 */
export function recordSubmission(review: InitialReview, input: { head: string; base: string }, recorder: ReviewRecorder, gh: Gh): Submission {
  const repaired = input.head !== review.headCommit;
  dropStaleMergeReady(review, input, recorder);
  return { headSha: input.head, ready: repaired || (review.status === "完了" && review.remainingChecks.length === 0), requiredChecks: readRequiredChecks(input.base, gh) };
}
