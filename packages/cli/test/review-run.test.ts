import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

type Phase = "standards" | "spec" | "verification";
interface Reference { source: string; line: number }
interface Location { path: string; revision: string; line: number; quote?: string }
interface Unit { id: string; axis: string; requirement: string; reference: Reference; requiredAssessmentReferences: Reference[]; paragraph?: string }
interface Input { phase: Phase; target: { hash: string }; assignedRequirementIds: string[]; reviewUnits: Unit[]; reviewParagraphs: { id: string; content: string }[] }
interface Link {
  findingAxis: string; findingId: string; relation: string; observedBehavior: string; requirementEvidence: Reference[]; codeEvidence: Location[];
  operation: { requirement: string; candidate: string; match: string }; condition: { requirement: string; candidate: string; match: string };
  obligation: { requirement: string; candidate: string; match: string }; effectOfFix: string; rationale: string;
}
interface Requirement {
  id: string; status: string; contentAssessment: { kind: string; obligations: string[]; references: Reference[]; rationale: string };
  implementation: (Location | Reference)[]; verification: { method: string; detail: string; recordIds: string[] }; evidence: string;
  findingIds: string[]; findingLinks?: Link[]; scopeEvidence: Reference | null; rationale: string;
}
interface Candidate {
  id: string; axis: string; location: Location; contract: Reference | Location; condition: string; expectedBehavior: string; failure: string;
  impact: { score: number; description: string }; evidence: { kind: string; detail: string; recordIds: string[] }; reproduction: string; rootCause: string;
  decision: string; rationale: string; defense: string; sdk: { status: string; evidence: string; version: string | null; source: Location | null };
  scopeEvidence: Reference | null; needsSpecificationDecision: boolean; changeEvidence: Location | null; origin: string; baselineEvidence: Location | null;
  responsibility: { owner: string; rationale: string; references: (Reference | Location)[] };
  scopeAssessment: { kind: string; rationale: string; references: (Reference | Location)[] } | null;
}
interface Output {
  format: number; target: string; axis: Phase; completed: boolean; candidates: Candidate[]; requirements: Requirement[];
  consistency: { status: string; evidence: string }; causeGroups: { id: string; members: string[]; rationale: string }[];
}

function stageOutput(input: Input): Output {
  return { format: 3, target: input.target.hash, axis: input.phase, completed: true, candidates: [],
    requirements: input.assignedRequirementIds.map(id => {
      const unit = input.reviewUnits.find(unit => unit.id === id)!;
      return { id, status: "satisfied", contentAssessment: { kind: "obligation", obligations: [unit.requirement], references: unit.requiredAssessmentReferences, rationale: "固定要求の義務を原文のまま保持する" },
        implementation: [{ path: "value.ts", revision: "head", line: 1 }], verification: { method: "inspection", detail: "固定Gitの公開値と要求を読み比べた", recordIds: [] },
        evidence: "公開値の契約を照合した", findingIds: [], ...(input.phase === "verification" ? { findingLinks: [] } : {}), scopeEvidence: null, rationale: "固定本文を確認した" };
    }), consistency: { status: "consistent", evidence: "固定した資料を独立して読み直し要求の矛盾なし" }, causeGroups: [] };
}

async function fixture(description = "公開名valueで値2を返す。") {
  const repo = makeRepo(), db = tempDb(), dir = tempDir("review-record-");
  registerRepo(db, repo, "REC");
  writeFileSync(join(repo, "value.ts"), "export const value = 1;\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "基点");
  const base = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString().trim();
  writeFileSync(join(repo, "value.ts"), "export const value = 2;\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "対象");
  const env = { NOD_DOCS_DIR: tempDir("review-docs-") };
  const cli = (...args: string[]) => runNod([...args, "--json"], { cwd: repo, db, env });
  const issue = (await cli("issue", "create", "公開値の契約", "--description", description)).json.id;
  const write = (name: string, data: unknown) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(data)); return path; };
  const start = async (prepareArgs: string[] = [], planArgs: string[] = []) => {
    const prepared = await cli("review", "prepare", "--repo", repo, "--base", base, "--issue", issue, ...prepareArgs);
    expect(prepared.exitCode, prepared.stdout + prepared.stderr).toBe(0);
    const run = prepared.json.runId;
    const plan = await cli("review", "plan", "--run", run, ...planArgs);
    expect(plan.exitCode, plan.stdout + plan.stderr).toBe(0);
    const input = async (phase: Phase): Promise<Input> => {
      const located = await cli("review", "input", "--run", run, "--phase", phase);
      expect(located.exitCode, located.stdout + located.stderr).toBe(0);
      return JSON.parse(readFileSync(located.json.inputPath, "utf8"));
    };
    const explore = async (mutate: (output: Output, input: Input) => void = () => {}) => {
      const paths: string[] = [];
      for (const phase of ["standards", "spec"] as const) {
        const request = await input(phase), output = stageOutput(request);
        mutate(output, request); paths.push(`--${phase}`, write(`${run}-${phase}.json`, output));
      }
      return cli("review", "record", "--run", run, "--phase", "exploration", ...paths, "--agent", "code-reviewer");
    };
    const verify = async (mutate: (output: Output, input: Input) => void = () => {}, args: string[] = []) => {
      const request = await input("verification"), output = stageOutput(request);
      mutate(output, request);
      return cli("review", "record", "--run", run, "--phase", "verification", "--output", write(`${run}-verification.json`, output), "--agent", "code-reviewer", ...args);
    };
    return { run, prepared: prepared.json, input, explore, verify };
  };
  return { repo, db, dir, env, base, issue, cli, write, start };
}

