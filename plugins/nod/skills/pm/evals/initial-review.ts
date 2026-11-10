import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ReviewRole = "standards" | "spec" | "refute";
/** 反証担当が確定した結果。impactがある指摘は要対応、ない指摘は任意として扱う。 */
export type ReviewFinding = { id: string; category: string; evidence: string; commit: string; impact?: number; acceptance?: string; suggestion?: string };
export type ReviewAxis = { findings: ReviewFinding[]; evidence: string };
export type TestRunResult = "成功" | "失敗" | "実行できず";
export type InitialReviewInput = {
  dir: string; issueId: string; implementer: string; baseCommit: string; headCommit: string;
  /** 有効な結果を受領できた担当。3担当が揃わなければ未実施になる。 */
  received?: ReviewRole[];
  standards: ReviewAxis; spec?: ReviewAxis;
  testRun: { headSha: string; result: TestRunResult; command: string };
};
/** 実装を進行する親がnodへ書く経路。偽CLIは実nod CLI、setupはcore APIを渡す。 */
export type ReviewRecorder = {
  createDocument(issueId: string, path: string, title: string, body: string): { id: number; path: string };
  log(issueId: string, body: string, kind: "progress" | "blocker"): void;
};
export type InitialReview = {
  independent: true; implementer: string; baseCommit: string; headCommit: string;
  runId: string; workDirectory: string; status: "完了" | "未実施"; score: number | null;
  target: { baseSha: string; headSha: string };
  agents: Partial<Record<ReviewRole, { definition: string; id: string }>>;
  reportDocument: { id: number; path: string };
  verdict: { path: string; sha256: string } | null;
  testRun: { headSha: string; result: TestRunResult; recordPath: string };
  mergeReadiness: "可（人のレビューなしでマージ可）" | "不可（人の判断が要る）";
  standards: ReviewAxis; spec?: ReviewAxis;
};

const roles = [["standards", "Standards 探索", "code-reviewer-standards"], ["spec", "Spec 探索", "code-reviewer-spec"], ["refute", "反証", "code-reviewer-refute"]] as const;
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
 * 点数とマージ可否は親の採点規則どおりに書くだけで、PMの受理判断は行わない。モデルやgitの実行はしない。
 */
