import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
/** 受け入れ確認担当が結果の「判定に使った証拠」の節に挙げた、親の写しの項目（records.md の項目 ID・出典・固定時の指紋と、その証拠を使った行と使い方）。 */
export type UsedEvidence = { id: string; kind: EvidenceKind; source: string; sha256: string; rows: string[]; use: AcceptancePart };
/**
 * 保存直前に親が判定に使った証拠を取り直した結果。changed は指紋が固定時と違った項目（null は取り直せなかった・削除された）。
 * appended は固定の後に足された Activity の本文で、判定に使った証拠の出典を含むものだけを対応不明にする（親は撤回かどうかを判断しない）。
 */
export type EvidenceRecheck = { changed?: Record<string, string | null>; appended?: string[] };
export type TestRunResult = "成功" | "失敗" | "実行できず";
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
  testRun: { headSha: string; result: TestRunResult; command: string };
};
/** 実装を進行する親がnodへ書く経路。偽CLIは実nod CLI、setupはcore APIを渡す。 */
export type ReviewRecorder = {
  createDocument(issueId: string, path: string, title: string, body: string): { id: number; path: string };
  log(issueId: string, body: string, kind: "progress" | "blocker"): void;
};
export type InitialReview = {
  independent: true; implementer: string; baseCommit: string; headCommit: string;
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
  testRun: { headSha: string; result: TestRunResult; recordPath: string };
  remainingChecks: RemainingCheck[];
  mergeReadiness: "可（人のレビューなしでマージ可）" | "不可（人の判断が要る）";
  standards: ReviewAxis; spec?: ReviewAxis;
};