function addFinding(output: Output, input: Input, score = 2): Candidate {
  const unit = input.reviewUnits.find(unit => unit.axis === "spec")!;
  const candidate: Candidate = { id: "wrong-value", axis: "spec", location: { path: "value.ts", revision: "head", line: 1 }, contract: unit.reference,
    condition: "公開値valueを取得する", expectedBehavior: "値2を返す", failure: "期待する値を返さない", impact: { score, description: "公開値を利用する機能が要求どおり動かない" },
    evidence: { kind: "static", detail: "固定コードと公開契約の不一致", recordIds: [] }, reproduction: "公開値を取得する", rootCause: "value-definition", decision: "required",
    rationale: "契約違反を確認した", defense: "補正処理なし", sdk: { status: "not_applicable", evidence: "定数exportのみ", version: null, source: null },
    scopeEvidence: null, needsSpecificationDecision: false, changeEvidence: { path: "value.ts", revision: "head", line: 1 }, origin: "introduced", baselineEvidence: null,
    responsibility: { owner: "review", rationale: "公開値の意味を確認する", references: [unit.reference] }, scopeAssessment: null };
  if (output.axis !== "standards") output.candidates.push(candidate);
  const row = output.requirements.find(row => row.id === unit.id);
  if (row) {
    row.status = "unsatisfied"; row.findingIds = ["spec:wrong-value"];
    if (output.axis === "verification") row.findingLinks = [{ findingAxis: "spec", findingId: candidate.id, relation: "violation", observedBehavior: candidate.failure,
      requirementEvidence: unit.requiredAssessmentReferences, codeEvidence: [candidate.location],
      operation: { requirement: candidate.condition, candidate: candidate.condition, match: "same" }, condition: { requirement: "公開値の利用時", candidate: "公開値の利用時", match: "same" },
      obligation: { requirement: "値2を返す", candidate: candidate.expectedBehavior, match: "same" }, effectOfFix: "resolves_this_violation", rationale: "定数の修正でこの要求違反が解消する" }];
  }
  if (output.axis === "verification") output.causeGroups = [{ id: "value-definition", members: ["spec:wrong-value"], rationale: "公開定数の定義が原因" }];
  return candidate;
}

test("対象commitが準備後に変われば固定版の5点と現在版の提出不可を区別して保存する", async () => {
  const f = await fixture(), run = await f.start();
  expect((await run.explore()).exitCode).toBe(0);
  writeFileSync(join(f.repo, "value.ts"), "export const value = 3;\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "準備後の別版");
  const result = await run.verify();
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({ status: "incomplete", score: null, currentSubmission: { eligible: false }, fixedResult: { status: "completed", score: 5 } });
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "TARGET_CHANGED" }));
  expect(JSON.parse(readFileSync(result.json.artifactPath, "utf8"))).toEqual(result.json);
});

test("検証入力は固定資料と正規化候補・指定要求別項目だけを出力する", async () => {
  const f = await fixture(), run = await f.start();
  const exploration = await run.explore((output, input) => {
    addFinding(output, input);
    output.consistency.evidence = "PRIVATE_EXPLORATION_CONSISTENCY";
    output.causeGroups = [{ id: "PRIVATE_EXPLORATION_GROUP", members: [], rationale: "探索担当の総合判断" }];
  });
  expect(exploration.exitCode).toBe(0);
  const located = await f.cli("review", "input", "--run", run.run, "--phase", "verification");
  const input = JSON.parse(readFileSync(located.json.inputPath, "utf8"));
  expect(Object.keys(input).sort()).toEqual(["adjudicationInstructions", "assignedRequirementIds", "baseCode", "candidatePolicy", "candidates", "code", "contextPath",
    "excludedSources", "focus", "instructions", "phase", "requirements", "reviewParagraphs", "reviewUnits", "scopePolicy", "sources", "target"].sort());
  for (const stage of input.candidates) {
    expect(Object.keys(stage).sort()).toEqual(["axis", "candidates", "requirements"]);
    for (const row of stage.requirements) expect(Object.keys(row).sort()).toEqual(["id", "status", "contentAssessment", "implementation", "verification", "evidence", "findingIds", "scopeEvidence", "rationale"].sort());
  }
  expect(input.candidates[1].candidates[0]).toMatchObject({ id: "wrong-value", contract: { source: `issue:${f.issue}`, quote: "公開名valueで値2を返す。" } });
  expect(JSON.stringify(input)).not.toContain("PRIVATE_EXPLORATION");
  for (const key of ["agents", "recordedAt", "completed", "causeGroups", "consistency", "summary", "thinking", "conversation", "priorConfirmedFindings", "shard", "shardInstructions"]) expect(input).not.toHaveProperty(key);
});

