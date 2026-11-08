import { changedReviewLines } from "./review-change-evidence";
import { linkedFindingKeys, requirementLinksValid } from "./review-requirement-links";
import { contentAssessmentValid } from "./review-content-assessment";
import { exactSdkVersionQuoted } from "./review-sdk-evidence";
import type { ReviewPreparation, ReviewSource } from "./review-prepare";
import type { ReviewRecordedStage } from "./review-record";

export type ReviewAxis = "standards" | "spec";
export interface ReviewUnit {
  id: string;
  axis: ReviewAxis;
  requirement: string;
  reference: { source: string; hash: string; line: number; quote: string };
  context?: { source: string; hash: string; startLine: number; endLine: number; content: string };
}

// 行IDは維持しつつ、折り返された段落を同じ固定資料から補い、条件や時点を切り離さない。
function paragraphContext(lines: string[], index: number) {
  const boundary = (line: string) => !line.trim() || /^\s*(?:#{1,6}\s|```|~~~|\|)/.test(line);
  const item = (line: string) => /^\s*(?:[-*+] |\d+[.)] )/.test(line);
  if (boundary(lines[index]!)) return undefined;
  let start = index, end = index;
  while (start > 0 && !item(lines[start]!) && !boundary(lines[start - 1]!)) start--;
  while (end + 1 < lines.length && !boundary(lines[end + 1]!) && !item(lines[end + 1]!)) end++;
  return start === end ? undefined : { startLine: start + 1, endLine: end + 1, content: lines.slice(start, end + 1).join("\n") };
}

