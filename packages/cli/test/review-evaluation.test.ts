import { expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

async function fixture() {
  const repo = makeRepo(), db = tempDb(), dir = tempDir("evaluation-");
  registerRepo(db, repo, "EVAL");
  writeFileSync(join(repo, "value.ts"), "export const value = 2;\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "評価対象");
  const sha = (ref: string) => Bun.spawnSync(["git", "-C", repo, "rev-parse", ref]).stdout.toString().trim();
  const document = join(dir, "requirement.md");
  writeFileSync(document, "公開名valueで値2を返す。\n");
  const env = { NOD_DOCS_DIR: tempDir(), PATH: `${dir}:${process.env.PATH}` };
  const cli = (...args: string[]) => runNod(["review", "evaluation", ...args, "--json"], { cwd: repo, db, env });
  const manifest = join(dir, "manifest.json"), dataset = join(dir, "frozen.json");
  const entry = { id: "case-1", repoKey: "sample", pr: 1, input: { repo, base: sha("HEAD^"), head: sha("HEAD"), document }, requirementEvidence: "当時の要求文書", provenance: ["fixture:known-input"], unavailableReason: null as string | null,
    oracle: [{ id: "known", kind: "positive", major: true, cause: "公開値の誤り", impact: "主要機能が停止", evidence: "固定したテスト用正解" }] };
  const freeze = async (cases = [entry]) => { writeFileSync(manifest, JSON.stringify({ version: 1, purpose: "development", selection: "既知入力によるCLI契約検証", cases })); return cli("freeze", "--manifest", manifest, "--out", dataset); };
  return { repo, db, dir, cli, manifest, dataset, entry, freeze };
}

test("評価集合を凍結し、上書きと凍結後の変更を拒否する", async () => {
  const f = await fixture();
  const result = await f.freeze();
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.json).toMatchObject({ status: "frozen", cases: 1, purpose: "development" });
  expect((await f.freeze()).exitCode).toBe(1);
  const frozen = JSON.parse(readFileSync(f.dataset, "utf8"));
  frozen.data.cases[0].oracle[0].major = false;
  writeFileSync(f.dataset, JSON.stringify(frozen));
  const report = await f.cli("report", "--dataset", f.dataset);
  expect(report.exitCode).toBe(1);
  expect(report.stdout + report.stderr).toContain("凍結");
});

function model(f: Awaited<ReturnType<typeof fixture>>, variant = "required") {
  writeFileSync(join(f.dir, "claude"), `#!/usr/bin/env bun
    if (process.argv.includes("status")) console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }));
    else {
      const input = JSON.parse(await Bun.stdin.text());
      if (JSON.stringify(input).includes("固定したテスト用正解")) throw new Error("正解が漏洩");
      const requirements = input.reviewUnits.filter(u => input.phase === "verification" || u.axis === input.phase).map(u => ({ ...u, target: input.target.hash, status: "satisfied", implementation: [{ path: "value.ts", revision: "head", line: 1 }], verification: { method: "inspection", detail: "公開値の契約確認" }, evidence: "value.tsのexportを確認" }));
      const unit = input.reviewUnits.find(u => u.axis === "spec");
      const candidate = { id: "value", axis: "spec", target: input.target.hash, location: { path: "value.ts", revision: "head", line: 1 }, contract: unit.reference, condition: "import時", failure: "値が違う", impact: { score: 2, description: "主要機能停止" }, evidence: { kind: "static", detail: "右辺を確認" }, reproduction: "importして比較", rootCause: "value", decision: ${JSON.stringify(variant)}, rationale: "契約照合", defense: "防御なし", sdk: { status: "not_applicable", evidence: "定数のみ" }, needsSpecificationDecision: false };
      const candidates = ${JSON.stringify(variant)} === "none" || input.phase === "standards" ? [] : [candidate, { ...candidate, id: "duplicate" }];
      console.log(JSON.stringify({ type: "result", subtype: "success", modelUsage: { "claude-review-effective": { inputTokens: 10 } }, usage: { input_tokens: 10 }, structured_output: { completed: true, axis: input.phase, candidates, requirements, consistency: { status: "consistent", evidence: "要求間を確認" } } }));
    }
  `); chmodSync(join(f.dir, "claude"), 0o755);
}
async function replay(f: Awaited<ReturnType<typeof fixture>>, id = "case-1") {
  return f.cli("replay", "--dataset", f.dataset, "--case", id, "--provider", "claude", "--review-model", "claude-review-exact", "--implementation-models", "gpt-implementation-exact", "--extra-usage-disabled");
}

test("共通入口の初回だけを保存し、重複指摘と判定待ちを隠さない", async () => {
  const f = await fixture(); await f.freeze(); model(f);
  const run = await replay(f);
  expect(run.exitCode, run.stdout + run.stderr).toBe(0);
  expect(run.json, readFileSync(run.json.recordPath, "utf8")).toMatchObject({ status: "recorded", reviewStatus: "completed", score: 2 });
  const record = JSON.parse(readFileSync(run.json.recordPath, "utf8"));
  expect(record.data.initial.findings).toHaveLength(2);
  expect(record.data.initial.execution.stages[0].effectiveModels).toEqual(["claude-review-effective"]);
  expect(record.data.initial.execution.stages[0].usage.input_tokens).toBe(10);
  const report = await f.cli("report", "--dataset", f.dataset);
  expect(report.json).toMatchObject({ status: "pending", acceptance: "not_evaluated", metrics: { prs: 1, required: 1, valid: 0, pending: 1, precision: 0, triageMedianMinutes: null, triageUnknown: 1 }, regression: { majorTotal: 1, majorDetected: 0, majorUnknown: 1 } });
});

test("凍結事例の再生でもhigh指定を全工程へ渡し初回記録に保存する", async () => {
  const f = await fixture(); await f.freeze(); model(f, "none");
  const path = join(f.dir, "claude");
  writeFileSync(path, readFileSync(path, "utf8").replace('const input = JSON.parse(await Bun.stdin.text());', 'const input = JSON.parse(await Bun.stdin.text()); if (process.argv[process.argv.indexOf("--effort") + 1] !== "high") throw new Error("effortが失われた");'));
  const run = await f.cli("replay", "--dataset", f.dataset, "--case", "case-1", "--provider", "claude", "--review-model", "claude-review-exact", "--review-effort", "high", "--implementation-models", "gpt-implementation-exact", "--extra-usage-disabled");
  expect(run.exitCode).toBe(0);
  const saved = JSON.parse(readFileSync(run.json.recordPath, "utf8")).data.initial;
  expect(saved).toMatchObject({ status: "completed", score: 5, execution: { requestedEffort: "high" } });
  expect(saved.execution.stages).toHaveLength(3);
});

function judgments(f: Awaited<ReturnType<typeof fixture>>, rows: any[]) {
  const path = join(f.dir, "judgments.json"); writeFileSync(path, JSON.stringify(rows)); return path;
}
const decisions = (verdict = "valid", knownCause: string | undefined = "known") => ["value", "duplicate"].map(id => ({ finding: `spec:${id}`, causeId: "same-cause", verdict, evidence: "独立に公開契約と確認した", knownCause }));

test("重複除去した適合率・見逃し・全PR時間とrepo内訳を集計し再レビューを加算しない", async () => {
  const f = await fixture();
  await f.freeze([f.entry, { ...f.entry, id: "case-2", repoKey: "second", pr: 2 }, { ...f.entry, id: "case-3", pr: 3, oracle: [{ ...f.entry.oracle[0]!, kind: "negative", major: false }] }]);
  model(f); const one = await replay(f); const two = await replay(f, "case-2");
  model(f, "none"); const three = await replay(f, "case-3"); await replay(f);
  const path = judgments(f, [
    { caseId: "case-1", attemptId: one.json.attemptId, complete: true, triageMinutes: 8, triageEvidence: "8分計測", findings: decisions() },
    { caseId: "case-2", attemptId: two.json.attemptId, complete: true, triageMinutes: 4, triageEvidence: "4分計測", findings: decisions("invalid", undefined) },
    { caseId: "case-3", attemptId: three.json.attemptId, complete: true, triageMinutes: 0, triageEvidence: "選別不要", findings: [] },
  ]);
  const report = await f.cli("report", "--dataset", f.dataset, "--judgments", path);
  expect(report.json).toMatchObject({ status: "evaluated", acceptance: "not_evaluated", metrics: { prs: 3, required: 2, valid: 1, pending: 0, precision: 0.5, triageMedianMinutes: 4, findingsOnlyMedianMinutes: 6, triageUnknown: 0, slow: [{ caseId: "case-1", minutes: 8 }] }, regression: { majorTotal: 2, majorDetected: 1, majorMissed: 1, majorUnknown: 0, majorDetectionRate: 0.5 } });
  expect(report.json.cases[0].attempts).toBe(2);
  expect(report.json.byRepo.second).toMatchObject({ prs: 1, precision: 0, triageMedianMinutes: 4 });
});

test("指摘0件と重大0件はN/A、記録された0分は有効、同じPRの別版は別PRにしない", async () => {
  const f = await fixture(); const entry = { ...f.entry, oracle: [{ ...f.entry.oracle[0]!, kind: "negative", major: false }] };
  await f.freeze([entry, { ...entry, id: "same-pr" }]); model(f, "none"); const run = await replay(f); const second = await replay(f, "same-pr");
  const path = judgments(f, [run, second].map((r, i) => ({ caseId: i ? "same-pr" : "case-1", attemptId: r.json.attemptId, complete: true, triageMinutes: 0, triageEvidence: "選別不要", findings: [] })));
  const report = await f.cli("report", "--dataset", f.dataset, "--judgments", path);
  expect(report.json).toMatchObject({ metrics: { prs: 1, required: 0, precision: null, triageMedianMinutes: 0, triageUnknown: 0 }, regression: { majorTotal: 0, majorDetectionRate: null }, acceptance: "not_evaluated", excludedFromPrCount: ["same-pr"] });
});

test("検証で棄却した有効指摘と追加発見を分け、未記録の時間から合格を確定しない", async () => {
  const f = await fixture(); await f.freeze(); model(f, "false_positive"); const run = await replay(f);
  const path = judgments(f, [{ caseId: "case-1", attemptId: run.json.attemptId, complete: true, triageMinutes: null, findings: decisions("valid", "known") }]);
  const report = await f.cli("report", "--dataset", f.dataset, "--judgments", path);
  expect(report.json).toMatchObject({ status: "pending", metrics: { required: 0, precision: null, triageMedianMinutes: null, triageUnknown: 1 }, regression: { majorMissed: 1 } });
  expect(report.json.cases[0].rejectedValid).toEqual(["spec:value", "spec:duplicate"]);
  const additional = JSON.parse(readFileSync(path, "utf8")); for (const d of additional[0].findings) delete d.knownCause;
  writeFileSync(path, JSON.stringify(additional));
  const rerun = await f.cli("report", "--dataset", f.dataset, "--judgments", path);
  expect(rerun.json.cases[0].additionalValid).toEqual(["spec:value", "spec:duplicate"]);
});

test("初回記録の修正後への差し替えと時間の不正値を拒否し評価不能を残す", async () => {
  const f = await fixture();
  await f.freeze([f.entry, { ...f.entry, id: "missing", pr: 2, unavailableReason: "当時の要求が未復元" }]);
  model(f); const run = await replay(f);
  const pending = await f.cli("report", "--dataset", f.dataset);
  expect(pending.json.metrics.unevaluable).toBe(1);
  const path = judgments(f, [{ caseId: "case-1", attemptId: run.json.attemptId, complete: true, triageMinutes: -1, findings: [] }]);
  expect((await f.cli("report", "--dataset", f.dataset, "--judgments", path)).exitCode).toBe(1);
  const record = JSON.parse(readFileSync(run.json.recordPath, "utf8")); record.data.initial.repair = { score: 5 };
  const { createHash } = await import("node:crypto"); record.hash = createHash("sha256").update(JSON.stringify(record.data)).digest("hex");
  writeFileSync(run.json.recordPath, JSON.stringify(record));
  expect((await f.cli("report", "--dataset", f.dataset)).exitCode).toBe(1);
});

test("時間が1PRでも未記録なら全PR中央値を出さず、観測済み中央値と分ける", async () => {
  const f = await fixture(); await f.freeze([f.entry, { ...f.entry, id: "case-2", pr: 2 }]); model(f);
  const one = await replay(f); await replay(f, "case-2");
  const path = judgments(f, [{ caseId: "case-1", attemptId: one.json.attemptId, complete: true, triageMinutes: 0, triageEvidence: "選別不要", findings: decisions() }]);
  const report = await f.cli("report", "--dataset", f.dataset, "--judgments", path);
  expect(report.json.metrics).toMatchObject({ triageMedianMinutes: null, observedTriageMedianMinutes: 0, triageKnown: 1, triageUnknown: 1 });
});

test("準備段階の失敗を評価不能に残し、成功した再実行へ置き換えない", async () => {
  const f = await fixture();
  f.entry.input.head = "a".repeat(40);
  await f.freeze(); model(f);
  const run = await replay(f);
  expect(run.json.reviewStatus).toBe("incomplete");
  const report = await f.cli("report", "--dataset", f.dataset);
  expect(report.exitCode, report.stdout).toBe(0);
  expect(report.json).toMatchObject({ status: "pending", metrics: { prs: 1, unevaluable: 1 }, regression: { majorUnknown: 1 } });
});

test("同じ根本原因に異なる人判定があっても分母を増やさず未判定を残す", async () => {
  const f = await fixture(); await f.freeze(); model(f); const run = await replay(f);
  const rows = decisions(); rows[1]!.causeId = "different-label"; rows[1]!.verdict = "invalid";
  const path = judgments(f, [{ caseId: "case-1", attemptId: run.json.attemptId, complete: true, triageMinutes: 0, triageEvidence: "記録", findings: rows }]);
  const report = await f.cli("report", "--dataset", f.dataset, "--judgments", path);
  expect(report.json).toMatchObject({ status: "pending", metrics: { required: 1, pending: 1 }, regression: { majorUnknown: 1 } });
});

for (const layer of ["review", "automatic_check", "unresolved"] as const) test(`独立レビュー集合は担当別に実績と分母を扱う（${layer}）`, async () => {
  const f = await fixture();
  const entry = { ...f.entry, oracle: f.entry.oracle.map(o => ({ ...o, layer, layerEvidence: "固定した検査対象と契約の担当を照合した", checkConfiguration: "fixture:value.tsと固定した検査条件" })) };
  writeFileSync(f.manifest, JSON.stringify({ version: 2, reviewPolicy: "independent-v1", purpose: "development", selection: "結果を見る前に分類", cases: [entry] }));
  expect((await f.cli("freeze", "--manifest", f.manifest, "--out", f.dataset)).exitCode).toBe(0);
  model(f); const run = await replay(f);
  const path = judgments(f, [{ caseId: entry.id, attemptId: run.json.attemptId, complete: true, triageMinutes: 1, triageEvidence: "1分の選別", findings: decisions() }]);
  const report = await f.cli("report", "--dataset", f.dataset, "--judgments", path);
  expect(report.exitCode, report.stderr).toBe(0);
  expect(report.json.reviewPolicy).toBe("independent-v1");
  expect(report.json.metrics.required).toBe(1);
  expect(report.json.metrics.triageMedianMinutes).toBe(1);
  expect(report.json.regression.majorTotal).toBe(layer === "review" ? 1 : 0);
  expect(report.json.metrics.valid).toBe(layer === "review" ? 1 : 0);
  expect(report.json.status).toBe(layer === "unresolved" ? "pending" : "evaluated");
  expect(report.json.metrics.precisionIsFinal).toBe(layer !== "unresolved");
  expect(report.json.cases[0].classification[layer === "automatic_check" ? "automaticCheck" : layer]).toEqual(["known"]);
});

test("新版の評価には担当と根拠が必要で、旧方式の記録を混在させない", async () => {
  const f = await fixture();
  const manifest: any = { version: 2, reviewPolicy: "independent-v1", purpose: "development", selection: "事前分類", cases: [f.entry] };
  writeFileSync(f.manifest, JSON.stringify(manifest));
  expect((await f.cli("freeze", "--manifest", f.manifest, "--out", f.dataset)).exitCode).toBe(1);
  for (const o of manifest.cases[0].oracle) Object.assign(o, { layer: "review", layerEvidence: "契約を確認", checkConfiguration: "固定fixture" });
  writeFileSync(f.manifest, JSON.stringify(manifest));
  expect((await f.cli("freeze", "--manifest", f.manifest, "--out", f.dataset)).exitCode).toBe(0);
  model(f); const run = await replay(f);
  const record = JSON.parse(readFileSync(run.json.recordPath, "utf8"));
  delete record.data.initial.reviewPolicy;
  const { createHash } = await import("node:crypto"); record.hash = createHash("sha256").update(JSON.stringify(record.data)).digest("hex");
  writeFileSync(run.json.recordPath, JSON.stringify(record));
  const result = await f.cli("report", "--dataset", f.dataset);
  expect(result.exitCode).toBe(1);
  expect(result.stdout + result.stderr).toContain("旧方式");
});