test("検証のcheckは形式検査だけで保存・引用照合・採点をしない", async () => {
  const f = await fixture(), run = await f.start();
  await run.explore();
  const checked = await run.verify(output => { output.requirements[0]!.implementation = [{ path: "missing.ts", revision: "head", line: 999 }]; }, ["--check"]);
  expect(checked.exitCode).toBe(0);
  expect(checked.json).toMatchObject({ saved: false, problems: [] });
  expect(checked.json).not.toHaveProperty("score");
  expect(existsSync(join(run.prepared.artifactPath, "../execution.json"))).toBe(false);
  expect((await f.cli("review", "show", "--run", run.run)).json.status).toBe("explored");
  expect((await run.verify()).json).toMatchObject({ status: "completed", score: 5 });
});

for (const score of [0, 1, 2, 3, 4]) test(`検証の要対応は既存の最重影響で採点し終了1を返す（${score}点）`, async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "value.ts"), "export const value = 3;\n"); git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "不正な公開値");
  const run = await f.start();
  await run.explore((output, input) => { addFinding(output, input, score); });
  const result = await run.verify((output, input) => { addFinding(output, input, score); });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({ status: "completed", score, review: { standards: "passed", spec: "failed" }, currentSubmission: { eligible: false } });
  expect(result.json.findings[0]).toMatchObject({ decision: "required", location: { quote: "export const value = 3;" }, contract: { quote: "公開名valueで値2を返す。" } });
  expect(result.json.coverage[0]).toMatchObject({ status: "unsatisfied", findingLinks: [{ codeEvidence: [{ quote: "export const value = 3;" }] }] });
});

test("全探索候補への対応を省略した検証は棄却や満点にしない", async () => {
  const f = await fixture(), run = await f.start();
  await run.explore((output, input) => { addFinding(output, input); });
  const result = await run.verify();
  expect(result.json).toMatchObject({ status: "incomplete", score: null });
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "CANDIDATE_OMITTED" }));
  expect(result.json.findings).toContainEqual(expect.objectContaining({ id: "wrong-value", decision: "unverified" }));
});

for (const mode of ["omitted", "unverified", "missing_code", "wrong_line", "conflict", "consistency_unverified", "erased_obligation", "different_classification"] as const)
  test(`要求の欠落・未確認・引用・整合性・義務消失は点数なしで保存する（${mode}）`, async () => {
    const f = await fixture(), run = await f.start();
    await run.explore();
    const result = await run.verify(output => {
      const row = output.requirements[0]!;
      if (mode === "omitted") output.requirements = [];
      if (mode === "unverified") row.status = "unverified";
      if (mode === "missing_code") row.implementation = [{ path: "missing.ts", revision: "head", line: 1 }];
      if (mode === "wrong_line") row.implementation = [{ path: "value.ts", revision: "head", line: 999 }];
      if (mode === "conflict") output.consistency.status = "conflict";
      if (mode === "consistency_unverified") output.consistency.status = "unverified";
      if (mode === "erased_obligation") row.contentAssessment.obligations = [];
      if (mode === "different_classification") { row.contentAssessment.kind = "background"; row.contentAssessment.obligations = []; row.status = "context"; }
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ status: "incomplete", score: null, reviewCompleted: false });
    expect(JSON.parse(readFileSync(result.json.artifactPath, "utf8"))).toEqual(result.json);
  });

for (const mode of ["missing", "operation", "condition", "obligation", "unchanged", "unknown", "unrelated_code", "wrong_axis", "duplicate", "behavior"] as const)
  test(`要求対応が不明でも独立した必須候補を消さない（${mode}）`, async () => {
    const f = await fixture(), run = await f.start();
    await run.explore((output, input) => { addFinding(output, input); });
    const result = await run.verify((output, input) => {
      addFinding(output, input);
      const row = output.requirements[0]!, link = row.findingLinks![0]!;
      if (mode === "missing") row.findingLinks = [];
      if (mode === "operation" || mode === "condition" || mode === "obligation") link[mode].match = "different";
      if (mode === "unchanged" || mode === "unknown") link.effectOfFix = mode;
      if (mode === "unrelated_code") link.codeEvidence = [{ path: "missing.ts", revision: "head", line: 1 }];
      if (mode === "wrong_axis") link.findingAxis = "standards";
      if (mode === "duplicate") row.findingLinks!.push(structuredClone(link));
      if (mode === "behavior") link.obligation.candidate = output.candidates[0]!.failure;
    });
    expect(result.json).toMatchObject({ status: "incomplete", score: null });
    expect(result.json.findings[0]).toMatchObject({ id: "wrong-value", decision: "required" });
    expect(result.json.coverage[0].status).toBe("unverified");
    expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "REQUIREMENT_LINK_UNVERIFIED" }));
  });