// 見出しや空行以外の本文を保守的な確認単位にする。短文もモデル側の要約で落とさない。
export function reviewUnits(sources: ReviewSource[]): ReviewUnit[] {
  return sources.flatMap(s => {
    const lines = s.content.split("\n"), key = `${s.type}:${s.id}`;
    return lines.flatMap((line, i) => {
      if (s.type === "standard" && s.applicability && !s.applicability.some(r => r.kind === "required" && r.start <= i + 1 && r.end >= i + 1)) return [];
      if (!line.trim() || /^#{1,6}\s/.test(line) || /^\s*(?:```|~~~|\|?\s*:?-{3,}[-| :]*$)/.test(line)) return [];
      if (s.type === "plan" && !/^\s*"(?:title|description)":\s*"/.test(line)) return [];
      const context = s.type === "plan" ? undefined : paragraphContext(lines, i);
      return [{ id: `${key}:L${i + 1}`, axis: s.type === "standard" ? "standards" as const : "spec" as const,
        requirement: s.type === "plan" ? JSON.parse(line.trim().replace(/^"(?:title|description)":\s*/, "").replace(/,$/, "")) : line,
        reference: { source: key, hash: s.hash, line: i + 1, quote: line },
        ...(context ? { context: { source: key, hash: s.hash, ...context } } : {}) }];
    });
  });
}

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const axes: ReviewAxis[] = ["standards", "spec"];

export function adjudicate(preparation: ReviewPreparation, stages: Pick<ReviewRecordedStage, "phase" | "format" | "output">[], locations: Map<string, string[]>) {
  const changed = changedReviewLines(preparation.target!.patch);
  const format = stages.find(s => s.phase === "verification")?.format;
  const modern = format === 3;
  const strict = format === 2 || modern;
  const verification = stages.find(s => s.phase === "verification")!.output!;
  const units = reviewUnits(preparation.sources);
  const coverage: Row[] = verification.requirements.map(r => ({ ...r, context: units.find(unit => unit.id === r.id)?.context }));
  const problems: { code: string; message: string }[] = [];
  const incomplete = new Set<ReviewAxis>();
  const problem = (axis: ReviewAxis, code: string, message: string) => { incomplete.add(axis); problems.push({ code, message }); };
  if (verification.consistency?.status !== "consistent" || !text(verification.consistency?.evidence)) {
    problem("spec", verification.consistency?.status === "conflict" ? "REQUIREMENTS_CONFLICT" : "CONSISTENCY_UNVERIFIED", "要求同士の整合性が確認できません");
  }
  const referenceValid = (value: unknown, planOnly = false) => {
    const ref = object(value);
    const source = preparation.sources.find(s => `${s.type}:${s.id}` === ref.source && (!planOnly || s.type === "plan"));
    return !!source && source.hash === ref.hash && Number.isInteger(ref.line) && Number(ref.line) > 0
      && text(ref.quote) && source.content.split("\n")[Number(ref.line) - 1] === ref.quote;
  };
  const locationValid = (value: unknown) => {
    const loc = object(value);
    return text(loc.path) && !loc.path.startsWith("/") && !loc.path.split("/").includes("..")
      && ["head", "base"].includes(String(loc.revision)) && Number.isInteger(loc.line) && Number(loc.line) > 0
      && Number(loc.line) <= (locations.get(`${loc.revision}:${loc.path}`)?.length ?? 0)
      && (loc.quote === undefined || locations.get(`${loc.revision}:${loc.path}`)?.[Number(loc.line) - 1] === loc.quote);
  };
  const evidenceValid = (value: Row, field: "kind" | "method") => {
    const mode = value[field], staticMode = field === "kind" ? "static" : "inspection";
    return mode === staticMode && (value.recordIds === undefined || (Array.isArray(value.recordIds) && value.recordIds.length === 0));
  };
  const findings: Row[] = [];
  const keys = new Set<string>();
  const unrelatedExisting = new Set<string>();
  for (const candidate of verification.candidates) {
    const axis: ReviewAxis = candidate.axis === "standards" ? "standards" : "spec";
    const key = `${candidate.axis}:${candidate.id}`;
    const impact = object(candidate.impact);
    const evidence = object(candidate.evidence);
    const sdk = object(candidate.sdk);
    const responsibility = object(candidate.responsibility);
    const references = responsibility.references;
    const classified = ["review", "automatic_check", "unresolved"].includes(String(responsibility.owner)) && text(responsibility.rationale)
      && Array.isArray(references) && references.every(ref => referenceValid(ref) || (locationValid(ref) && text(object(ref).quote)));
    const automatic = classified && responsibility.owner === "automatic_check" && (references as unknown[]).length > 0
      && candidate.decision === "out_of_scope" && candidate.scopeEvidence === null && candidate.needsSpecificationDecision === false;
    const responsibilityValid = (!strict && candidate.responsibility === undefined) || (classified
      && (responsibility.owner === "automatic_check" ? automatic : responsibility.owner !== "unresolved" || candidate.decision === "unverified"));
    const baseline = strict && candidate.origin === "pre_existing";
    const baselineCodeValid = baseline && locationValid(candidate.baselineEvidence)
      && object(candidate.baselineEvidence).revision === "base" && object(candidate.location).revision === "head"
      && object(candidate.baselineEvidence).path === object(candidate.location).path
      && text(object(candidate.baselineEvidence).quote) && object(candidate.baselineEvidence).quote === object(candidate.location).quote;
    const baselineValid = baselineCodeValid && coverage.some(r => r.status === "unsatisfied" && linkedFindingKeys(r, String(r.axis), modern).includes(key));
    const scopeAssessment = object(candidate.scopeAssessment);
    const scopeReferences = scopeAssessment.references;
    const scopeValid = baselineCodeValid && ["unrelated_existing", "explicit_requirement"].includes(String(scopeAssessment.kind)) && text(scopeAssessment.rationale)
      && Array.isArray(scopeReferences) && scopeReferences.length > 0
      && scopeReferences.every(ref => referenceValid(ref) || (locationValid(ref) && text(object(ref).quote)))
      && scopeReferences.some(ref => referenceValid(ref) && preparation.sources.some(s => s.type !== "standard" && `${s.type}:${s.id}` === object(ref).source));
    const outsideBaseline = scopeValid && scopeAssessment.kind === "unrelated_existing" && responsibility.owner === "review"
      && candidate.decision === "out_of_scope" && candidate.changeEvidence === null && candidate.scopeEvidence === null && candidate.needsSpecificationDecision === false;
    const explicitBaseline = scopeValid && scopeAssessment.kind === "explicit_requirement" && candidate.decision === "required" && candidate.changeEvidence === null;
    const sdkSourceValid = sdk.status !== "verified" || (text(sdk.version) && locationValid(sdk.source)
      && exactSdkVersionQuoted(sdk.version, object(sdk.source).quote));
    const changeEvidence = object(candidate.changeEvidence);
    const changeEvidenceValid = locationValid(candidate.changeEvidence)
      && changed.has(`${changeEvidence.revision}:${changeEvidence.path}:${changeEvidence.line}`);
    const valid = (!modern || (text(candidate.expectedBehavior) && candidate.expectedBehavior.trim() !== String(candidate.failure).trim())) && (candidate.scopeAssessment == null || outsideBaseline || explicitBaseline) && responsibilityValid && (!strict || candidate.origin === undefined || ["introduced", "pre_existing", "unknown"].includes(String(candidate.origin))) && axes.includes(candidate.axis as ReviewAxis) && text(candidate.id) && !keys.has(key)
      && candidate.target === preparation.target!.hash && locationValid(candidate.location) && (referenceValid(candidate.contract) || (locationValid(candidate.contract) && text(object(candidate.contract).quote)))
      && [candidate.condition, candidate.failure, candidate.rootCause, candidate.reproduction, candidate.rationale, candidate.defense, impact.description, evidence.detail, sdk.evidence].every(text)
      && evidenceValid(evidence, "kind") && ["verified", "not_applicable"].includes(String(sdk.status))
      && sdkSourceValid
      && (!strict || candidate.decision !== "required" || (baseline ? baselineValid : candidate.origin !== "unknown" && changeEvidenceValid))
      && ["required", "unverified", "false_positive", "out_of_scope", "deferred", "risk_accepted", "optional"].includes(String(candidate.decision))
      && (candidate.decision !== "required" || (candidate.needsSpecificationDecision === false && Number.isInteger(impact.score) && Number(impact.score) >= 0 && Number(impact.score) <= 4))
      && (!["out_of_scope", "deferred", "risk_accepted"].includes(String(candidate.decision)) || automatic || outsideBaseline || referenceValid(candidate.scopeEvidence, true));
    keys.add(key);
    // 任意提案は監査記録であり、証拠の不備で点数・停止へ影響させない。
    const explored = stages.filter(stage => stage.phase !== "verification").flatMap(stage => stage.output?.candidates ?? []).find(item => item.id === candidate.id && (item.axis ?? candidate.axis) === candidate.axis);
    const auditOnly = candidate.decision === "optional" && candidate.target === preparation.target!.hash && !["required", "unverified"].includes(String(explored?.decision));
    const finding = { ...candidate, proposedDecision: candidate.decision, decision: valid || auditOnly ? candidate.decision : "unverified" };
    findings.push(finding);
    if (valid && outsideBaseline) unrelatedExisting.add(key);
    if (valid && candidate.decision === "required" && baseline && !explicitBaseline) problem(axis, "BASELINE_SCOPE_UNVERIFIED", `${key} は基点から存在する問題ですが、今回の要求との関係が未確認です。対象内の修正要求かスコープ外の既存課題かを確認してください`);
    if ((!valid && !auditOnly) || finding.decision === "unverified") {
      const details = [
        !valid && baseline && !baselineCodeValid ? "baselineEvidence: locationのhead行と同じpath・内容のbase行が必要です" : null,
        !valid && strict && candidate.decision === "required" && !baseline && !changeEvidenceValid
          ? "changeEvidence: 追加行はhead、削除行はbaseの実際の変更行を指定してください。置換は該当する追加行または削除行を使い、locationに使った未変更の周辺行では代用できません" : null,
        !sdkSourceValid ? "sdk.source/version: 固定依存の実版と引用値の一致が必要です。範囲指定・部分一致は実版の証拠になりません" : null,
      ].filter(Boolean);
      problem(axis, candidate.target !== preparation.target!.hash ? "STALE_EVIDENCE" : "FINDING_UNVERIFIED", `${key} の採否または証拠を確認できません${details.length ? `（${details.join("；")}）` : ""}`);
    }
  }
  // 検証担当が探索候補を省略しても、棄却として消さない。
  for (const stage of stages.filter(s => s.phase !== "verification")) for (const candidate of stage.output?.candidates ?? []) {
    if (!keys.has(`${stage.phase}:${candidate.id}`)) {
      findings.push({ ...candidate, axis: stage.phase, proposedDecision: candidate.decision, decision: "unverified" });
      problem(stage.phase as ReviewAxis, "CANDIDATE_OMITTED", `${stage.phase}:${candidate.id} の検証結果がありません`);
    }
  }
  if (!units.some(u => u.axis === "spec")) problem("spec", "COVERAGE_EMPTY", "要求本文から確認単位を取得できません");
  for (const row of coverage) if (!units.some(u => u.id === row.id)) problem(row.axis === "standards" ? "standards" : "spec", "COVERAGE_INVALID", `未知の要求 ${row.id} が返されました`);
  for (const unit of units) {
    const records = coverage.filter(r => r.id === unit.id);
    const row = records[0] ?? {};
    const explored = stages.find(s => s.phase === unit.axis)?.output?.requirements.filter(r => r.id === unit.id) ?? [];
    const verificationMethod = object(row.verification);
    const linked = linkedFindingKeys(row, unit.axis, modern);
    const required = findings.filter(f => f.decision === "required" && linked.includes(`${f.axis}:${f.id}`));
    const automatic = preparation.responsibility?.assignments.find(a => a.sourceHash === unit.reference.hash && a.line === unit.reference.line);
    // 固定分担のrationaleは新形式の展開時にCLIが計画から復元し、モデルの文面はproposedRationaleに残る。一致の確認は復元漏れを通さないために残す。
    const automaticScope = !!automatic && row.status === "out_of_scope" && explored[0]?.status === "out_of_scope"
      && referenceValid(row.scopeEvidence) && object(row.scopeEvidence).source === unit.reference.source && object(row.scopeEvidence).line === unit.reference.line
      && row.rationale === automatic.rationale;
    const ownScopeReference = referenceValid(row.scopeEvidence) && object(row.scopeEvidence).source === unit.reference.source && object(row.scopeEvidence).line === unit.reference.line;
    const outsideBaseline = row.status === "out_of_scope" && Array.isArray(row.findingIds) && row.findingIds.length > 0
      && linked.every(id => unrelatedExisting.has(id))
      && !findings.some(f => ["required", "unverified"].includes(String(f.decision))
        && object(f.contract).source === unit.reference.source && object(f.contract).line === unit.reference.line)
      && ownScopeReference;
    const linksValid = !strict || requirementLinksValid(row, unit, findings, referenceValid, locationValid, modern);
    const assessmentValid = !modern || contentAssessmentValid(row, explored[0] ?? {}, unit, findings, referenceValid, !!automatic, linksValid);
    if (!assessmentValid) problem(unit.axis, "CONTENT_ASSESSMENT_UNVERIFIED", `${unit.id} の本文分類・義務の保持・出典または探索との対応が未確認です`);
    if (!linksValid) problem(unit.axis, "REQUIREMENT_LINK_UNVERIFIED", `${unit.id} の要求と候補の対応を確認できません（findingLinks: 操作・条件・期待動作の一致、当該違反への修正効果、要求とコードの固定参照が必要です）`);
    const valid = assessmentValid && linksValid && (!automatic || automaticScope) && records.length === 1 && explored.length === 1 && row.axis === unit.axis && row.target === preparation.target!.hash
      && row.requirement === unit.requirement && referenceValid(row.reference) && object(row.reference).source === unit.reference.source && object(row.reference).line === unit.reference.line
      && text(row.evidence) && evidenceValid(verificationMethod, "method") && text(verificationMethod.detail)
      && Array.isArray(row.implementation) && (row.status === "out_of_scope" || (modern && row.status === "context") || row.implementation.length > 0) && row.implementation.every(ref => locationValid(ref) || (strict && referenceValid(ref)))
      && ((row.status === "satisfied" && (!modern || !findings.some(f => linked.includes(`${f.axis}:${f.id}`) && ["required", "unverified", "out_of_scope"].includes(String(f.decision))))) || (modern && row.status === "context") || (row.status === "unsatisfied" && required.length > 0)
        || (row.status === "out_of_scope" && (automaticScope || outsideBaseline || referenceValid(row.scopeEvidence, true)) && text(row.rationale)));
    if (!valid) {
      const details = row.status === "out_of_scope" && !ownScopeReference && !referenceValid(row.scopeEvidence, true)
        ? "（scopeEvidence: 対象外にする要求自身のsource/lineが必要です。範囲の根拠は候補のscopeAssessment.referencesへ記録します）"
        : row.status === "unsatisfied" && required.length === 0 ? "（findingIds: 軸を識別した検証済み要対応候補との対応が必要です）" : "";
      problem(unit.axis, row.target && row.target !== preparation.target!.hash ? "STALE_EVIDENCE" : "COVERAGE_INCOMPLETE", `${unit.id} の要求別確認が不足しています${details}`);
      if (!records.length) coverage.push({ ...unit, target: preparation.target!.hash, status: "unverified", evidence: "要求別記録なし" });
      else { row.proposedStatus = row.status; row.status = "unverified"; }
    }
  }
  const mandatory = findings.filter(f => f.decision === "required");
  const review = Object.fromEntries(axes.map(axis => [axis, incomplete.has(axis) ? "incomplete" : mandatory.some(f => f.axis === axis) || coverage.some(r => r.axis === axis && r.status === "unsatisfied") ? "failed" : "passed"])) as Record<ReviewAxis, "incomplete" | "failed" | "passed">;
  const score = problems.length ? null : Math.min(5, ...mandatory.map(f => Number(object(f.impact).score)));
  const rootCauses = [...new Set(findings.map(f => f.rootCause).filter(text))].map(id => ({ id, candidates: findings.filter(f => f.rootCause === id).map(f => ({ axis: f.axis, id: f.id, decision: f.decision })) }));
  return { coverage, findings, rootCauses, problems, score, review };
}

/** 観点は探索の手掛かりであり、新しい必須規約や指摘数のノルマではない。 */
export function reviewFocus(target: NonNullable<ReviewPreparation["target"]>) {
  const files = target.files.join("\n");
  const changed = target.patch.split("\n").filter(line => /^[+-][^+-]/.test(line)).join("\n");
  const focus = [{ id: "contract", reason: "変更が公開契約・状態と利用側に与える影響を確認する" }];
  const add = (id: string, reason: string, applies: boolean) => { if (applies) focus.push({ id, reason }); };
  const code = target.files.some(path => /\.(?:[cm]?[jt]sx?|py|go|rs|java|rb|sh)$/.test(path));
  add("boundary", "境界値・失敗・部分更新と既存防御を確認する", code);
  add("tests", "関連テストが契約違反を検出するか確認する", code);
  add("time", "期限・再試行・取消と状態遷移を確認する", /timeout|retry|async|await|deadline|cancel|Date\b/i.test(changed));
  add("ui", "入力操作・表示状態・アクセシビリティを確認する", /\.(?:tsx|jsx|vue|svelte|css)$|(?:^|\/)ui\//m.test(files));
  add("external_input", "外部入力・認証・解析・エラー処理を確認する", /request|auth|parse|fetch|process\.argv|stdin|HTTP/i.test(changed));
  add("database", "DB整合性・トランザクション・性能を確認する", /\.sql$|migration|database/m.test(files) || /SELECT |INSERT |UPDATE |transaction|sqlite|query\(/i.test(changed));
  add("ci", "実行条件・権限・成果物とCIの失敗検出を確認する", /\.github\/|Dockerfile|(?:^|\/)ci\//m.test(files));
  add("documentation", "変更された文書の契約・数値が利用者を誤らせる具体的不具合を確認する", /\.(?:md|mdx|rst|txt|csv)$|(?:^|\/)docs\//m.test(files));
  return focus;
}

export const adjudicationInstructions = `
reviewUnitsは固定資料の必須確認単位であり、assignedRequirementIdsの単位について同じidを返す。短い要求も省略しない。
探索は自軸、verificationは全軸のassignedRequirementIdsの全単位を担当し、requirementsへ返す。Standards探索に添えるSpec単位は主要求の参考である。各単位は必要に応じて複数の要求を含むので、その全てを確認する。
要求statusはsatisfied/unsatisfied/unverified/out_of_scope/context。contextは説明だけと独立確認した本文記録であり、実装充足とは別である。targetはtarget.hash。implementationは固定コードの{path,revision:head|base,line}または固定資料の{source,line}の配列。
verificationは{method:inspection,detail:静的な確認方法}。evidenceは具体的な静的証拠。既存テスト成功だけでは充足としない。
unsatisfiedには要対応候補のaxis:idをfindingIdsに記録する。他軸で発見した候補でも、操作・条件・期待動作・修正効果の一致を検証して参照する。out_of_scopeには承認済みplanまたは固定responsibility、もしくは検証済みスコープ外既存候補のfindingIdsと当該要求のscopeEvidence・rationaleを必要とし、残る要求を消さない。
候補のidは軸内で一意、検証時も全探索候補のidを保持し、棄却も省略しない。axisはstandards/spec、targetはtarget.hash。
locationは{path,revision:head|base,line}。contractは固定資料の{source,line}または固定コードの{path,revision,line}。固定資料のsourceはsources[].sourceと同じtype:id（例 standard:AGENTS.md）を省略せずに使い、ファイル名・path・typeなしのidにしない。hash・quoteは書かず、CLIが固定資料・固定コードから復元する。
condition, failure, reproduction, rootCause, rationale, defenseには到達条件・破綻・再現手順・原因・採否理由・既存防御の確認結果を記録する。
requiredには、適用される契約、現在の到達条件、その条件での実際の不一致、具体的影響を固定証拠で結び付ける。可能性の説明や読み手が誤解するかもしれないという推測だけを、確認済みの誤動作・影響へ置き換えない。文書や指示文も同じ基準で判断し、実行時の被害が未発生でも、明示的な禁止・保証との矛盾や必須記載の欠落自体を固定資料で確認できる場合は契約違反として扱う。
impactは{score:0..4,description:具体的影響}。0=広範再設計を要する致命問題、1=局所的致命問題、2=主要機能/重要状態の重大問題、3=その他契約不具合、4=軽微だが必須の対応。
0/1には、重大な認可境界の突破、機密情報の漏えい、回復不能な重要データの消失・破壊など、機能停止を超える致命的影響の根拠が必要である。例の語があるだけでは足りず、具体的な到達条件・保護対象・失われる状態を固定コードと契約で確認する。主要機能が一部または全ての有効入力で停止しても、確認できた影響が機能停止にとどまるなら2とする。全呼出しで失敗すること、回避経路がないこと、公開関数が1つだけであることだけで1にしない。まず致命的影響の有無を確定し、その根本原因の解消に広範な再設計が必要なら0、局所修正で解消できるなら1とする。修正の局所性から致命的影響を逆算しない。未確認の致命的影響を、推測で0/1にしたり2へ確定したりせず未確認として保持する。
重大度は、到達条件と、その条件が成立したときの影響を分けて判断する。サポートする利用経路で主要機能が停止する、または重要な状態を壊すと確認できる場合、条件が限定的という理由だけで4に下げない。一方、例外・失敗という語だけで重大にせず、実際に失われる機能、影響範囲、固定コード・契約で確認した回避手段をimpact.descriptionへ示す。主要機能が保たれる軽微な契約差と区別し、到達性や影響の証拠不足を低い重大度で代用せず未確認に残す。検証工程は探索側の点数を引き継がず、この根拠から再判定する。
evidenceは{kind:static,detail:到達性と破綻を裏付ける静的証拠}。この工程に実行ツールはなく、コマンド実行済みと自己申告しない。
sdkは{status:verified|not_applicable,evidence,version?,source?}。verifiedのsourceは実版を含む固定依存ファイルの行{path,revision,line}で、引用はCLIが固定コードから取得する。SDK関係があるときは固定依存ファイルの実版と契約出典を照合する。
decisionはrequired/unverified/false_positive/out_of_scope/deferred/risk_accepted/optional。今回の必須要求の判定や確認済み要対応の修正に不可欠な仕様判断が未決ならneedsSpecificationDecision=trueかつunverifiedにし、どの要求を何が判定不能にしているかを示す。任意の設計改善に複数の選択肢があることだけでは未決仕様にしない。必須要求・具体的な不具合に必要な証拠不足は未確認のまま保持する。requiredはfalseを必要とする。
未確認にする前に、何の必須契約または固定証拠に基づく具体的疑義を、どの不足事実が判定不能にしているかを示す。固定文脈を確認した結果、候補の前提が肯定・例示から追加した排他的制約や根拠のない可能性だけだと分かった場合は、探索では候補にせず、verificationでは元のid・axisを保持してfalse_positiveとし、成立しない前提と固定出典をrationaleへ記録する。思いついた懸念を否定し切れないことだけでunverifiedや仕様判断待ちにしない。ただし、必須契約の意味や必要資料が不明な場合、または具体的な疑義に必要な到達条件・影響を確定できない場合を、根拠のない仮説と取り違えて棄却しない。候補の棄却で必須要求の未確認を消さない。
臭い・整理・好みだけの懸念は探索候補にしない。検証へ混入した場合だけoptionalとして監査記録に残し、通常報告・減点・停止の対象にしない。条件付き懸念は証拠なしでrequiredにしない。out_of_scope/deferred/risk_acceptedは承認済みplanへのscopeEvidenceを必要とする。ただし固定コード・規約の根拠付きresponsibility.owner=automatic_checkの候補は、独立した担当分離によりout_of_scopeとしscopeEvidence=nullを使う。scopeAssessmentで今回と無関係と確認した既存候補も、基点証拠・固定した作業範囲の参照付きでout_of_scope、scopeEvidence=nullとする。
同根本原因の候補はrootCauseで関連付けるが、両軸の出典・判定を消さない。
verificationはconsistency:{status:consistent|conflict|unverified,evidence:今回取得した要求資料の内部・相互の整合性と範囲を確認した根拠}も返す。
requirements.acquisitionは資料の取得状態であり、意味上の整合性とは別である。status=completeは、指定・解決した要求元と、その登録済み関連Issue・現行Spec・計画を必要な範囲で取得できたことを表す。sourceIdsの全資料を固定sourcesの索引と照合する。mode=document_onlyはIssueを選択・関連付けていない文書単独のレビューであり、存在しないIssue・計画との比較を追加で要求しない。mode=issue_contextでも、現行Specや計画が未設定なら欠落ではない。指定文書に紐づくIssue・現行Spec・計画がある場合はsourceIdsに含まれるため、文書単独と読み替えて無視しない。
準備時のrequirements.consistency=unverifiedは、まだ意味を評価していない初期値であり、資料の取得失敗を意味しない。取得完了だけでconsistentにしない。consistencyは現在の成果物の充足状況と分け、文書単独でも次の順序で判定する。
1. 固定出典から要求・契約の対象、適用条件、例外、変更を禁じる制約を確認する。外部契約を含む必須資料が未取得、または意味が不明で両立を判断できなければunverifiedとし、何が必要かを示す。acquisitionの記録が無いことだけで未指定資料を推測して追加せず、欠けた必須資料を未指定扱いで除外しない。
2. conflictには、同時に適用される要求・契約の出典と、義務を変更せずには両立できない理由をconsistency.evidenceへ示す。今回の差分の判定に関係しない既存規約同士の不一致はconflictにせず、consistency.evidenceへ記録する。適用条件が異なる義務を同時要求と扱わず、現在の実装や資料を直せば満たせることを矛盾の証拠にしない。固定された外部契約や変更禁止を無視して、要求・資料を自由に書き換えられるとも仮定しない。
3. 要求・契約の両立を確認できたらconsistentとし、現在の実装不足・裏付け不足は別にcoverageと候補で判定する。要求違反を固定資料で確定できればunsatisfiedとrequired、判定に必要な事実が不明ならunverifiedに残す。裏付けがないという違反の確認と、その主張自体の真偽を分ける。修正に事実確認が必要なことや、現在の成果物では全要求を満たせないことだけでconsistencyをconflictにしない。consistentは要求充足・修正可能性・レビュー完了を保証しない。
focusは変更から選んだ探索の手掛かりであり、全観点の監査や任意改善の募集ではない。変更の影響確認に必要なら観点を追加し、差分から利用側と実SDK版まで確認する。一般論の必須規則や指摘ノルマにしない。
`;