const roles = [["standards", "Standards 探索", "code-reviewer-standards"], ["spec", "Spec 探索", "code-reviewer-spec"], ["refute", "反証", "code-reviewer-refute"], ["acceptance", "受け入れ確認", "code-reviewer-acceptance"]] as const;
const roleNames = Object.fromEntries(roles.map(([role, name]) => [role, name])) as Record<ReviewRole, string>;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** 偽workerの子nodを使い、実装者のnod操作として記録する。 */
export function nodCliRecorder(nod: (...args: string[]) => { id: number; path: string }): ReviewRecorder {
  return {
    createDocument: (issueId, path, title, body) => nod("doc", "create", path, "--title", title, "--kind", "doc", "--issue", issueId, "--body", body),
    log: (issueId, body, kind) => { nod("issue", "log", issueId, body, "--kind", kind); },
  };
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
  // 保存直前の再照合は、受け入れ確認担当が判定に使った証拠だけを取り直して固定時の指紋と比べる。
  // 判定に使った証拠を含まない通常の追記・進捗・更新日時では止めず、変化・訂正・削除・取り直せないこと・証拠の出典を含む後続の追記を確認が残る事項にする。
  const used = agents.acceptance ? input.usedEvidence ?? [] : [];
  const changed = input.recheck?.changed ?? {};
  const appended = agents.acceptance ? input.recheck?.appended ?? [] : [];
  const recheckOwner = "受け入れ確認担当（新しい実行）";
  const recheckChecks: RemainingCheck[] = [
    ...used.filter(item => item.id in changed).flatMap(item => {
      const now = changed[item.id];
      const change = item.kind === "Activity" || item.kind === "添付 Document"
        ? now === null ? "証拠の削除" : "証拠の訂正（本文の指紋の変化）"
        : now === null ? "取り直せず（失効を含む）" : item.kind === "外部の正本" ? "外部の正本の変化" : "参照された記録（配置先・成果物を含む）の変化";
      return item.rows.map(row => ({
        source: row, owner: recheckOwner,
        reason: `保存直前の再照合: ${change}（${item.id}: ${item.source}。固定時 ${item.sha256.slice(0, 12)}、保存直前 ${now?.slice(0, 12) ?? "取り直せず"}）。この実行では判定し直さない`,
      }));
    }),
    ...appended.flatMap(body => used.filter(item => body.includes(item.source)).flatMap(item => item.rows.map(row => ({
      source: row, owner: recheckOwner,
      reason: `保存直前の再照合: 対応不明（撤回の可能性。固定の後の追記「${body}」が判定に使った証拠 ${item.id} の出典を含む。親は意味を判断しない）。この実行では判定し直さない`,
    })))),
  ];
  const referencing = appended.filter(body => used.some(item => body.includes(item.source))).length;
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
  const testPassed = input.testRun.result === "成功" && input.testRun.headSha === input.headCommit;
  // 受け入れ確認担当の行は、受け入れ確認担当が確認済みとしたときだけマージ可否の判定で満たしたことにする。
  const mergeReadiness = status === "完了" && score === 5 && remainingChecks.length === 0 && testPassed
    && table.every(row => ["充足", "説明", "対象外"].includes(row.state) || (row.state === "受け入れ確認担当" && judged.some(judgedRow => judgedRow.source === row.source && judgedRow.judgment === "確認済み")))
    ? "可（人のレビューなしでマージ可）" : "不可（人の判断が要る）";
  const remainingSummary = remainingChecks.map(check => `${check.source}（${check.owner}、${check.reason}）`).join("、");
  const target = `mode: commit／merge-base の SHA ${input.baseCommit}／head の SHA ${input.headCommit}`;

  mkdirSync(join(workDirectory, "refute"), { recursive: true });
  mkdirSync(join(workDirectory, "parent", "tests"), { recursive: true });
  const recordPath = join(workDirectory, "parent", "tests", "record.md");
  writeFileSync(recordPath, [
    "# テスト実行の記録", "",
    `- checkout の SHA: ${input.testRun.headSha}`,
    `- target.md の head の SHA: ${input.headCommit}`,
    "- 作業ディレクトリの由来: 評価用の模擬記録。clone と detach checkout の手順を再現した記録で、実際の checkout とテストは実行していない",
    `- コマンド: ${input.testRun.command}`,
    `- 終了コード: ${input.testRun.result === "成功" ? 0 : input.testRun.result === "失敗" ? 1 : "なし（起動できず）"}`,
    "- skip: 出力に skip の表示なし",
    `- 判定: ${input.testRun.result}`, "",
  ].join("\n"));

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
    `- 対象版: ${target}`, "",
    "### 確認が残る事項", "",
    ...(remainingChecks.length ? ["| 要求の出典 | 確かめる担当 | 理由 |", "|---|---|---|", ...remainingChecks.map(check => `| ${check.source} | ${check.owner} | ${check.reason} |`)] : ["なし"]), "",
    "### 保存直前の受け入れ証拠の再照合", "",
    ...(agents.acceptance && status === "完了" ? [
      "- 取り直した時刻: 評価用の模擬（親が保存の直前に取り直した）",
      `- 比べた証拠: 受け入れ確認の結果の「判定に使った証拠」${used.length} 件`,
      ...(used.length ? ["", "| 項目 | 種類 | 出典 | 固定時の sha256 | 保存直前の sha256 | 結果 |", "|---|---|---|---|---|---|",
        ...used.map(item => `| ${item.id} | ${item.kind} | ${item.source} | ${item.sha256} | ${item.id in changed ? changed[item.id] ?? "取り直せず" : item.sha256} | ${item.id in changed ? "変化（確認が残る事項）" : "変化なし"} |`), ""] : []),
      `- 固定の後に足された Activity: ${appended.length} 件${!appended.length ? "" : referencing ? `（うち判定に使った証拠の出典を含む ${referencing} 件を対応不明とした。ほかは通常の追記で止めない）` : "（判定に使った証拠の出典を含まない通常の追記。止めない）"}`,
      "- この再照合は観測時点までの確認であり、将来の配置状態は保証しない。変化があっても、この実行では新しい証拠へ差し替えて判定し直さず、担当の判定本文・最終状態・点数を変えない。",
    ] : ["対象なし（受け入れ確認担当の有効な結果なし）"]), "",
    "### テスト実行による検証", "",
    `- 判定: ${input.testRun.result}`, `- checkout の SHA: ${input.testRun.headSha}（head の SHA と${input.testRun.headSha === input.headCommit ? "一致" : "不一致"}）`,
    `- コマンド: ${input.testRun.command}`, `- 出力原本への参照: ${recordPath}`, "",
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
      ? `確定した要対応の点数 ${score}、要対応 ${mustFix.length} 件、確認が残る事項 ${remainingChecks.length} 件。マージ可否は${mergeReadiness}。${mergeReadiness.startsWith("不可") ? "人の判断なしにマージへ進めない。" : ""}`
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
  recorder.log(input.issueId, status === "完了"
    ? `初回独立レビュー完了。確定した要対応の点数${score}。要対応${mustFix.map(finding => finding.id).join("、") || "なし"}。${judged.length ? `受け入れ確認: ${judged.map(row => `${row.source}=${row.judgment}`).join("、")}。` : ""}確認が残る事項${remainingChecks.length}件${remainingSummary ? `（${remainingSummary}）` : ""}。テスト実行${input.testRun.result}（checkout ${input.testRun.headSha}）。マージ可否${mergeReadiness}。報告Document ${document.id}。runId ${runId}。担当: ${assignment}。${attemptSummary}`
    : `初回独立レビュー${status}。原因: ${reason}。取得できた担当: ${assignment || "なし"}。${attemptSummary}点数なし。テスト実行${input.testRun.result}（checkout ${input.testRun.headSha}）。マージ可否${mergeReadiness}。報告Document ${document.id}。runId ${runId}。Done・In Review・PRへ進めない。`,
    status === "完了" ? "progress" : "blocker");

  return {
    independent: true, implementer: input.implementer, baseCommit: input.baseCommit, headCommit: input.headCommit,
    runId, workDirectory, status, score,
    target: { baseSha: input.baseCommit, headSha: input.headCommit },
    agents,
    attempts,
    reportDocument: { id: document.id, path: document.path },
    verdict: verdict === null ? null : { path: verdictPath, sha256: sha256(verdict) },
    acceptance: acceptanceResult === null ? null : { path: acceptancePath, sha256: sha256(acceptanceResult) },
    acceptanceRows: judged,
    testRun: { headSha: input.testRun.headSha, result: input.testRun.result, recordPath },
    remainingChecks,
    mergeReadiness,
    standards: input.standards,
    ...(input.spec ? { spec: input.spec } : {}),
  };
}