for (const mode of ["missing", "unreadable", "json", "schema", "phase", "target", "unfinished", "execution_evidence", "forged_quote", "cause_omitted", "cause_duplicate", "unknown_source"] as const)
  test(`検証出力の欠落・不正・未完了を最終の未完了記録として保存する（${mode}）`, async () => {
    const f = await fixture(), run = await f.start();
    await run.explore();
    let path: string | undefined;
    const request = await run.input("verification"), output = stageOutput(request);
    if (mode === "unreadable") path = f.dir;
    else if (mode === "json") { path = join(f.dir, "bad.json"); writeFileSync(path, "{"); }
    else if (mode !== "missing") {
      if (mode === "schema") output.requirements[0]!.verification = { method: "", detail: "", recordIds: [] };
      if (mode === "phase") output.axis = "spec";
      if (mode === "target") output.target = "0".repeat(64);
      if (mode === "unfinished") output.completed = false;
      if (mode === "execution_evidence") output.requirements[0]!.verification = { method: "execution", detail: "テスト結果を受領した", recordIds: ["fake"] };
      if (mode === "forged_quote") output.requirements[0]!.implementation = [{ path: "value.ts", revision: "head", line: 1, quote: "FORGED" }];
      if (mode === "unknown_source") output.requirements[0]!.contentAssessment.references = [{ source: "document:PRIVATE_UNKNOWN_SOURCE", line: 1 }];
      if (mode.startsWith("cause_")) {
        addFinding(output, request);
        if (mode === "cause_omitted") output.causeGroups = [];
        else output.causeGroups.push(structuredClone(output.causeGroups[0]!));
      }
      path = f.write("invalid.json", output);
    }
    const result = await f.cli("review", "record", "--run", run.run, "--phase", "verification", ...(path ? ["--output", path] : []), "--agent", "code-reviewer");
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ status: "incomplete", score: null, reviewCompleted: false });
    expect(result.json.stages[2].problem.code).toBe(mode === "missing" ? "STAGE_MISSING" : mode === "unreadable" ? "STAGE_UNREADABLE" : mode === "target" ? "STALE_EVIDENCE" : mode === "unfinished" ? "STAGE_INCOMPLETE" : "OUTPUT_INVALID");
    expect(JSON.stringify(result.json)).not.toContain("PRIVATE_UNKNOWN_SOURCE");
    expect(JSON.parse(readFileSync(result.json.artifactPath, "utf8"))).toEqual(result.json);
    expect((await f.cli("review", "show", "--run", run.run)).json).toMatchObject({ status: "incomplete", score: null });
    const again = await run.verify();
    expect(again.json.error.code).toBe("VERIFICATION_ALREADY_RECORDED");
  });

for (const mode of ["issue", "document", "standard", "responsibility", "scope"] as const)
  test(`準備した要求・規約・計画の変更は固定結果と現在版を区別する（${mode}）`, async () => {
    const f = await fixture();
    writeFileSync(join(f.repo, "AGENTS.md"), "# 規約\n公開名を保つ。\n"); git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "規約");
    const document = mode === "document" ? (await f.cli("doc", "create", "active.md", "--kind", "spec", "--issue", f.issue, "--body", "公開名valueで値2を返す。")).json : undefined;
    const planPath = mode === "responsibility" ? f.write("responsibility.json", { version: 1, assignments: [] }) : undefined;
    const run = await f.start([], planPath ? ["--responsibility-plan", planPath] : []);
    await run.explore();
    if (mode === "issue") await f.cli("issue", "update", f.issue, "--description", "値3を返す。");
    if (mode === "document") writeFileSync(document.path, "値3を返す。");
    if (mode === "standard") writeFileSync(join(f.repo, "AGENTS.md"), "# 規約\n別の公開名を使う。\n");
    if (mode === "responsibility") writeFileSync(planPath!, "{}");
    if (mode === "scope") await f.cli("issue", "plan", f.issue, "--step", "新しい要求の追加");
    const result = await run.verify();
    expect(result.json).toMatchObject({ status: "incomplete", score: null, fixedResult: { status: "completed", score: 5 }, currentSubmission: { eligible: false } });
    expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "REQUIREMENTS_CHANGED" }));
  });

for (const mode of ["worktree", "index", "untracked"] as const) test(`local対象の変化を検出し固定Gitの証拠は元のまま保存する（${mode}）`, async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "value.ts"), "export const value = 4;\n");
  writeFileSync(join(f.repo, "included.ts"), "export const included = 1;\n");
  const run = await f.start(["--local", "--untracked", "included.ts"]);
  await run.explore();
  const originalIndex = readFileSync(join(f.repo, ".git/index"));
  if (mode === "worktree") writeFileSync(join(f.repo, "value.ts"), "export const value = 5;\n");
  if (mode === "index") git(f.repo, "add", "value.ts");
  if (mode === "untracked") writeFileSync(join(f.repo, "included.ts"), "export const included = 2;\n");
  const expectedIndex = readFileSync(join(f.repo, ".git/index"));
  const result = await run.verify();
  expect(result.json).toMatchObject({ status: "incomplete", score: null, fixedResult: { score: 5 } });
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "TARGET_CHANGED" }));
  expect(result.json.coverage[0].implementation[0].quote).toBe("export const value = 4;");
  expect(readFileSync(join(f.repo, ".git/index"))).toEqual(expectedIndex);
  if (mode !== "index") expect(expectedIndex).toEqual(originalIndex);
});