export function recordInitialReview(input: InitialReviewInput, recorder: ReviewRecorder): InitialReview {
  const received: ReviewRole[] = input.received ?? ["standards", "spec", "refute"];
  const hex = sha256(`${input.issueId}:${input.headCommit}`);
  const runId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const shortRun = runId.slice(0, 8);
  const workDirectory = join(input.dir, "code-reviews", runId);
  const agents: Partial<Record<ReviewRole, { definition: string; id: string }>> = {};
  for (const [role, , definition] of roles) if (received.includes(role)) agents[role] = { definition, id: `review-${role}-${shortRun}` };
  const status = received.length === roles.length ? "完了" : "未実施";
  const findings = [
    ...input.standards.findings.map(finding => ({ ...finding, axis: "Standards", finder: "Standards 探索" })),
    ...(input.spec?.findings ?? []).map(finding => ({ ...finding, axis: "Spec", finder: "Spec 探索" })),
  ];
  const mustFix = findings.filter(finding => finding.impact !== undefined).sort((a, b) => (a.impact ?? 5) - (b.impact ?? 5));
  const score = status === "完了" ? mustFix[0]?.impact ?? 5 : null;
  const mergeReadiness = status === "完了" && score === 5 && input.testRun.result === "成功" && input.testRun.headSha === input.headCommit
    ? "可（人のレビューなしでマージ可）" : "不可（人の判断が要る）";
  const missing = roles.filter(([role]) => !received.includes(role)).map(([, name]) => name);
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
    `- 対象版: ${target}`, "- 受け取った入力: refute-input/ の各ファイル（manifest.md の sha256 と一致）", "- 終了状態: 完了", "",
    "## 軸ごとの完了状態", "",
    ...["Standards", "Spec"].map(axis => `- ${axis}: 完了。要対応 ${mustFix.filter(finding => finding.axis === axis).length} 件`), "",
    "## 要対応（影響度の重い順）", "",
    ...(mustFix.length ? mustFix.flatMap(finding => [
      `### ${finding.id}: ${finding.category}`, "",
      `- 候補 ID と発見者の区分: ${finding.id}（${finding.finder}）`, `- 影響度: ${finding.impact}`, `- 軸: ${finding.axis}`, "- 起点: 今回の差分",
      `- 場所と証拠: ${finding.evidence}（${finding.commit}）`, `- 期待動作: ${finding.acceptance ?? "要求どおりに動く"}`, "- 反証の判定理由: 固定版の差分と要求の原文で再現できる", "",
    ]) : ["なし", ""]),
    "## 基点から存在する課題（別枠）", "", "なし", "",
    "## 要求ごとの対応表（確定）", "",
    "| 要求の出典 | 状態 | 証拠または不足理由 | 候補ID |", "|---|---|---|---|",
    `| requirements/issue.md | ${mustFix.some(finding => finding.axis === "Spec") ? "未充足" : "充足"} | ${input.spec?.evidence ?? "Spec 探索の結果なし"} | ${mustFix.filter(finding => finding.axis === "Spec").map(finding => finding.id).join(", ") || "-"} |`, "",
    "## 未確認と理由", "", "なし", "",
    "## 判断を見送った事項", "", "なし", "",
    "## 採否一覧（監査用）", "",
    "| 候補 ID | 発見者の区分 | 判定 | 影響度 | 同一原因 | 根拠 |", "|---|---|---|---|---|---|",
    ...findings.map(finding => `| ${finding.id} | ${finding.finder} | ${finding.impact === undefined ? "任意" : "要対応"} | ${finding.impact ?? "-"} | - | ${finding.evidence} |`), "",
  ].join("\n") : null;
  if (verdict !== null) writeFileSync(verdictPath, verdict);

  const report = [
    "## 管理情報（親が記入）", "",
    `- runId: ${runId}`, `- 作業ディレクトリ: ${workDirectory}`,
    `- 最終状態: ${status === "完了" ? "完了" : `未実施（理由: ${missing.join("・")}の有効な結果を受領できず、反証を起動しなかった）`}`,
    `- 点数: ${score ?? "点数なし"}`,
    `- 点数の計算: ${status === "完了" ? `要対応 ${mustFix.length} 件（${mustFix.map(finding => `${finding.id}: ${finding.impact}`).join("、") || "なし"}）。最も重い影響度で ${score}。` : "未実施のため点数なし。"}5 点だけではマージ許可ではない。`,
    `- マージ可否: ${mergeReadiness}`,
    `- 対象版: ${target}`, "",
    "### テスト実行による検証", "",
    `- 判定: ${input.testRun.result}`, `- checkout の SHA: ${input.testRun.headSha}（head の SHA と${input.testRun.headSha === input.headCommit ? "一致" : "不一致"}）`,
    `- コマンド: ${input.testRun.command}`, `- 出力原本への参照: ${recordPath}`, "",
    "### 担当", "",
    "| 役割 | 定義名 | 担当 ID | 終了状態 |", "|---|---|---|---|",
    ...roles.map(([role, name, definition]) => `| ${name} | ${definition} | ${agents[role]?.id ?? "未取得"} | ${agents[role] ? "有効な結果を受領" : status === "未実施" && role === "refute" ? "未起動" : "有効な結果なし"} |`),
    "", `- 実装者との対応: 実装者 ${input.implementer} と各担当は別の担当。ID の違いだけで会話を引き継いでいないことの証明とは扱わない。`, "",
    "### 後続判断", "",
    status === "完了"
      ? `点数 ${score}、要対応 ${mustFix.length} 件。マージ可否は${mergeReadiness}。`
      : "独立レビュー未実施。自動の再委譲はせず、Done・In Review・PR へ進めない。マージ可否は不可（人の判断が要る）。", "",
    "### 独立性の限界", "",
    "探索と反証は別コンテキストで実行し、探索には異なるモデルを設定するが、見落としが共通する可能性は残り、設定だけで各実行の実効モデルの違いを証明するものではない。", "",
    "## 反証担当の判定本文（原文のまま）", "",
    `- 原本: ${verdict === null ? "未受領" : verdictPath}`, `- sha256: ${verdict === null ? "なし" : sha256(verdict)}`, `- 担当 ID: ${agents.refute?.id ?? "未取得"}`, "",
    "<!-- refute-verdict:begin -->",
    verdict ?? `未受領（${missing.join("・")}の有効な結果を受領できず、反証を起動しなかった）\n`,
  ].join("\n") + "<!-- refute-verdict:end -->\n";
  writeFileSync(join(workDirectory, "parent", "report.md"), report);

  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const document = recorder.createDocument(input.issueId, `${input.issueId.toLowerCase()}-code-review-${date}-${shortRun}.md`, `${input.issueId} コードレビュー結果（${shortRun}）`, report);
  const assignment = roles.filter(([role]) => agents[role]).map(([role, name, definition]) => `${name}=${definition}/${agents[role]?.id}`).join("、");
  recorder.log(input.issueId, status === "完了"
    ? `初回独立レビュー完了。点数${score}。要対応${mustFix.map(finding => finding.id).join("、") || "なし"}。テスト実行${input.testRun.result}（checkout ${input.testRun.headSha}）。マージ可否${mergeReadiness}。報告Document ${document.id}。runId ${runId}。担当: ${assignment}。`
    : `独立レビュー未実施。原因: ${missing.join("・")}の有効な結果を受領できず、反証を起動しなかった。取得できた担当: ${assignment || "なし"}。テスト実行${input.testRun.result}（checkout ${input.testRun.headSha}）。マージ可否${mergeReadiness}。報告Document ${document.id}。runId ${runId}。自動の再委譲なし。Done・In Review・PRへ進めない。`,
    status === "完了" ? "progress" : "blocker");

  return {
    independent: true, implementer: input.implementer, baseCommit: input.baseCommit, headCommit: input.headCommit,
    runId, workDirectory, status, score,
    target: { baseSha: input.baseCommit, headSha: input.headCommit },
    agents,
    reportDocument: { id: document.id, path: document.path },
    verdict: verdict === null ? null : { path: verdictPath, sha256: sha256(verdict) },
    testRun: { headSha: input.testRun.headSha, result: input.testRun.result, recordPath },
    mergeReadiness,
    standards: input.standards,
    ...(input.spec ? { spec: input.spec } : {}),
  };
}
