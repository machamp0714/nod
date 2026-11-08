import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

function output(repo: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd: repo });
  expect(p.exitCode).toBe(0);
  return p.stdout.toString();
}

async function fixture() {
  const repo = makeRepo();
  const db = tempDb();
  registerRepo(db, repo, "EX");
  writeFileSync(join(repo, "AGENTS.md"), "# 規約\nコメントは日本語で書く。\n参考: 過去の経緯。\n");
  writeFileSync(join(repo, "value.ts"), "export const value = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "基点");
  const base = output(repo, "rev-parse", "HEAD").trim();
  writeFileSync(join(repo, "value.ts"), "export const value = 2;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "対象");
  // 固定後の元作業を変えないことを確かめるため、staged・unstagedの未コミット変更を置く。
  writeFileSync(join(repo, "value.ts"), "export const value = 3;\n");
  git(repo, "add", "value.ts");
  writeFileSync(join(repo, "value.ts"), "export const value = 4;\n");
  const env = { NOD_DOCS_DIR: tempDir("review-docs-") };
  const nod = (...args: string[]) => runNod(args, { cwd: repo, db, env });
  const cli = (...args: string[]) => nod(...args, "--json");
  const issue = (await cli("issue", "create", "値を変更する", "--description", "値を2にする。\n公開名valueを維持する。")).json.id;
  const prepare = () => cli("review", "prepare", "--repo", repo, "--base", base, "--issue", issue);
  // 確認自体が元indexを書き換えないよう、statusは任意のロックを取らずに読む。
  const original = () => ({ index: readFileSync(join(repo, ".git/index")), head: output(repo, "rev-parse", "HEAD"), status: output(repo, "--no-optional-locks", "status", "--porcelain=v1", "-uall"),
    diff: output(repo, "--no-optional-locks", "diff"), staged: output(repo, "--no-optional-locks", "diff", "--cached"), file: readFileSync(join(repo, "value.ts"), "utf8") });
  return { repo, db, env, nod, cli, issue, base, prepare, original };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

// 担当エージェントが入力ファイルを読み、schemaどおりのformat=3出力を書く想定の最小の正しい出力。
function explorationOutput(input: any, overrides: Record<string, unknown> = {}) {
  const requirements = input.assignedRequirementIds.map((id: string) => {
    const unit = input.reviewUnits.find((u: any) => u.id === id);
    return { id, status: "satisfied", contentAssessment: { kind: "obligation", obligations: [], references: unit.requiredAssessmentReferences, rationale: "固定資料の段落を読んだ" },
      implementation: [{ path: "value.ts", revision: "head", line: 1 }], verification: { method: "inspection", detail: "固定snapshotを読んだ", recordIds: [] },
      evidence: "value.tsが値2を返す", findingIds: [], scopeEvidence: null, rationale: "差分と要求を照合した" };
  });
  return { format: 3, target: input.target.hash, axis: input.phase, completed: true, candidates: [], requirements, consistency: { status: "consistent", evidence: "矛盾なし" }, causeGroups: [], ...overrides };
}

function specCandidate(issue: string) {
  return { id: "c1", axis: "spec", location: { path: "value.ts", revision: "head", line: 1 }, contract: { source: `issue:${issue}`, line: 1 },
    condition: "valueを読む", expectedBehavior: "値2を返す", failure: "値2以外を返す", impact: { score: 2, description: "値の取得が期待と異なる" },
    evidence: { kind: "static", detail: "value.tsを読んだ", recordIds: [] }, reproduction: "valueを参照する", rootCause: "値の誤り", decision: "unverified",
    rationale: "探索の候補", defense: "なし", sdk: { status: "not_applicable", evidence: "SDKを使わない", version: null, source: null },
    scopeEvidence: null, needsSpecificationDecision: false, changeEvidence: { path: "value.ts", revision: "head", line: 1 }, origin: "introduced", baselineEvidence: null,
    responsibility: { owner: "review", rationale: "意味の確認", references: [{ source: `issue:${issue}`, line: 1 }] }, scopeAssessment: null };
}

async function planned(f: Fixture, ...planArgs: string[]) {
  const prepared = await f.prepare();
  expect(prepared.exitCode, prepared.stdout + prepared.stderr).toBe(0);
  const plan = await f.cli("review", "plan", "--run", prepared.json.runId, ...planArgs);
  expect(plan.exitCode, plan.stdout + plan.stderr).toBe(0);
  const inputs: Record<string, any> = {};
  for (const phase of ["standards", "spec"]) {
    const located = await f.cli("review", "input", "--run", prepared.json.runId, "--phase", phase);
    expect(located.exitCode, located.stdout + located.stderr).toBe(0);
    inputs[phase] = JSON.parse(readFileSync(located.json.inputPath, "utf8"));
  }
  return { prepared: prepared.json, plan: plan.json, inputs };
}

function writeJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

test("準備で対象・要求・規約と読取専用snapshotを固定し、計画前の工程入力と探索記録を拒否する", async () => {
  const f = await fixture();
  const before = f.original();
  const prepared = await f.prepare();
  expect(prepared.exitCode, prepared.stdout + prepared.stderr).toBe(0);
  expect(prepared.json).toMatchObject({ status: "prepared", score: null, review: { standards: "not_started", spec: "not_started" } });
  expect(prepared.json.remaining.join("\n")).toContain("計画");
  expect(prepared.json.standardScopeTemplatePath).toBeString();
  const context = prepared.json.context;
  expect(readFileSync(join(context.path, "value.ts"), "utf8")).toBe("export const value = 2;\n");
  expect(statSync(join(context.path, "value.ts")).mode & 0o222).toBe(0);
  expect(readFileSync(join(context.path, context.baseCode.directory, "value.ts"), "utf8")).toBe("export const value = 1;\n");
  expect(context.code.paths).toContain("value.ts");
  expect(context.sourceFiles.map((s: any) => s.source)).toEqual(prepared.json.sources.map((s: any) => `${s.type}:${s.id}`));
  for (const [i, file] of context.sourceFiles.entries()) expect(readFileSync(join(context.path, file.path), "utf8")).toBe(prepared.json.sources[i].content);

  const input = await f.cli("review", "input", "--run", prepared.json.runId, "--phase", "standards");
  expect(input.exitCode).toBe(1);
  expect(input.json.error.code).toBe("PLAN_REQUIRED");
  const empty = writeJson(tempDir("review-output-"), "empty.json", {});
  const record = await f.cli("review", "record", "--run", prepared.json.runId, "--phase", "exploration", "--standards", empty, "--spec", empty, "--agent", "code-reviewer");
  expect(record.exitCode).toBe(1);
  expect(record.json.error.code).toBe("PLAN_REQUIRED");
  expect(existsSync(join(prepared.json.artifactPath, "../exploration.json"))).toBe(false);

  const shown = await f.cli("review", "show", "--run", prepared.json.runId);
  expect(shown.exitCode).toBe(0);
  expect(shown.json).toMatchObject({ runId: prepared.json.runId, status: "prepared", score: null, reviewCompleted: false });
  expect(f.original()).toEqual(before);
});

test("計画で規約適用計画と責務計画を固定し、工程入力とschemaをファイルに保存して再計画を拒否する", async () => {
  const f = await fixture();
  const before = f.original();
  const prepared = (await f.prepare()).json;
  const dir = tempDir("review-plan-");
  const unresolved = await f.cli("review", "plan", "--run", prepared.runId, "--scope-plan", prepared.standardScopeTemplatePath);
  expect(unresolved.exitCode).toBe(1);
  expect(unresolved.json.error.code).toBe("SCOPE_UNVERIFIED");
  expect((await f.cli("review", "show", "--run", prepared.runId)).json.status).toBe("prepared");

  const standard = prepared.sources.find((s: any) => s.type === "standard");
  const issue = prepared.sources.find((s: any) => s.type === "issue");
  const scope = writeJson(dir, "scope.json", { version: 1, standards: [{ source: `standard:${standard.id}`, hash: standard.hash, ranges: [
    { start: 1, end: 2, kind: "required", rationale: "差分のコメントに適用する" }, { start: 3, end: 4, kind: "reference", rationale: "経緯の説明" }] }] });
  const responsibility = writeJson(dir, "responsibility.json", { version: 1, assignments: [{ sourceHash: issue.hash, line: 2, owner: "automatic_check", rationale: "固定した分担理由" }] });
  const plan = await f.cli("review", "plan", "--run", prepared.runId, "--scope-plan", scope, "--responsibility-plan", responsibility);
  expect(plan.exitCode, plan.stdout + plan.stderr).toBe(0);
  expect(plan.json).toMatchObject({ runId: prepared.runId, status: "planned", score: null, target: { hash: prepared.target.hash },
    standardScope: { hash: expect.stringMatching(/^[a-f0-9]{64}$/) }, responsibility: { assignments: [expect.objectContaining({ line: 2 })] } });

  const located = await f.cli("review", "input", "--run", prepared.runId, "--phase", "standards");
  expect(located.exitCode).toBe(0);
  expect(Object.keys(located.json).sort()).toEqual(["inputPath", "phase", "runId", "schemaPath"]);
  expect(located.stdout).not.toContain("reviewUnits");
  const input = JSON.parse(readFileSync(located.json.inputPath, "utf8"));
  expect(input).toMatchObject({ phase: "standards", assignedRequirementIds: [`standard:${standard.id}:L2`], target: { hash: prepared.target.hash } });
  expect(input.shard).toBeUndefined();
  expect(input.instructions).not.toContain("cwd");
  expect(readFileSync(join(input.contextPath, "value.ts"), "utf8")).toBe("export const value = 2;\n");
  expect(readFileSync(join(input.contextPath, input.sources.find((s: any) => s.source === `standard:${standard.id}`).path), "utf8")).toBe(standard.content);
  const schema = JSON.parse(readFileSync(located.json.schemaPath, "utf8"));
  expect(schema.properties).toMatchObject({ format: { const: 3 }, target: { const: prepared.target.hash }, axis: { const: "standards" } });
  const spec = JSON.parse(readFileSync((await f.cli("review", "input", "--run", prepared.runId, "--phase", "spec")).json.inputPath, "utf8"));
  expect(spec.assignedRequirementIds).toEqual([`issue:${f.issue}:L1`, `issue:${f.issue}:L2`]);
  expect(spec.responsibility.assignments).toEqual([{ source: `issue:${f.issue}`, line: 2, owner: "automatic_check", rationale: "固定した分担理由" }]);

  const saved = readFileSync(join(prepared.artifactPath, "../plan.json"), "utf8");
  const again = await f.cli("review", "plan", "--run", prepared.runId);
  expect(again.exitCode).toBe(1);
  expect(again.json.error.code).toBe("PLAN_ALREADY_FIXED");
  expect(readFileSync(join(prepared.artifactPath, "../plan.json"), "utf8")).toBe(saved);
  expect((await f.cli("review", "show", "--run", prepared.runId)).json).toMatchObject({ status: "planned", score: null, reviewCompleted: false });
  expect(f.original()).toEqual(before);
});

test("探索の2工程を形式検査して採点せずに保存し、レビュー完了とは表示しない", async () => {
  const f = await fixture();
  const before = f.original();
  const dir = tempDir("review-plan-");
  const prepared0 = (await f.prepare()).json;
  // 1つ目の準備は使わない。別の実行IDで新しく準備し、前の記録と混ざらないことも確かめる。
  expect(prepared0.status).toBe("prepared");
  const issueSource = () => JSON.parse(readFileSync(prepared0.artifactPath, "utf8")).sources.find((s: any) => s.type === "issue");
  const responsibility = writeJson(dir, "responsibility.json", { version: 1, assignments: [{ sourceHash: issueSource().hash, line: 2, owner: "automatic_check", rationale: "固定した分担理由" }] });
  const { prepared, inputs } = await planned(f, "--responsibility-plan", responsibility);
  expect(prepared.runId).not.toBe(prepared0.runId);
  const out = tempDir("review-output-");
  const spec = explorationOutput(inputs.spec, { candidates: [specCandidate(f.issue)] });
  spec.requirements[1] = { ...spec.requirements[1], status: "out_of_scope", scopeEvidence: { source: `issue:${f.issue}`, line: 2 }, rationale: "モデルの文面" };
  const standards = writeJson(out, "standards.json", explorationOutput(inputs.standards));
  const specPath = writeJson(out, "spec.json", spec);
  const record = await f.cli("review", "record", "--run", prepared.runId, "--phase", "exploration", "--standards", standards, "--spec", specPath,
    "--agent", "code-reviewer", "--model-claim", "claude-opus-5-5", "--model-claim-source", "omp設定の@reviewロール");
  expect(record.exitCode, record.stdout + record.stderr).toBe(0);
  expect(record.json).toMatchObject({ runId: prepared.runId, status: "explored", score: null, reviewCompleted: false,
    target: { hash: prepared.target.hash, headSha: prepared.target.headSha }, review: { standards: "explored", spec: "explored" },
    agents: { exploration: { definition: "code-reviewer", modelClaim: { value: "claude-opus-5-5", source: "omp設定の@reviewロール", status: "declared" } } } });
  expect(record.json.problems).toEqual([]);
  expect(record.json.remaining.join("\n")).toContain("候補検証");
  expect(record.json.stages.map((s: any) => [s.phase, s.status])).toEqual([["standards", "completed"], ["spec", "completed"]]);
  const issue = prepared.sources.find((s: any) => s.type === "issue");
  const [stored] = record.json.stages[1].output.candidates;
  expect(stored.contract).toEqual({ source: `issue:${f.issue}`, line: 1, hash: issue.hash, quote: "値を2にする。" });
  const fixed = record.json.stages[1].output.requirements.find((r: any) => r.id === `issue:${f.issue}:L2`);
  expect(fixed).toMatchObject({ rationale: "固定した分担理由", proposedRationale: "モデルの文面", requirement: "公開名valueを維持する。" });
  expect(fixed.contentAssessment.references).toContainEqual({ source: `issue:${f.issue}`, line: 2, hash: issue.hash, quote: "公開名valueを維持する。" });
  expect(JSON.parse(readFileSync(record.json.artifactPath, "utf8"))).toEqual(record.json);
  expect(record.json.artifactPath).toBe(join(prepared.artifactPath, "../exploration.json"));

  const text = await f.nod("review", "show", "--run", prepared.runId);
  expect(text.exitCode).toBe(0);
  expect(text.stdout).toContain("explored");
  expect(text.stdout).toContain("レビュー未完了");
  expect(text.stdout).toContain("点数なし");
  expect(text.stdout).not.toContain("合格");
  const shown = await f.cli("review", "show", "--run", prepared.runId);
  expect(shown.json).toMatchObject({ status: "explored", score: null, reviewCompleted: false, agents: { exploration: { definition: "code-reviewer" } } });

  const again = await f.cli("review", "record", "--run", prepared.runId, "--phase", "exploration", "--standards", standards, "--spec", specPath, "--agent", "code-reviewer");
  expect(again.exitCode).toBe(1);
  expect(again.json.error.code).toBe("EXPLORATION_ALREADY_RECORDED");
  expect(JSON.parse(readFileSync(record.json.artifactPath, "utf8"))).toEqual(record.json);
  expect(f.original()).toEqual(before);
});

test("CLIの探索と独立検証の2段記録から固定版を5点で最終保存する", async () => {
  const f = await fixture();
  const before = f.original();
  const { prepared, inputs } = await planned(f);
  const dir = tempDir("review-verification-");
  const outputs = ["standards", "spec"].map(phase => {
    const result = explorationOutput(inputs[phase]);
    for (const row of result.requirements) {
      row.contentAssessment.obligations = [inputs[phase].reviewUnits.find((unit: { id: string; requirement: string }) => unit.id === row.id).requirement];
    }
    return result;
  });
  const exploration = await f.cli("review", "record", "--run", prepared.runId, "--phase", "exploration",
    "--standards", writeJson(dir, "standards.json", outputs[0]), "--spec", writeJson(dir, "spec.json", outputs[1]), "--agent", "code-reviewer");
  expect(exploration.exitCode, exploration.stdout + exploration.stderr).toBe(0);
  expect(exploration.json).toMatchObject({ status: "explored", score: null, reviewCompleted: false });
  const located = await f.cli("review", "input", "--run", prepared.runId, "--phase", "verification");
  expect(located.exitCode, located.stdout + located.stderr).toBe(0);
  const verification = { format: 3, target: prepared.target.hash, axis: "verification", completed: true, candidates: [],
    requirements: outputs.flatMap(result => result.requirements.map((row: Record<string, unknown>) => ({ ...row, findingLinks: [] }))),
    consistency: { status: "consistent", evidence: "固定要求を独立して読み直し矛盾がない" }, causeGroups: [] };
  const recorded = await f.cli("review", "record", "--run", prepared.runId, "--phase", "verification",
    "--output", writeJson(dir, "verification.json", verification), "--agent", "code-reviewer");
  expect(recorded.exitCode, recorded.stdout + recorded.stderr).toBe(0);
  expect(recorded.json).toMatchObject({ runId: prepared.runId, status: "completed", score: 5, reviewCompleted: true,
    target: { hash: prepared.target.hash }, review: { standards: "passed", spec: "passed" },
    agents: { exploration: { definition: "code-reviewer" }, verification: { definition: "code-reviewer",
      modelClaim: { value: null, source: null, status: "unverified" } } } });
  expect(recorded.json.problems).toEqual([]);
  expect(recorded.json.artifactPath).toBe(join(prepared.artifactPath, "../execution.json"));
  expect(JSON.parse(readFileSync(recorded.json.artifactPath, "utf8"))).toEqual(recorded.json);
  expect((await f.cli("review", "show", "--run", prepared.runId)).json).toMatchObject({ status: "completed", score: 5, reviewCompleted: true });
  expect(f.original()).toEqual(before);
});

const broken: [string, (inputs: Record<string, any>, out: string, issue: string) => string[], string, "standards" | "spec"][] = [
  ["Spec出力の指定なし", (i, out) => ["--standards", writeJson(out, "s.json", explorationOutput(i.standards))], "STAGE_MISSING", "spec"],
  ["存在しない出力ファイル", (i, out) => ["--standards", writeJson(out, "s.json", explorationOutput(i.standards)), "--spec", join(out, "missing.json")], "STAGE_MISSING", "spec"],
  ["JSONとして読めない出力", (i, out) => ["--standards", writeJson(out, "s.json", "{\"format\": 3,"), "--spec", writeJson(out, "p.json", explorationOutput(i.spec))], "OUTPUT_INVALID", "standards"],
  ["schemaの必須項目が欠けた要求", (i, out) => {
    const spec = explorationOutput(i.spec);
    delete (spec.requirements[0] as any).verification;
    return ["--standards", writeJson(out, "s.json", explorationOutput(i.standards)), "--spec", writeJson(out, "p.json", spec)];
  }, "OUTPUT_INVALID", "spec"],
  ["別工程の出力", (i, out) => ["--standards", writeJson(out, "s.json", explorationOutput(i.spec)), "--spec", writeJson(out, "p.json", explorationOutput(i.spec))], "OUTPUT_INVALID", "standards"],
  ["型なしの資料ID", (i, out, issue) => {
    const spec = explorationOutput(i.spec);
    spec.requirements[0].implementation = [{ source: issue, line: 1 }];
    return ["--standards", writeJson(out, "s.json", explorationOutput(i.standards)), "--spec", writeJson(out, "p.json", spec)];
  }, "OUTPUT_INVALID", "spec"],
  ["固定対象と異なる対象hash", (i, out) => ["--standards", writeJson(out, "s.json", explorationOutput(i.standards, { target: "0".repeat(64) })), "--spec", writeJson(out, "p.json", explorationOutput(i.spec))], "STALE_EVIDENCE", "standards"],
  ["担当が完了できなかった探索", (i, out) => ["--standards", writeJson(out, "s.json", explorationOutput(i.standards)), "--spec", writeJson(out, "p.json", explorationOutput(i.spec, { completed: false }))], "STAGE_INCOMPLETE", "spec"],
];

for (const [name, args, code, phase] of broken) test(`探索の${name}は点数なしの未完了として保存する`, async () => {
  const f = await fixture();
  const before = f.original();
  const { prepared, inputs } = await planned(f);
  const record = await f.cli("review", "record", "--run", prepared.runId, "--phase", "exploration", ...args(inputs, tempDir("review-output-"), f.issue), "--agent", "code-reviewer");
  expect(record.exitCode).toBe(1);
  expect(record.json).toMatchObject({ status: "exploration_incomplete", score: null, reviewCompleted: false,
    agents: { exploration: { definition: "code-reviewer", modelClaim: { value: null, source: null, status: "unverified" } } } });
  expect(record.json.review[phase]).toBe("incomplete");
  const stage = record.json.stages.find((s: any) => s.phase === phase);
  expect(stage).toMatchObject({ status: "incomplete", problem: { code } });
  expect(record.json.problems).toContainEqual(expect.objectContaining({ code }));
  if (code === "STAGE_INCOMPLETE") expect(stage.output.completed).toBe(false);
  expect(JSON.parse(readFileSync(record.json.artifactPath, "utf8"))).toEqual(record.json);
  const shown = await f.nod("review", "show", "--run", prepared.runId);
  expect(shown.stdout).toContain("exploration_incomplete");
  expect(shown.stdout).toContain("レビュー未完了");
  expect(f.original()).toEqual(before);
});

test("--checkは同じ形式検査だけを行い、探索記録を保存しない", async () => {
  const f = await fixture();
  const { prepared, inputs } = await planned(f);
  const out = tempDir("review-output-");
  const invalid = explorationOutput(inputs.spec);
  invalid.requirements[0].implementation = [{ source: "document:unknown", line: 1 }];
  const checked = await f.cli("review", "record", "--run", prepared.runId, "--phase", "exploration", "--spec", writeJson(out, "bad.json", invalid), "--agent", "code-reviewer", "--check");
  expect(checked.exitCode).toBe(1);
  expect(checked.json).toMatchObject({ runId: prepared.runId, saved: false });
  expect(checked.json.stages).toEqual([expect.objectContaining({ phase: "spec", status: "incomplete", problem: expect.objectContaining({ code: "OUTPUT_INVALID" }) })]);
  const exploration = join(prepared.artifactPath, "../exploration.json");
  expect(existsSync(exploration)).toBe(false);
  const standards = writeJson(out, "s.json", explorationOutput(inputs.standards));
  const spec = writeJson(out, "p.json", explorationOutput(inputs.spec));
  const valid = await f.cli("review", "record", "--run", prepared.runId, "--phase", "exploration", "--standards", standards, "--spec", spec, "--agent", "code-reviewer", "--check");
  expect(valid.exitCode, valid.stdout + valid.stderr).toBe(0);
  expect(valid.json.stages.map((s: any) => s.status)).toEqual(["completed", "completed"]);
  expect(existsSync(exploration)).toBe(false);
  expect((await f.cli("review", "show", "--run", prepared.runId)).json.status).toBe("planned");
  const record = await f.cli("review", "record", "--run", prepared.runId, "--phase", "exploration", "--standards", standards, "--spec", spec, "--agent", "code-reviewer");
  expect(record.json.status).toBe("explored");
});

test("存在しない実行IDと準備未完了の実行には計画を固定しない", async () => {
  const f = await fixture();
  const missing = await f.cli("review", "plan", "--run", "00000000-0000-4000-8000-000000000000");
  expect(missing.json.error.code).toBe("RUN_NOT_FOUND");
  const traversal = await f.cli("review", "show", "--run", "../reviews");
  expect(traversal.json.error.code).toBe("RUN_NOT_FOUND");
  const failed = await f.cli("review", "prepare", "--repo", f.repo, "--base", "HEAD", "--issue", f.issue);
  expect(failed.json.status).toBe("incomplete");
  const plan = await f.cli("review", "plan", "--run", failed.json.runId);
  expect(plan.exitCode).toBe(1);
  expect(plan.json.error.code).toBe("RUN_NOT_PREPARED");
  expect((await f.cli("review", "show", "--run", failed.json.runId)).json).toMatchObject({ status: "incomplete", score: null, reviewCompleted: false });
});

for (const phase of ["standards", "spec"] as const) for (const mode of ["missing", "duplicate"] as const)
  test(`探索の担当要求IDは全件を1回ずつ返し欠落と重複を形式不正にする（${phase}/${mode}）`, async () => {
    const f = await fixture();
    const { prepared, inputs } = await planned(f);
    const out = tempDir("review-coverage-");
    const invalid = explorationOutput(inputs[phase]);
    expect(invalid.requirements.length).toBeGreaterThanOrEqual(2);
    invalid.requirements = mode === "missing" ? [] : [invalid.requirements[0], { ...invalid.requirements[0], evidence: "異なる証拠文でも同じ要求IDの重複" }];
    const bad = writeJson(out, "invalid.json", invalid);
    const checked = await f.cli("review", "record", "--run", prepared.runId, "--phase", "exploration", `--${phase}`, bad, "--agent", "code-reviewer", "--check");
    expect(checked.exitCode).toBe(1);
    expect(checked.json).toMatchObject({ saved: false, stages: [{ phase, status: "incomplete", problem: { code: "OUTPUT_INVALID" } }] });
    expect(existsSync(join(prepared.artifactPath, "../exploration.json"))).toBe(false);
    const paths = ["standards", "spec"].flatMap(axis => [`--${axis}`, axis === phase ? bad : writeJson(out, `${axis}.json`, explorationOutput(inputs[axis]))]);
    const recorded = await f.cli("review", "record", "--run", prepared.runId, "--phase", "exploration", ...paths, "--agent", "code-reviewer");
    expect(recorded.exitCode).toBe(1);
    expect(recorded.json).toMatchObject({ status: "exploration_incomplete", score: null, reviewCompleted: false });
    expect(recorded.json.stages.find((stage: { phase: string }) => stage.phase === phase)).toMatchObject({ status: "incomplete", problem: { code: "OUTPUT_INVALID" } });
    expect(JSON.parse(readFileSync(recorded.json.artifactPath, "utf8"))).toEqual(recorded.json);
  });