for (const decision of ["optional", "false_positive", "unverified"] as const) test(`独立検証の採否を保持し任意改善で減点しない（${decision}）`, async () => {
  const f = await fixture(), run = await f.start();
  const annotate = (output: Output, input: Input) => {
    const candidate = addFinding(output, input);
    candidate.decision = decision;
    for (const row of output.requirements) { row.status = "satisfied"; row.findingIds = []; if (row.findingLinks) row.findingLinks = []; }
  };
  await run.explore(annotate);
  const result = await run.verify(annotate);
  expect(result.json.score).toBe(decision === "unverified" ? null : 5);
  expect(result.json.findings[0].decision).toBe(decision);
});

test("探索の必須候補を根拠不備の任意提案へ下げても合格にしない", async () => {
  const f = await fixture(), run = await f.start();
  await run.explore((output, input) => { addFinding(output, input); });
  const result = await run.verify((output, input) => {
    const candidate = addFinding(output, input); candidate.decision = "optional"; candidate.location.line = 999;
    for (const row of output.requirements) { row.status = "satisfied"; row.findingIds = []; row.findingLinks = []; }
  });
  expect(result.json.score).toBeNull();
  expect(result.json.findings[0].decision).toBe("unverified");
});

test("検証担当が原因を再統合しても両候補と最重影響を保持する", async () => {
  const f = await fixture(), run = await f.start();
  const candidates = (output: Output, input: Input) => {
    const first = addFinding(output, input);
    if (output.axis !== "standards") output.candidates.push({ ...structuredClone(first), id: "second", rootCause: "別の探索仮説", impact: { score: 1, description: "重大な状態破壊" } });
    if (output.axis === "verification") output.causeGroups = [{ id: "independently-judged", members: ["spec:wrong-value", "spec:second"], rationale: "固定コードを再読し同じ定義が両方を引き起こすと判断した" }];
  };
  await run.explore(candidates);
  const result = await run.verify(candidates);
  expect(result.json.score).toBe(1);
  expect(result.json.rootCauses).toHaveLength(1);
  expect(result.json.rootCauses[0]).toMatchObject({ id: "independently-judged", candidates: [{ id: "wrong-value" }, { id: "second" }] });
});

for (const mode of ["valid", "range", "combined", "substring", "missing"] as const) test(`SDK実版の固定引用を検査し自己申告や範囲指定で代替しない（${mode}）`, async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "package.lock"), 'version = "1.2.3"\n');
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "固定依存");
  const run = await f.start();
  const annotate = (output: Output, input: Input) => {
    const candidate = addFinding(output, input);
    candidate.sdk = { status: "verified", evidence: "固定依存を参照", version: mode === "range" ? "^1.2.3" : mode === "combined" ? "1.2.3 / 4.5.6" : mode === "substring" ? "1.2" : "1.2.3",
      source: mode === "missing" ? { path: "missing.lock", revision: "head", line: 1 } : { path: "package.lock", revision: "head", line: 1 } };
  };
  await run.explore(annotate);
  const result = await run.verify(annotate);
  expect(result.json.score).toBe(mode === "valid" ? 2 : null);
  if (mode !== "valid") expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "FINDING_UNVERIFIED" }));
});

for (const mode of ["delete_base", "delete_head_context", "delete_base_context", "delete_missing", "replace_head", "replace_base", "file_delete_base"] as const)
  test(`削除・置換の変更根拠を指摘位置と分離して照合する（${mode}）`, async () => {
    const f = await fixture("api.tsの公開関数valueは値2を返す。");
    writeFileSync(join(f.repo, "api.ts"), "export function value() {\n  let result = 3;\n  result = 2;\n  return result;\n}\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "正常な公開関数");
    const base = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: f.repo }).stdout.toString().trim();
    if (mode === "file_delete_base") git(f.repo, "rm", "api.ts");
    else writeFileSync(join(f.repo, "api.ts"), mode.startsWith("replace") ? "export function value() {\n  let result = 3;\n  result = 4;\n  return result;\n}\n" : "export function value() {\n  let result = 3;\n  return result;\n}\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "関数の回帰");
    const run = await f.start(["--base", base]);
    const rejected = ["delete_head_context", "delete_base_context", "delete_missing"].includes(mode);
    const annotate = (output: Output, input: Input) => {
      const candidate = addFinding(output, input);
      candidate.location = { path: "api.ts", revision: mode === "file_delete_base" ? "base" : "head", line: 3 };
      candidate.changeEvidence = mode === "delete_missing" ? null : { path: "api.ts", revision: ["delete_head_context", "replace_head"].includes(mode) ? "head" : "base", line: mode === "delete_base_context" ? 1 : 3 };
      for (const row of output.requirements) { row.implementation = [candidate.location]; for (const link of row.findingLinks ?? []) link.codeEvidence = [candidate.location]; }
    };
    await run.explore(annotate);
    const result = await run.verify(annotate);
    expect(result.json.score).toBe(rejected ? null : 2);
    expect(result.json.findings[0].decision).toBe(rejected ? "unverified" : "required");
  });

