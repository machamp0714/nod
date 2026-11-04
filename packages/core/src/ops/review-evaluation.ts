import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runReview, type RunReviewInput } from "./review-run";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const json = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const check = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
interface Oracle { layer?: "review" | "automatic_check" | "unresolved"; layerEvidence?: string; checkConfiguration?: string; id: string; kind: "positive" | "negative"; major: boolean; cause: string; impact: string; evidence: string }
interface EvaluationCase {
  id: string; repoKey: string; pr: number; provenance: string[]; requirementEvidence: string;
  unavailableReason: string | null;
  input: { repo: string; base: string; head: string; document: string } | null;
  documentContent?: string; documentHash?: string;
  oracle: Oracle[];
}
interface Dataset { version: 1 | 2; reviewPolicy?: "independent-v1"; purpose: "development"; selection: string; frozenAt: string; cases: EvaluationCase[] }
function save(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
function load(path: string): { hash: string; data: Dataset } {
  const frozen = json(path);
  check(frozen.hash === hash(JSON.stringify(frozen.data)), "凍結した評価集合のhashが一致しません");
  return frozen;
}
export function freezeReviewEvaluation(manifest: string, out: string) {
  const data = json(manifest) as Dataset;
  check([1, 2].includes(data.version) && data.purpose === "development" && text(data.selection) && Array.isArray(data.cases) && data.cases.length, "開発用評価集合・選定規則・事例が必要です");
  if (data.version === 2) check(data.reviewPolicy === "independent-v1", "新版の評価には独立レビュー方針が必要です");
  const ids = new Set<string>();
  for (const c of data.cases) {
    check(text(c.id) && !ids.has(c.id) && text(c.repoKey) && Number.isInteger(c.pr) && c.pr > 0, "事例ID・repo・PRが不正または重複しています"); ids.add(c.id);
    check(Array.isArray(c.provenance) && c.provenance.length && c.provenance.every(text) && text(c.requirementEvidence), "対象版と当時要求の出典が必要です");
    check(Array.isArray(c.oracle) && c.oracle.length, "正例/負例の根拠が必要です");
    const causes = new Set<string>();
    for (const o of c.oracle) {
      check(text(o.id) && !causes.has(o.id) && ["positive", "negative"].includes(o.kind) && typeof o.major === "boolean" && text(o.cause) && text(o.impact) && text(o.evidence), "正解の原因・影響・重大性・証拠が不正です"); causes.add(o.id);
    }
    if (data.version === 2) for (const o of c.oracle) check(["review", "automatic_check", "unresolved"].includes(String(o.layer)) && text(o.layerEvidence) && text(o.checkConfiguration), "新版の正例/負例には担当・分類根拠・固定検査設定が必要です");
    if (c.unavailableReason !== null) { check(text(c.unavailableReason), "評価不能の理由が必要です"); continue; }
    check(c.input && text(c.input.repo) && /^[a-f0-9]{40}$/.test(c.input.base) && /^[a-f0-9]{40}$/.test(c.input.head) && text(c.input.document), "入力は固定した40桁commitと当時要求文書を指定してください");
    c.input!.repo = resolve(c.input!.repo); c.input!.document = resolve(c.input!.document);
    c.documentContent = readFileSync(c.input!.document, "utf8");
    check(text(c.documentContent), "当時要求文書が空です");
    c.documentHash = hash(c.documentContent);
  }
  data.frozenAt = new Date().toISOString();
  const digest = hash(JSON.stringify(data)); save(out, { hash: digest, data });
  return { status: "frozen", hash: digest, path: resolve(out), cases: data.cases.length, purpose: data.purpose };
}

interface ReplayOptions { dataset: string; case: string; outputDir: string; provider: RunReviewInput["provider"]; reviewModel: string; reviewEffort?: string; implementationModels: string; extraUsageDisabled?: boolean; timeoutSeconds?: string; scopePlan?: string; responsibilityPlan?: string }
export async function replayReviewEvaluation(db: Database, opts: ReplayOptions) {
  const frozen = load(opts.dataset), c = frozen.data.cases.find(c => c.id === opts.case);
  check(c, "指定した凍結事例がありません");
  const attemptId = randomUUID(), startedAt = new Date().toISOString();
  const directory = join(opts.outputDir, "evaluation", attemptId); mkdirSync(directory, { recursive: true });
  const recordPath = join(directory, "evaluation-run.json");
  // 実行前に台帳へ記録し、途中停止を後の成功で置き換えない。
  appendFileSync(resolve(opts.dataset) + ".runs.jsonl", JSON.stringify({ datasetHash: frozen.hash, caseId: c!.id, attemptId, startedAt, recordPath }) + "\n", { mode: 0o600 });
  let initial: unknown = null, reason = c!.unavailableReason;
  if (!reason) {
    const input = c!.input!;
    const document = join(directory, "requirements.md");
    check(hash(c!.documentContent!) === c!.documentHash, "凍結した要求文書のhashが一致しません");
    writeFileSync(document, c!.documentContent!, { flag: "wx", mode: 0o444 });
    // 正解・比較結果・人の判定は渡さない。修正オプションも受け取らない。
    const result = await runReview(db, { repo: input.repo, base: input.base, head: input.head, document,
      outputDir: directory, provider: opts.provider, reviewModel: opts.reviewModel, reviewEffort: opts.reviewEffort, implementationModels: opts.implementationModels,
      extraUsageDisabled: opts.extraUsageDisabled, timeoutSeconds: opts.timeoutSeconds, scopePlan: opts.scopePlan, responsibilityPlan: opts.responsibilityPlan });
    check(result.initialReviewPath, "初回レビュー記録がありません");
    initial = json(result.initialReviewPath!);
  }
  const data = { version: 1, datasetHash: frozen.hash, caseId: c!.id, attemptId, startedAt, initial, unavailableReason: reason };
  save(recordPath, { hash: hash(JSON.stringify(data)), data });
  const result = initial as any;
  return { status: "recorded", recordPath, attemptId, caseId: c!.id, reviewStatus: result?.status ?? "not_run", score: result?.score ?? null };
}

interface Judgment { caseId: string; attemptId: string; complete: boolean; triageMinutes: number | null; triageEvidence?: string;
  findings: { finding: string; causeId: string; verdict: "valid" | "invalid" | "pending"; evidence: string; knownCause?: string }[] }
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i]! : (sorted[i - 1]! + sorted[i]!) / 2;
}
export function reportReviewEvaluation(dataset: string, judgmentsPath?: string) {
  const frozen = load(dataset);
  const ledger = resolve(dataset) + ".runs.jsonl";
  const attempts: any[] = existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s)) : [];
  const judgments: Judgment[] = judgmentsPath ? json(judgmentsPath) : [];
  check(Array.isArray(judgments), "人の判定はJSON配列で指定してください");
  const judgmentKeys = new Set<string>();
  for (const j of judgments) {
    const key = `${j.caseId}:${j.attemptId}`;
    check(!judgmentKeys.has(key) && typeof j.complete === "boolean" && Array.isArray(j.findings), "重複または不正な人の判定です"); judgmentKeys.add(key);
    check(j.triageMinutes === null || (Number.isFinite(j.triageMinutes) && j.triageMinutes >= 0 && text(j.triageEvidence)), "選別時間は根拠付きの0以上の分数、未記録はnullです");
    const ids = new Set<string>();
    for (const finding of j.findings) {
      check(text(finding.finding) && !ids.has(finding.finding) && text(finding.causeId) && ["valid", "invalid", "pending"].includes(finding.verdict) && text(finding.evidence), "指摘の人判定・原因ID・根拠が不正です"); ids.add(finding.finding);
    }
  }
  const rows = frozen.data.cases.map(c => {
    const runs = attempts.filter(a => a.caseId === c.id && a.datasetHash === frozen.hash);
    const first = runs[0];
    let initial: any = null, unavailableReason = c.unavailableReason;
    if (first && existsSync(first.recordPath)) {
      const record = json(first.recordPath);
      check(record.hash === hash(JSON.stringify(record.data)) && record.data.datasetHash === frozen.hash && record.data.caseId === c.id && record.data.attemptId === first.attemptId, "初回再生記録のhashまたは対象が一致しません");
      initial = record.data.initial; unavailableReason = record.data.unavailableReason;
      if (initial && !initial.target && initial.status === "incomplete") unavailableReason = initial.problems.map((p: any) => `${p.code}: ${p.message}`).join("; ") || "対象の準備に失敗";
      if (initial && frozen.data.version === 2) check(initial.reviewPolicy === frozen.data.reviewPolicy, "旧方式のレビュー結果を新方式の集合へ混在させられません");
      if (initial?.target) {
        check(!initial.repair && !initial.autoRepair && initial.target?.mode === "commit" && initial.target.headSha === c.input?.head && initial.target.mergeBaseSha === c.input?.base, "修正後または凍結対象と異なるレビューは集計できません");
      }
    }
    const j = first ? judgments.find(j => j.caseId === c.id && j.attemptId === first.attemptId) : undefined;
    const findings: any[] = initial?.findings ?? [];
    for (const decision of j?.findings ?? []) {
      check(findings.some(f => `${f.axis}:${f.id}` === decision.finding), "人判定が初回にない指摘を参照しています");
      check(!decision.knownCause || c.oracle.some(o => o.id === decision.knownCause), "人判定が未知の正解IDを参照しています");
    }
    const judged = findings.map(f => {
      const human = j?.findings.find(d => d.finding === `${f.axis}:${f.id}`);
      const oracle = c.oracle.find(o => o.id === human?.knownCause);
      // 担当外の最終指摘を分母から消さず、範囲違反として扱う。
      return { ...f, human: human && frozen.data.version === 2 && oracle?.layer === "automatic_check" ? { ...human, verdict: "invalid" } : human && frozen.data.version === 2 && oracle?.layer === "unresolved" ? { ...human, verdict: "pending" } : human };
    });
    // 軸をまたぐモデルの同一原因と、人が確認した同一原因の双方を統合する。
    const groups: any[][] = [];
    for (const f of judged.filter(f => f.decision === "required")) {
      const matches = groups.filter(group => group.some(other => (text(f.rootCause) && other.rootCause === f.rootCause)
        || (f.human?.causeId && other.human?.causeId === f.human.causeId)));
      const merged = [f, ...matches.flat()];
      for (const group of matches) groups.splice(groups.indexOf(group), 1);
      groups.push(merged);
    }
    const required = groups.map(values => ({ cause: values[0].human?.causeId ?? values[0].rootCause,
      findings: values.map(f => `${f.axis}:${f.id}`),
      knownCauses: [...new Set<string>(values.flatMap(f => f.human?.knownCause ? [f.human.knownCause] : []))],
      verdict: values.every(f => f.human?.verdict === "valid") ? "valid" : values.every(f => f.human?.verdict === "invalid") ? "invalid" : "pending",
      major: values.some(f => Number(f.impact?.score) <= 2) }));
    const adjudicationComplete = j?.complete === true && judged.every(f => f.human && f.human.verdict !== "pending") && !required.some(r => r.verdict === "pending");
    const matches = c.oracle.filter(o => o.kind === "positive" && (frozen.data.version === 1 || o.layer === "review")).map(o => ({ id: o.id, major: o.major,
      status: required.some(f => f.verdict === "valid" && f.knownCauses.includes(o.id)) ? "detected"
        : initial?.status === "completed" && adjudicationComplete ? "missed" : "unknown" }));
    const majors = matches.filter(m => m.major);
    return { classification: frozen.data.version === 2 ? {
      review: c.oracle.filter(o => o.layer === "review").map(o => o.id),
      automaticCheck: c.oracle.filter(o => o.layer === "automatic_check").map(o => o.id),
      unresolved: c.oracle.filter(o => o.layer === "unresolved").map(o => o.id),
    } : null, caseId: c.id, repoKey: c.repoKey, pr: c.pr, attemptId: first?.attemptId ?? null, attempts: runs.length, status: unavailableReason ? "unevaluable" : !initial ? "not_run" : initial.status,
      unavailableReason, required, causeMatches: matches, major: majors, adjudicationComplete, humanJudgment: j ?? null,
      triageMinutes: j?.triageMinutes ?? null, hasFindings: findings.length > 0, candidatesUnknown: judged.filter(f => f.decision === "unverified").length,
      additionalValid: judged.filter(f => f.human?.verdict === "valid" && !f.human.knownCause).map(f => `${f.axis}:${f.id}`),
      rejectedValid: judged.filter(f => f.decision !== "required" && f.human?.verdict === "valid").map(f => `${f.axis}:${f.id}`),
      majorFalsePositives: required.filter(f => f.verdict === "invalid" && f.major).length,
      telemetry: initial ? { elapsedMs: initial.execution.elapsedMs, stages: initial.execution.stages.map((s: any) => ({ phase: s.phase, effectiveModels: s.effectiveModels, usage: s.usage ?? null, elapsedMs: s.elapsedMs })), actualCharge: null, estimatedCharge: null } : null };
  });
  const primary = rows.filter((row, index) => rows.findIndex(other => other.repoKey === row.repoKey && other.pr === row.pr) === index);
  const metrics = (subset: typeof rows) => {
    const required = subset.flatMap(r => r.required), valid = required.filter(r => r.verdict === "valid").length;
    const times = subset.flatMap(r => r.triageMinutes === null ? [] : [r.triageMinutes]);
    return { prs: subset.length, required: required.length, valid, pending: required.filter(r => r.verdict === "pending").length, precision: required.length ? valid / required.length : null, precisionIsFinal: required.length > 0 && required.every(r => r.verdict !== "pending"),
      triageMedianMinutes: times.length === subset.length ? median(times) : null, observedTriageMedianMinutes: median(times), triageKnown: times.length, triageUnknown: subset.length - times.length,
      findingsOnlyMedianMinutes: median(subset.filter(r => r.hasFindings).flatMap(r => r.triageMinutes === null ? [] : [r.triageMinutes])),
      unevaluable: subset.filter(r => r.status === "unevaluable").length, notRun: subset.filter(r => r.status === "not_run").length,
      candidatesUnknown: subset.reduce((n, r) => n + r.candidatesUnknown, 0), slow: subset.filter(r => r.triageMinutes !== null && r.triageMinutes > 5).map(r => ({ caseId: r.caseId, minutes: r.triageMinutes })) };
  };
  const major = rows.flatMap(r => r.major), majorDetected = major.filter(m => m.status === "detected").length, summary = metrics(primary);
  const regression = { majorTotal: major.length, majorDetected, majorMissed: major.filter(m => m.status === "missed").length, majorUnknown: major.filter(m => m.status === "unknown").length,
    majorDetectionRate: major.length && major.every(m => m.status !== "unknown") ? majorDetected / major.length : null, majorFalsePositives: rows.reduce((n, r) => n + r.majorFalsePositives, 0) };
  const pending = rows.some(r => (r.classification?.unresolved.length ?? 0) > 0 || r.status !== "completed" || !r.adjudicationComplete || r.candidatesUnknown > 0 || r.required.some(f => f.verdict === "pending")) || summary.triageUnknown > 0;
  return { reviewPolicy: frozen.data.reviewPolicy ?? "legacy", status: pending ? "pending" : "evaluated", datasetHash: frozen.hash, judgmentsHash: judgmentsPath ? hash(readFileSync(judgmentsPath, "utf8")) : null, purpose: frozen.data.purpose, acceptance: "not_evaluated",
    prospectiveTrial: { status: "not_started", requiredPrs: 30, requiredPerRepo: 10 },
    regression, metrics: summary, byRepo: Object.fromEntries([...new Set(primary.map(r => r.repoKey))].map(repo => [repo, metrics(primary.filter(r => r.repoKey === repo))])),
    cases: rows, excludedFromPrCount: rows.filter(r => !primary.includes(r)).map(r => r.caseId),
    limits: "開発用事例の集計。偽CLIの検証を実モデルの検出性能としない。未知の全不具合や新規30PRの受入を評価していない。使用量は実請求額ではない。" };
}