for (const mode of ["unrelated", "explicit", "unknown", "wrong_base_path"] as const) test(`既存問題と今回要求の関係を固定した基点証拠で検査する（${mode}）`, async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "legacy.ts"), "export const legacy = 1;\n"); git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "既存箇所");
  const base = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: f.repo }).stdout.toString().trim();
  writeFileSync(join(f.repo, "value.ts"), "export const value = 2; // 説明\n"); git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "今回の差分");
  const run = await f.start(["--base", base]);
  const annotate = (output: Output, input: Input) => {
    const candidate = addFinding(output, input);
    const unit = input.reviewUnits.find(unit => unit.axis === "spec")!;
    candidate.location = { path: "legacy.ts", revision: "head", line: 1 };
    candidate.baselineEvidence = { path: mode === "wrong_base_path" ? "value.ts" : "legacy.ts", revision: "base", line: 1 };
    candidate.origin = "pre_existing"; candidate.changeEvidence = null;
    candidate.scopeAssessment = mode === "unknown" ? null : { kind: mode === "explicit" ? "explicit_requirement" : "unrelated_existing", rationale: "今回の要求と既存契約の範囲を確認", references: [unit.reference, candidate.baselineEvidence] };
    if (mode === "unrelated" || mode === "wrong_base_path") {
      candidate.decision = "out_of_scope";
      for (const row of output.requirements) { row.status = "out_of_scope"; row.scopeEvidence = unit.reference; row.implementation = []; row.findingLinks = output.axis === "verification" ? [] : undefined; }
      if (output.axis === "verification") for (const row of output.requirements) row.findingLinks = [{ findingAxis: "spec", findingId: candidate.id, relation: "violation", observedBehavior: candidate.failure, requirementEvidence: unit.requiredAssessmentReferences, codeEvidence: [candidate.location],
        operation: { requirement: candidate.condition, candidate: candidate.condition, match: "same" }, condition: { requirement: "利用時", candidate: "利用時", match: "same" }, obligation: { requirement: candidate.expectedBehavior, candidate: candidate.expectedBehavior, match: "same" }, effectOfFix: "resolves_this_violation", rationale: "同じ既存違反へ対応する" }];
    } else for (const row of output.requirements) { row.implementation = [candidate.location]; for (const link of row.findingLinks ?? []) link.codeEvidence = [candidate.location]; }
  };
  await run.explore(annotate);
  const result = await run.verify(annotate);
  expect(result.json.score).toBe(mode === "unrelated" ? 5 : mode === "explicit" ? 2 : null);
  expect(result.json.findings[0].decision).toBe(mode === "wrong_base_path" ? "unverified" : mode === "unrelated" ? "out_of_scope" : "required");
});

for (const mode of ["valid", "satisfied", "other_line", "mixed"] as const) test(`固定した独立検査分担は探索と検証の対応が必要で理由を固定値へ復元する（${mode}）`, async () => {
  const f = await fixture("公開名valueで値2を返す。\n\n外部URLの現在の到達性を検査する。失敗を終了コードへ伝える。");
  const prepared = await f.cli("review", "prepare", "--repo", f.repo, "--base", f.base, "--issue", f.issue);
  const source = prepared.json.sources.find((source: { type: string }) => source.type === "issue");
  const path = f.write("responsibility.json", { version: 1, assignments: [{ sourceHash: source.hash, line: 3, owner: "automatic_check", rationale: "固定した分担理由" }] });
  const run = await f.start([], ["--responsibility-plan", path]);
  const annotate = (output: Output, input: Input) => {
    const unit = input.reviewUnits.find(unit => unit.reference.line === 3), row = output.requirements.find(row => row.id === unit?.id);
    if (!row || !unit) return;
    row.status = "out_of_scope"; row.scopeEvidence = unit.reference; row.implementation = []; row.rationale = `${output.axis}担当が言い換えた理由`;
    row.contentAssessment.kind = "independent_check"; row.contentAssessment.obligations = [];
    if (mode === "mixed" && output.axis === "spec") { row.contentAssessment.kind = "mixed"; row.contentAssessment.obligations = ["失敗を終了コードへ伝える。"]; }
    if (output.axis === "verification" && mode === "satisfied") { row.status = "satisfied"; row.implementation = [{ path: "value.ts", revision: "head", line: 1 }]; }
    if (output.axis === "verification" && mode === "other_line") row.scopeEvidence = { source: unit.reference.source, line: 1 };
  };
  await run.explore(annotate);
  const result = await run.verify(annotate);
  expect(result.json.score).toBe(mode === "valid" ? 5 : null);
  const row = result.json.coverage.find((row: { id: string }) => row.id.endsWith(":L3"));
  expect(row).toMatchObject({ rationale: "固定した分担理由", proposedRationale: "verification担当が言い換えた理由" });
});

test("事前分担で要求を除外した最終結果は限定範囲と残要求を示す", async () => {
  const f = await fixture("公開名valueで値2を返す。\n\n現在のURL到達性を検査する。");
  const prepared = await f.cli("review", "prepare", "--repo", f.repo, "--base", f.base, "--issue", f.issue);
  const source = prepared.json.sources.find((source: { type: string }) => source.type === "issue");
  const plan = f.write("limited.json", { version: 1, assignments: [{ sourceHash: source.hash, line: 3, owner: "automatic_check", rationale: "独立検査へ分担する" }] });
  const run = await f.start([], ["--responsibility-plan", plan]);
  const annotate = (output: Output, input: Input) => {
    const unit = input.reviewUnits.find(unit => unit.reference.line === 3), row = output.requirements.find(row => row.id === unit?.id);
    if (row && unit) { row.status = "out_of_scope"; row.scopeEvidence = unit.reference; row.implementation = []; row.contentAssessment.kind = "independent_check"; row.contentAssessment.obligations = []; }
  };
  await run.explore(annotate);
  const result = await run.verify(annotate);
  expect(result.json).toMatchObject({ status: "completed", score: 5, scope: { kind: "limited", excludedRequirements: [`issue:${f.issue}:L3`] } });
});

for (const mode of ["separate", "missing", "unknown"] as const) test(`段落の背景と別契約の違反を分離しても必須候補を消さない（${mode}）`, async () => {
  const f = await fixture("公開名valueで値2を返す。\n旧版は内部利用者だけが使っていた。"), run = await f.start();
  const annotate = (output: Output, input: Input) => {
    const candidate = addFinding(output, input);
    const unit = input.reviewUnits.find(unit => unit.reference.line === 2), row = output.requirements.find(row => row.id === unit?.id);
    if (!row || !unit) return;
    row.status = "context"; row.implementation = []; row.contentAssessment.kind = "background"; row.contentAssessment.obligations = [];
    if (output.axis === "verification" && mode !== "missing") row.findingLinks = [{ findingAxis: "spec", findingId: candidate.id, relation: "rejected", observedBehavior: candidate.failure,
      requirementEvidence: unit.requiredAssessmentReferences, codeEvidence: [candidate.location],
      operation: { requirement: "過去の利用状況", candidate: candidate.condition, match: "different" }, condition: { requirement: "旧版の利用時", candidate: "現在の利用時", match: mode === "unknown" ? "unknown" : "different" },
      obligation: { requirement: "追加義務なし", candidate: candidate.expectedBehavior, match: "different" }, effectOfFix: "unchanged", rationale: "現在の値を直しても過去の説明は変わらない" }];
  };
  await run.explore(annotate);
  const result = await run.verify(annotate);
  expect(result.json.score).toBe(mode === "separate" ? 2 : null);
  expect(result.json.findings[0].decision).toBe("required");
  expect(result.json.coverage[1].status).toBe(mode === "separate" ? "context" : "unverified");
});

for (const mode of ["valid", "wrong_axis", "behavior", "satisfied", "unknown"] as const)
  test(`他軸の要対応を要求へ対応付けても採否と両軸の結果を保持する（${mode}）`, async () => {
    const f = await fixture();
    writeFileSync(join(f.repo, "README.md"), "# 規約\n公開名valueを維持する。\n"); git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "規約");
    const run = await f.start();
    const annotate = (output: Output, input: Input) => {
      const candidate = addFinding(output, input);
      candidate.axis = "standards";
      output.candidates = output.axis === "spec" ? [] : [candidate];
      if (output.axis === "verification") output.causeGroups[0]!.members = ["standards:wrong-value"];
      for (const row of output.requirements) if (row.findingIds.length) {
        row.findingIds = ["standards:wrong-value"];
        for (const link of row.findingLinks ?? []) {
          link.findingAxis = "standards";
          if (mode === "wrong_axis") link.findingAxis = "spec";
          if (mode === "behavior") link.obligation.candidate = candidate.failure;
          if (mode === "satisfied") row.status = "satisfied";
          if (mode === "unknown") { row.status = "unverified"; row.findingIds = []; link.relation = "unresolved"; link.condition.match = "unknown"; }
        }
      }
    };
    await run.explore(annotate);
    const result = await run.verify(annotate);
    expect(result.json.score).toBe(mode === "valid" ? 2 : null);
    expect(result.json.findings[0]).toMatchObject({ axis: "standards", decision: "required" });
    expect(result.json.review).toEqual({ standards: "failed", spec: mode === "valid" ? "failed" : "incomplete" });
  });

test("探索が未完了なら検証入力は拒否し、検証の欠落も最終未完了として保存できる", async () => {
  const f = await fixture(), run = await f.start();
  expect((await run.explore(output => { output.completed = false; })).json.status).toBe("exploration_incomplete");
  const input = await f.cli("review", "input", "--run", run.run, "--phase", "verification");
  expect(input.json.error.code).toBe("EXPLORATION_REQUIRED");
  const recorded = await f.cli("review", "record", "--run", run.run, "--phase", "verification", "--agent", "second-reviewer");
  expect(recorded.json).toMatchObject({ status: "incomplete", score: null, agents: { exploration: { definition: "code-reviewer" }, verification: { definition: "second-reviewer" } } });
  expect(recorded.json.problems).toContainEqual(expect.objectContaining({ code: "STAGE_MISSING" }));
});

test("同じモデルの申告やモデル不明は実効モデルの証明にも停止条件にもしない", async () => {
  const f = await fixture(), run = await f.start();
  const paths: string[] = [];
  for (const phase of ["standards", "spec"] as const) paths.push(`--${phase}`, f.write(`${phase}.json`, stageOutput(await run.input(phase))));
  const explored = await f.cli("review", "record", "--run", run.run, "--phase", "exploration", ...paths, "--agent", "exploring-reviewer",
    "--model-claim", "same-model", "--model-claim-source", "担当が読んだomp設定");
  expect(explored.exitCode).toBe(0);
  const result = await run.verify(() => {}, ["--model-claim", "same-model", "--model-claim-source", "検証担当の初期設定"]);
  expect(result.json).toMatchObject({ status: "completed", score: 5, agents: {
    exploration: { definition: "exploring-reviewer", modelClaim: { value: "same-model", source: "担当が読んだomp設定", status: "declared" } },
    verification: { definition: "code-reviewer", modelClaim: { value: "same-model", source: "検証担当の初期設定", status: "declared" } },
  } });
});

test("通常報告は任意提案を省き固定対象と要求対応と現在版の提出可否を返す", async () => {
  const f = await fixture(), run = await f.start();
  const annotate = (output: Output, input: Input) => {
    const candidate = addFinding(output, input); candidate.id = "PRIVATE_OPTIONAL_AUDIT"; candidate.decision = "optional";
    if (output.axis === "verification") output.causeGroups[0]!.members = ["spec:PRIVATE_OPTIONAL_AUDIT"];
    for (const row of output.requirements) { row.status = "satisfied"; row.findingIds = []; if (row.findingLinks) row.findingLinks = []; }
  };
  await run.explore(annotate);
  const input = await run.input("verification"), output = stageOutput(input); annotate(output, input);
  const result = await runNod(["review", "record", "--run", run.run, "--phase", "verification", "--output", f.write("text.json", output), "--agent", "code-reviewer"], { cwd: f.repo, db: f.db, env: f.env });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("5/5");
  expect(result.stdout).toContain(`要求 issue:${f.issue}:L1: satisfied`);
  expect(result.stdout).toContain("現在版への提出: 固定した確認範囲で可");
  expect(result.stdout).not.toContain("PRIVATE_OPTIONAL_AUDIT");
  expect(JSON.parse(readFileSync(join(run.prepared.artifactPath, "../execution.json"), "utf8")).findings[0].id).toBe("PRIVATE_OPTIONAL_AUDIT");
});

for (const mode of ["missing", "duplicate"] as const)
  test(`検証の担当要求ID欠落と重複は採点前の形式検査で拒否し未完了保存する（${mode}）`, async () => {
    const f = await fixture("公開名valueで値2を返す。\n\n公開名valueを維持する。"), run = await f.start();
    expect((await run.explore()).exitCode).toBe(0);
    const invalidate = (output: Output) => {
      expect(output.requirements).toHaveLength(2);
      output.requirements = mode === "missing" ? [] : [output.requirements[0]!, { ...output.requirements[0]!, evidence: "異なる証拠文でも同じ要求IDの重複" }];
    };
    const checked = await run.verify(invalidate, ["--check"]);
    expect(checked.exitCode).toBe(1);
    expect(checked.json).toMatchObject({ saved: false, stages: [{ phase: "verification", status: "incomplete", problem: { code: "OUTPUT_INVALID" } }] });
    expect(existsSync(join(run.prepared.artifactPath, "../execution.json"))).toBe(false);
    const recorded = await run.verify(invalidate);
    expect(recorded.exitCode).toBe(1);
    expect(recorded.json).toMatchObject({ status: "incomplete", score: null, reviewCompleted: false });
    expect(recorded.json.stages[2]).toMatchObject({ phase: "verification", status: "incomplete", problem: { code: "OUTPUT_INVALID" } });
    expect(recorded.json.coverage).toEqual([]);
    expect(recorded.json.findings).toEqual([]);
    expect(JSON.parse(readFileSync(recorded.json.artifactPath, "utf8"))).toEqual(recorded.json);
  });
