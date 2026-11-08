import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { echoReviewReferences, git, makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

async function fixture() {
  const repo = makeRepo();
  const db = tempDb();
  registerRepo(db, repo, "RUN");
  writeFileSync(join(repo, "value.ts"), "export const value = 2;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "対象");
  const dir = tempDir("review-cli-");
  writeFileSync(join(dir, "claude"), "#!/bin/sh\nexit 99\n");
  chmodSync(join(dir, "claude"), 0o755);
  const env = { NOD_DOCS_DIR: tempDir("review-docs-"), PATH: `${dir}:${process.env.PATH}` };
  const cli = (...args: string[]) => runNod([...args, "--json"], { cwd: repo, db, env });
  const issue = (await cli("issue", "create", "値を2にする", "--description", "公開名valueで値2を返す。")).json.id;
  const run = (...args: string[]) => cli("review", "run", "--repo", repo, "--base", "HEAD^", "--issue", issue,
    "--provider", "claude", "--review-model", "claude-review-exact", "--implementation-models", "gpt-implementation-exact", ...args);
  return { repo, db, dir, env, cli, run, issue };
}

test("実装モデル集合と同じレビュー指定を未完了にし、モデルCLIを起動しない", async () => {
  const f = await fixture();
  const calls = join(f.dir, "calls");
  writeFileSync(join(f.dir, "claude"), `#!/bin/sh\necho called >> '${calls}'\nexit 99\n`);
  chmodSync(join(f.dir, "claude"), 0o755);
  const result = await f.run("--review-model", "gpt-implementation-exact");
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({ status: "incomplete", score: null });
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "MODEL_OVERLAP" }));
  expect(existsSync(calls)).toBe(false);
  expect(JSON.parse(readFileSync(result.json.artifactPath, "utf8"))).toEqual(result.json);
});

function fakeClaude(dir: string, body: string) {
  const path = join(dir, "claude");
  writeFileSync(path, `#!/usr/bin/env bun\n${body}\n`);
  chmodSync(path, 0o755);
}

test("既存契約の認証を確認しても追加課金の禁止が未確認なら推論を開始しない", async () => {
  const f = await fixture();
  fakeClaude(f.dir, `
    if (process.argv.includes("status")) {
      console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }));
    } else { await Bun.write(${JSON.stringify(join(f.dir, "inference"))}, "unexpected"); }
  `);
  const result = await f.run();
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "BILLING_POLICY_UNVERIFIED" }));
  expect(result.json.execution.authentication).toEqual({ method: "claude.ai", subscription: "max" });
  expect(existsSync(join(f.dir, "inference"))).toBe(false);
});

test("固定資料で2軸を並列探索し、新しい検証コンテキストへ候補だけを渡す", async () => {
  const f = await fixture();
  const trace = join(f.dir, "trace.jsonl");
  fakeClaude(f.dir, `
    import { appendFileSync, readFileSync } from "node:fs";
    if (process.argv.includes("status")) {
      console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }));
    } else {
      const input = JSON.parse(await Bun.stdin.text());
      appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ event: "start", phase: input.phase, pid: process.pid, input, args: process.argv, cwd: process.cwd(), snapshot: readFileSync("value.ts", "utf8") }) + "\\n");
      await Bun.sleep(150);
      appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ event: "end", phase: input.phase, pid: process.pid }) + "\\n");
      console.log(JSON.stringify({ type: "result", subtype: "success", modelUsage: { "claude-review-effective": { inputTokens: 42, outputTokens: 10 } },
        usage: { input_tokens: 42, output_tokens: 10 }, structured_output: { completed: true, axis: input.phase, candidates: [], requirements: [], thinking: "引き継がない探索思考" } }));
    }
  `);
  writeFileSync(join(f.repo, "value.ts"), "元repoの未コミット内容");
  git(f.repo, "add", "value.ts");
  const index = readFileSync(join(f.repo, ".git/index"));
  const result = await f.run("--extra-usage-disabled");
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({ status: "incomplete", score: null, execution: { status: "completed" } });
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "COVERAGE_INCOMPLETE" }));
  expect(result.json.execution.stages.map((s: any) => s.phase)).toEqual(["standards", "spec", "verification"]);
  expect(result.json.execution.stages.every((s: any) => s.effectiveModels.includes("claude-review-effective"))).toBe(true);
  expect(result.json.execution.stages[0].usage.input_tokens).toBe(42);
  const events = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(events.slice(0, 2).map(e => e.event)).toEqual(["start", "start"]);
  expect(events.slice(2, 4).map(e => e.event)).toEqual(["end", "end"]);
  const starts = events.filter(e => e.event === "start");
  expect(starts.every(e => e.input.requirements.acquisition?.status === "complete" && e.input.requirements.acquisition.mode === "issue_context")).toBe(true);
  expect(starts.every(e => e.input.requirements.consistency === "unverified")).toBe(true);
  expect(new Set(starts.map(e => e.pid)).size).toBe(3);
  expect(starts[2].phase).toBe("verification");
  expect(JSON.stringify(starts[2].input)).not.toContain("引き継がない探索思考");
  expect(starts[0].input.code).toContainEqual(expect.objectContaining({ path: "value.ts" }));
  expect(starts[0].input.code.every((entry: any) => !("content" in entry))).toBe(true);
  expect(starts[0].snapshot).toBe("export const value = 2;\n");
  expect(starts[0].cwd).not.toBe(f.repo);
  expect(starts[0].args).toContain("Read,Grep,Glob");
  expect(JSON.stringify(starts[0].input)).not.toContain("元repoの未コミット内容");
  expect(starts.every(e => e.args.includes("--disable-slash-commands") && e.args.includes("--safe-mode"))).toBe(true);
  expect(readFileSync(join(f.repo, "value.ts"), "utf8")).toBe("元repoの未コミット内容");
  expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
});

test("期限でSIGTERMを無視する子孫も停止し、検証を開始せず未完了を保存する", async () => {
  const f = await fixture();
  const children = join(f.dir, "children");
  fakeClaude(f.dir, `
    import { appendFileSync } from "node:fs";
    import { spawn } from "node:child_process";
    if (process.argv.includes("status")) {
      console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }));
    } else {
      const input = JSON.parse(await Bun.stdin.text());
      if (input.phase === "verification") await Bun.write(${JSON.stringify(join(f.dir, "verification"))}, "unexpected");
      const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 100);'], { stdio: "ignore" });
      appendFileSync(${JSON.stringify(children)}, String(child.pid) + "\\n");
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 100);
    }
  `);
  const result = await f.run("--extra-usage-disabled", "--timeout-seconds", "1.5");
  expect(result.exitCode).toBe(1);
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "DEADLINE_EXCEEDED" }));
  expect(result.json.score).toBeNull();
  expect(result.json.execution.elapsedMs).toBeLessThan(4000);
  expect(existsSync(join(f.dir, "verification"))).toBe(false);
  for (const line of readFileSync(children, "utf8").trim().split("\n")) {
    expect(() => process.kill(Number(line), 0)).toThrow();
  }
});

test("秘密ファイル候補が差分にあると本文をモデルと保存結果へ含めない", async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "credentials.json"), '"SENSITIVE_TEST_SENTINEL"');
  git(f.repo, "add", "credentials.json");
  git(f.repo, "commit", "-qm", "秘密候補");
  const result = await f.run();
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "SNAPSHOT_EXCLUDED" }));
  expect(JSON.stringify(result.json)).not.toContain("SENSITIVE_TEST_SENTINEL");
  const preparation = JSON.parse(readFileSync(join(result.json.artifactPath, "../preparation.json"), "utf8"));
  expect(JSON.stringify(preparation)).not.toContain("SENSITIVE_TEST_SENTINEL");
});

function successfulClaude(dir: string, result = `{ type: "result", subtype: "success", modelUsage: { "claude-review-effective": {} }, structured_output: { completed: true, axis: input.phase, candidates: [], requirements: [] } }`) {
  fakeClaude(dir, `
    if (process.argv.includes("status")) {
      console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }));
    } else {
      const input = JSON.parse(await Bun.stdin.text());
      console.log(JSON.stringify(${result}));
    }
  `);
}

test("無関係なバイナリ・symlinkを読み込まず除外一覧を渡し、必要なコードの探索を続ける", async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "image.bin"), Buffer.from([0, 1, 2]));
  symlinkSync(join(f.dir, "does-not-exist"), join(f.repo, "external-link"));
  git(f.repo, "add", ".");
  git(f.repo, "commit", "-qm", "無関係な資料");
  writeFileSync(join(f.repo, "value.ts"), "export const value = 3;\n");
  git(f.repo, "add", ".");
  git(f.repo, "commit", "-qm", "レビュー対象");
  successfulClaude(f.dir);
  const result = await f.run("--extra-usage-disabled");
  expect(result.json.execution.status).toBe("completed");
  expect(result.json.execution.excludedSources).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: "image.bin", reason: "binary" }),
    expect.objectContaining({ path: "external-link", reason: "non_regular" }),
  ]));
});

test("Codexの実効値を確証できないCLI契約では、設定値で代替せず推論前に停止する", async () => {
  const f = await fixture();
  const calls = join(f.dir, "codex-inference");
  const path = join(f.dir, "codex");
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = "login" ]; then echo 'Logged in using ChatGPT'; else echo unexpected >> '${calls}'; fi\n`);
  chmodSync(path, 0o755);
  const result = await f.run("--provider", "codex", "--review-model", "gpt-review-exact", "--extra-usage-disabled");
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "MODEL_UNVERIFIED" }));
  expect(result.json.execution.stages).toEqual([]);
  expect(existsSync(calls)).toBe(false);
});

for (const [name, payload, code] of [
  ["Claudeの実効値欄に他providerの識別子しかなければ拒否する", `{ type: "result", subtype: "success", modelUsage: { "gpt-implementation-exact": {} }, structured_output: { completed: true, axis: input.phase, candidates: [], requirements: [] } }`, "MODEL_UNVERIFIED"],
  ["自己申告のモデル名を実効値として採用しない", `{ type: "result", subtype: "success", structured_output: { completed: true, axis: input.phase, candidates: [], requirements: [], model: "claude-review-effective" } }`, "MODEL_UNVERIFIED"],
  ["終了コード0でも構造化出力が不正なら未完了にする", `{ type: "result", subtype: "success", modelUsage: { "claude-review-effective": {} }, structured_output: { completed: true, axis: input.phase, candidates: "bad", requirements: [] } }`, "OUTPUT_INVALID"],
  ["終了コード0の利用枠不足を失敗として残す", `{ type: "result", subtype: "error_during_execution", is_error: true, errors: ["rate_limit_error"] }`, "USAGE_LIMIT"],
  ["telemetryのusageやcreditだけで一般エラーを利用枠不足にしない", `{ type: "result", subtype: "error_during_execution", is_error: true, result: "Internal server error", usage: { fallback_credit: null } }`, "CLI_FAILED"],
  ["HTTP429の利用枠不足を構造化エラーから区別する", `{ type: "result", subtype: "error_during_execution", is_error: true, result: "Too many requests", api_error_status: 429, usage: { fallback_credit: null } }`, "USAGE_LIMIT"],
  ["必要な除外資料を要求する探索は完了にしない", `{ type: "result", subtype: "success", modelUsage: { "claude-review-effective": {} }, structured_output: { completed: false, axis: input.phase, candidates: [], requirements: [{ id: "R1", status: "unverified", evidence: "必要資料を取得できない" }] } }`, "MODEL_REVIEW_INCOMPLETE"],
] as const) {
  test(name, async () => {
    const f = await fixture();
    successfulClaude(f.dir, payload);
    const result = await f.run("--extra-usage-disabled");
    expect(result.exitCode).toBe(1);
    expect(result.json.score).toBeNull();
    expect(result.json.problems).toContainEqual(expect.objectContaining({ code }));
    expect(result.json.execution.stages.some((stage: any) => stage.phase === "verification")).toBe(false);
  });
}

test("レビュー実効モデルが実装集合にあれば別名指定でも拒否する", async () => {
  const f = await fixture();
  successfulClaude(f.dir);
  const result = await f.run("--extra-usage-disabled", "--implementation-models", "claude-review-effective,gpt-implementation-exact");
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "MODEL_OVERLAP" }));
});

test("API認証を既存契約として扱わず、推論も課金方式変更も開始しない", async () => {
  const f = await fixture();
  fakeClaude(f.dir, `console.log(JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }));`);
  const result = await f.run("--extra-usage-disabled");
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "AUTH_REQUIRED" }));
  expect(result.json.execution.stages).toEqual([]);
});

test("モデル子へAPIキー・provider・課金の環境設定を継承せず値を保存しない", async () => {
  const f = await fixture();
  const sentinel = "DO_NOT_LOG_TEST_SECRET";
  Object.assign(f.env, { ANTHROPIC_API_KEY: sentinel, OPENAI_API_KEY: sentinel, ANTHROPIC_BASE_URL: sentinel, CLAUDE_CODE_USE_BEDROCK: "1" });
  fakeClaude(f.dir, `
    if (["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK"].some(k => process.env[k])) process.exit(4);
    if (process.argv.includes("status")) {
      console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }));
    } else {
      const input = JSON.parse(await Bun.stdin.text());
      console.log(JSON.stringify({ type: "result", subtype: "success", modelUsage: { "claude-review-effective": {} }, structured_output: { completed: true, axis: input.phase, candidates: [], requirements: [] } }));
    }
  `);
  const result = await f.run("--extra-usage-disabled");
  expect(result.json.execution.status).toBe("completed");
  expect(result.stdout).not.toContain(sentinel);
  expect(readFileSync(result.json.artifactPath, "utf8")).not.toContain(sentinel);
});

test("30分より長い期限は推論を開始せず拒否する", async () => {
  const f = await fixture();
  const result = await f.run("--extra-usage-disabled", "--timeout-seconds", "1801");
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "INVALID_TIMEOUT" }));
  expect(result.json.execution.stages).toEqual([]);
});

for (const [body, code] of [[`console.log("not-json");`, "OUTPUT_INVALID"], [`process.exit(19);`, "CLI_FAILED"]] as const) {
  test(`CLIの実行失敗とJSON解析失敗を区別して保存する（${code}）`, async () => {
    const f = await fixture();
    fakeClaude(f.dir, `
      if (process.argv.includes("status")) console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }));
      else { await Bun.stdin.text(); ${body} }
    `);
    const result = await f.run("--extra-usage-disabled");
    expect(result.json.problems).toContainEqual(expect.objectContaining({ code }));
    expect(result.json.execution.status).toBe("incomplete");
  });
}

test("実行入口へのSIGTERMで並列のモデル子を止め、途中結果を保存する", async () => {
  const f = await fixture();
  const marker = join(f.dir, "started");
  fakeClaude(f.dir, `
    if (process.argv.includes("status")) console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }));
    else { await Bun.stdin.text(); await Bun.write(${JSON.stringify(marker)}, "started"); setInterval(() => {}, 100); }
  `);
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), "review", "run", "--repo", f.repo, "--base", "HEAD^", "--issue", f.issue,
    "--provider", "claude", "--review-model", "claude-review-exact", "--implementation-models", "gpt-implementation-exact", "--extra-usage-disabled", "--json"],
    { cwd: f.repo, env: { ...process.env, ...f.env, NOD_DB: f.db, NOD_ORCA: "0" }, stdout: "pipe", stderr: "pipe" });
  const read = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const until = Date.now() + 5000;
  while (!existsSync(marker) && Date.now() < until) await Bun.sleep(20);
  proc.kill("SIGTERM");
  const [stdout, stderr, exitCode] = await read;
  expect(existsSync(marker), stderr).toBe(true);
  expect(exitCode).toBe(1);
  const result = JSON.parse(stdout);
  expect(result.problems).toContainEqual(expect.objectContaining({ code: "CANCELLED" }));
  expect(JSON.parse(readFileSync(result.artifactPath, "utf8"))).toEqual(result);
});

function adjudicatingClaude(dir: string, mutate = "") {
  fakeClaude(dir, `
    if (process.argv.includes("status")) console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }));
    else {
      const input = JSON.parse(await Bun.stdin.text());
      ${echoReviewReferences}
      const requirements = (input.reviewUnits ?? []).filter(u => input.phase === "verification" || u.axis === input.phase).map(u => ({ ...u, target: input.target.hash, status: "satisfied", implementation: [{ path: "value.ts", revision: "head", line: 1 }], verification: { method: "inspection", detail: "公開exportの値と要求を照合した" }, evidence: "value.ts:1 は公開名valueで2を返す" }));
      const output = { completed: true, axis: input.phase, candidates: [], requirements, consistency: { status: "consistent", evidence: "固定したIssue・Spec・計画の要求値と範囲を相互確認した" } };
      ${mutate}
      console.log(JSON.stringify({ type: "result", subtype: "success", modelUsage: { "claude-review-effective": {} }, structured_output: output }));
    }
  `);
}

test("両軸で固定要求の証拠を確認した指摘0件は5点、初回結果を別保存する", async () => {
  const f = await fixture();
  adjudicatingClaude(f.dir);
  const result = await f.run("--extra-usage-disabled");
  expect(result.exitCode).toBe(0);
  expect(result.json).toMatchObject({ status: "completed", score: 5, review: { standards: "passed", spec: "passed" } });
  expect(result.json.coverage).toContainEqual(expect.objectContaining({ requirement: "公開名valueで値2を返す。", status: "satisfied" }));
  expect(JSON.parse(readFileSync(result.json.initialReviewPath, "utf8"))).toMatchObject({ score: 5, target: { hash: result.json.target.hash } });
});

const missingRequirement = `
  const unit = input.reviewUnits.find(u => u.axis === "spec");
  const candidate = { id: "missing", axis: "spec", target: input.target.hash, location: { path: "value.ts", revision: "head", line: 1 }, contract: unit.reference,
    condition: "利用者がvalueをimportする", failure: "要求された値2が返らない", impact: { score: 2, description: "主要な公開値が不正になる" },
    evidence: { kind: "static", detail: "公開exportの右辺を要求と照合した" }, reproduction: "valueをimportして2と比較する", rootCause: "wrong-value", needsSpecificationDecision: false, decision: "required",
    responsibility: { owner: "review", rationale: "値の公開契約を確認する", references: [] },
    rationale: "公開契約に反し利用側の処理を壊す", defense: "公開値を補正する既存防御はない", sdk: { status: "not_applicable", evidence: "言語の定数exportのみ" } };
  if (input.phase !== "standards") output.candidates = [candidate];
  output.requirements = output.requirements.map(r => r.id === unit.id ? { ...r, status: "unsatisfied", findingIds: ["missing"], findingLinks: [{ findingId: "missing", requirementEvidence: [unit.reference], codeEvidence: [candidate.location],
    operation: { requirement: "valueをimportする", candidate: "valueをimportする", match: "same" },
    condition: { requirement: "公開値の利用時", candidate: "公開値の利用時", match: "same" },
    obligation: { requirement: "値2を返す", candidate: "値2を返す", match: "same" },
    effectOfFix: "resolves_this_violation", rationale: "公開定数の右辺を2へ戻すと、同じimportで要求値が得られる" }] } : r);
`;

test("テスト成功の報告でも未充足要求をSpecの要対応として最重影響で採点する", async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "value.ts"), "export const value = 3;\n");
  git(f.repo, "add", ".");
  git(f.repo, "commit", "-qm", "公開値の不具合");
  adjudicatingClaude(f.dir, missingRequirement);
  const result = await f.run("--extra-usage-disabled");
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({ status: "completed", score: 2, review: { standards: "passed", spec: "failed" } });
  expect(result.json.findings).toContainEqual(expect.objectContaining({ id: "missing", decision: "required", rootCause: "wrong-value" }));
});

test("途中で要求Documentが変われば過去版の全件充足を成功にしない", async () => {
  const f = await fixture();
  const doc = (await f.cli("doc", "create", "active.md", "--kind", "spec", "--issue", f.issue, "--body", "公開名valueで値2を返す。")).json;
  adjudicatingClaude(f.dir, `if (input.phase === "verification") await Bun.write(${JSON.stringify(doc.path)}, "公開名valueで値3を返す。");`);
  const result = await f.run("--extra-usage-disabled");
  expect(result.json.score).toBeNull();
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "REQUIREMENTS_CHANGED" }));
});

test("存在しない実装箇所への証拠は満点にしない", async () => {
  const f = await fixture();
  adjudicatingClaude(f.dir, `for (const row of output.requirements) row.implementation = [{ path: "missing.ts", revision: "head", line: 999 }];`);
  const result = await f.run("--extra-usage-disabled");
  expect(result.json.score).toBeNull();
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "COVERAGE_INCOMPLETE" }));
});

test("要求の矛盾が未解決なら指摘0件でも採点しない", async () => {
  const f = await fixture();
  adjudicatingClaude(f.dir, `output.consistency = { status: "conflict", evidence: "IssueとSpecで要求値が異なる" };`);
  const result = await f.run("--extra-usage-disabled");
  expect(result.json.score).toBeNull();
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "REQUIREMENTS_CONFLICT" }));
});

for (const consistency of ["consistent", "conflict", "unverified"] as const) test(`文書単独の取得完了を渡しても意味の整合性判定を上書きしない（${consistency}）`, async () => {
  const f = await fixture();
  const document = join(f.dir, "requirements.md"), trace = join(f.dir, "acquisition.jsonl");
  writeFileSync(document, "公開名valueで値2を返す。\n");
  adjudicatingClaude(f.dir, `
    require("node:fs").appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ phase: input.phase, requirements: input.requirements }) + "\\n");
    output.consistency = { status: ${JSON.stringify(consistency)}, evidence: "固定した単独文書の内部と規約への整合性を確認した結果" };
  `);
  const result = await f.cli("review", "run", "--repo", f.repo, "--base", "HEAD^", "--document", document,
    "--provider", "claude", "--review-model", "claude-review-exact", "--implementation-models", "gpt-implementation-exact", "--extra-usage-disabled");
  const calls = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls.map(c => c.phase).sort()).toEqual(["spec", "standards", "verification"]);
  for (const call of calls) {
    expect(call.requirements.acquisition).toEqual({ status: "complete", mode: "document_only", sourceIds: [`document:${document}`] });
    expect(call.requirements.issueIds).toEqual([]);
    expect(call.requirements.consistency).toBe("unverified");
  }
  expect(result.json.status).toBe(consistency === "consistent" ? "completed" : "incomplete");
  expect(result.json.score).toBe(consistency === "consistent" ? 5 : null);
  if (consistency !== "consistent") expect(result.json.problems).toContainEqual(expect.objectContaining({ code: consistency === "conflict" ? "REQUIREMENTS_CONFLICT" : "CONSISTENCY_UNVERIFIED" }));
});

test("文書だけの変更では文書・数値と契約を観点にし、UIやDBを必須にしない", async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "notes.md"), "値2を公開する。\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "文書");
  adjudicatingClaude(f.dir);
  const result = await f.run("--extra-usage-disabled");
  expect(result.json.focus.map((item: any) => item.id)).toEqual(["contract", "documentation"]);
});

for (const [label, mutate, expected] of [
  ["任意提案のみは減点しない", `for (const c of output.candidates) c.decision = "optional"; for (const r of output.requirements) r.status = "satisfied";`, 5],
  ["探索の必須候補を検証で証拠不備の任意提案へ下げても通さない", `if (input.phase === "verification") for (const c of output.candidates) { c.decision = "optional"; c.location = { ...c.location, line: 9999 }; } for (const r of output.requirements) r.status = "satisfied";`, null],
  ["照合できない任意提案も停止・減点しない", `for (const c of output.candidates) { c.decision = "optional"; c.location = { ...c.location, line: 9999 }; } for (const r of output.requirements) r.status = "satisfied";`, 5],
  ["誤検知の棄却理由を保存する", `for (const c of output.candidates) { c.decision = "false_positive"; c.rationale = "固定版の既存防御で到達不能"; } for (const r of output.requirements) r.status = "satisfied";`, 5],
  ["重大な未確認候補は点数なし", `for (const c of output.candidates) c.decision = "unverified";`, null],
  ["旧版の候補は採用しない", `for (const c of output.candidates) c.target = "old-version";`, null],
  ["探索候補の検証省略は点数なし", `if (input.phase === "verification") output.candidates = []; for (const r of output.requirements) r.status = "satisfied";`, null],
  ["新仕様判断が必要なら要対応に確定しない", `for (const c of output.candidates) c.needsSpecificationDecision = true;`, null],
  ["モデルによる実行済み自己申告を実行証拠にしない", `for (const c of output.candidates) c.evidence = { kind: "executed", detail: "テスト成功" };`, null],
] as const) {
  test(label, async () => {
    const f = await fixture();
    adjudicatingClaude(f.dir, missingRequirement + mutate);
    const result = await f.run("--extra-usage-disabled");
    expect(result.json.score).toBe(expected);
    expect(result.json.findings).toHaveLength(1);
    expect(result.json.execution.stages.find((s: any) => s.phase === "spec").output.candidates).toHaveLength(1);
  });
}

for (const [label, mutate] of [
  ["指摘0件でも要求記録が欠落すれば未完了", `output.requirements = [];`],
  ["要求未確認を満点にしない", `for (const r of output.requirements) r.status = "unverified";`],
  ["旧版の要求証拠を満点にしない", `for (const r of output.requirements) r.target = "old-version";`],
  ["テストのみの成功を仕様充足にしない", `for (const r of output.requirements) r.verification = { method: "test", detail: "全テスト成功" };`],
  ["承認済み範囲の出典なしで必須要求を対象外にしない", `for (const r of output.requirements) { r.status = "out_of_scope"; r.rationale = "今回は対象外"; }`],
  ["存在するファイルでも範囲外の行を証拠にしない", `for (const r of output.requirements) r.implementation[0].line = 999;`],
] as const) {
  test(label, async () => {
    const f = await fixture();
    adjudicatingClaude(f.dir, mutate);
    const result = await f.run("--extra-usage-disabled");
    expect(result.json).toMatchObject({ status: "incomplete", score: null });
    expect(result.json.coverage).toContainEqual(expect.objectContaining({ status: "unverified" }));
  });
}

test("削除した契約箇所は基点の引用を検証し、両軸の同根本原因を保持する", async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "deleted.ts"), "export const required = 2;\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "削除前");
  git(f.repo, "rm", "deleted.ts"); git(f.repo, "commit", "-qm", "契約を削除");
  adjudicatingClaude(f.dir, missingRequirement + `
    const c = { ...candidate, location: { path: "deleted.ts", revision: "base", line: 1, quote: "export const required = 2;" }, contract: { path: "deleted.ts", revision: "base", line: 1, quote: "export const required = 2;" } };
    output.candidates = input.phase === "verification" ? [{ ...c, axis: "spec" }, { ...c, axis: "standards" }] : [{ ...c, axis: input.phase }];
  `);
  const result = await f.run("--extra-usage-disabled");
  expect(result.json.score).toBe(2);
  expect(result.json.findings.map((f: any) => f.axis)).toEqual(["spec", "standards"]);
  expect(result.json.rootCauses).toHaveLength(1);
  expect(result.json.rootCauses[0].candidates).toHaveLength(2);
});

test("計画はTaskとStepを確認単位にし、JSONの状態や括弧を要求にしない", async () => {
  const f = await fixture();
  await f.cli("issue", "plan", f.issue, "--step", "公開値を2にする");
  adjudicatingClaude(f.dir);
  const result = await f.run("--extra-usage-disabled");
  expect(result.json.score).toBe(5);
  const plan = result.json.coverage.filter((r: any) => r.reference.source.startsWith("plan:"));
  expect(plan.length).toBeGreaterThan(0);
  expect(plan.map((r: any) => r.requirement)).toContain("公開値を2にする");
  expect(plan.some((r: any) => /pending|^[{}]$/.test(r.requirement))).toBe(false);
});

test("SDKの版を確認したという自己申告だけでは要対応を確定しない", async () => {
  const f = await fixture();
  adjudicatingClaude(f.dir, missingRequirement + `for (const c of output.candidates) c.sdk = { status: "verified", version: "9.9.9", source: "未確認のpackage.json", evidence: "最新版では壊れる" };`);
  const result = await f.run("--extra-usage-disabled");
  expect(result.json.score).toBeNull();
  expect(result.json.findings[0].decision).toBe("unverified");
});

test("承認済み計画の後続Taskは実装箇所なしで対象外にし、限定範囲と残要求を示す", async () => {
  const f = await fixture();
  await f.cli("issue", "plan", f.issue, "--step", "後続Taskで別の公開値を追加する");
  adjudicatingClaude(f.dir, `for (const row of output.requirements) if (row.reference.source.startsWith("plan:")) { row.status = "out_of_scope"; row.scopeEvidence = row.reference; row.rationale = "承認済み計画で別Taskの対象とされている"; row.implementation = []; }`);
  const result = await f.run("--extra-usage-disabled");
  expect(result.json.score).toBe(5);
  expect(result.json.scope.kind).toBe("limited");
  expect(result.json.scope.excludedRequirements.length).toBeGreaterThan(0);
  expect(result.json.coverage).toContainEqual(expect.objectContaining({ requirement: "後続Taskで別の公開値を追加する", status: "out_of_scope", implementation: [] }));
});

test("要求本文が見出しだけならモデル完了でも5点にしない", async () => {
  const f = await fixture();
  const issue = (await f.cli("issue", "create", "未確定", "--description", "# 要求")).json.id;
  adjudicatingClaude(f.dir);
  const result = await f.run("--extra-usage-disabled", "--issue", issue);
  expect(result.json.score).toBeNull();
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "COVERAGE_EMPTY" }));
});

test("複数問題は最重影響で採点し、任意提案の重大度で減点しない", async () => {
  const f = await fixture();
  adjudicatingClaude(f.dir, missingRequirement + `if (input.phase !== "standards") output.candidates.push({ ...candidate, id: "fatal", rootCause: "fatal-local", impact: { score: 1, description: "局所的な致命問題" } }, { ...candidate, id: "optional", rootCause: "cleanup", decision: "optional", impact: { score: 0, description: "採用しない改善提案" } });`);
  const result = await f.run("--extra-usage-disabled");
  expect(result.json.score).toBe(1);
  expect(result.json.review).toEqual({ standards: "passed", spec: "failed" });
});

test("localの探索・検証・証拠照合は同じ固定内容を使い、途中の元ファイル編集を保持する", async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "value.ts"), "export const value = 3;\n");
  git(f.repo, "add", "value.ts");
  writeFileSync(join(f.repo, "value.ts"), "export const value = 4;\n");
  const index = readFileSync(join(f.repo, ".git/index"));
  const observed = join(f.dir, "observed.jsonl");
  adjudicatingClaude(f.dir, `
    const content = await Bun.file("value.ts").text();
    const fs = await import("node:fs");
    fs.appendFileSync(${JSON.stringify(observed)}, JSON.stringify({ phase: input.phase, content, mode: input.target.mode, target: input.target.hash }) + "\\n");
    if (input.phase === "standards") await Bun.write(${JSON.stringify(join(f.repo, "value.ts"))}, "同時編集で残す内容\\n");
    for (const row of output.requirements) row.implementation = [{ path: "value.ts", revision: "head", line: 1, quote: "export const value = 4;" }];
  `);
  const result = await f.run("--local", "--extra-usage-disabled");
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  expect(result.json).toMatchObject({ status: "completed", score: 5, target: { mode: "local" } });
  const observedRows = readFileSync(observed, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(observedRows).toHaveLength(3);
  expect(observedRows.every(row => row.content === "export const value = 4;\n" && row.mode === "local" && row.target === result.json.target.hash)).toBe(true);
  expect(readFileSync(join(f.repo, "value.ts"), "utf8")).toBe("同時編集で残す内容\n");
  expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
  const commitReview = await f.run("--extra-usage-disabled");
  expect(commitReview.json.target.mode).toBe("commit");
  expect(commitReview.json.target.hash).not.toBe(result.json.target.hash);
  expect(commitReview.json.score).toBeNull();
});

test("localで無変更の大きいファイルは除外一覧に残し、関係する小さな変更をレビューできる", async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "large.dat"), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "大きい資料");
  writeFileSync(join(f.repo, "value.ts"), "export const value = 3;\n");
  adjudicatingClaude(f.dir);
  const result = await f.run("--base", "HEAD", "--local", "--extra-usage-disabled");
  expect(result.json.score).toBe(5);
  expect(result.json.execution.excludedSources).toContainEqual({ path: "large.dat", reason: "size_limit" });
  expect(result.json.target.files).toEqual(["value.ts"]);
});

for (const standard of ["AGENTS.md", "README.md"]) {
test(`local固定後からモデル起動前に${standard}が変わっても古い規約の合格を返さない`, async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, standard), "# 規約\n公開名valueを保つ。\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "規約を追加");
  writeFileSync(join(f.repo, "value.ts"), "export const value = 3;\n");
  const realGit = Bun.spawnSync(["which", "git"]).stdout.toString().trim();
  writeFileSync(join(f.dir, "git"), `#!/usr/bin/env bun\nif (process.argv.includes("show") && process.argv.some(a => a.endsWith(${JSON.stringify(":" + standard)}))) await Bun.write(${JSON.stringify(join(f.repo, standard))}, "変更後の規約\\n");\nconst p = Bun.spawnSync([${JSON.stringify(realGit)}, ...process.argv.slice(2)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }); process.exit(p.exitCode);\n`);
  chmodSync(join(f.dir, "git"), 0o755);
  adjudicatingClaude(f.dir);
  const result = await f.run("--base", "HEAD", "--local", "--extra-usage-disabled");
  expect(result.json.score).toBeNull();
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "REQUIREMENTS_CHANGED" }));
  expect(result.json.execution.stages).toEqual([]);
  expect(readFileSync(join(f.repo, standard), "utf8")).toBe("変更後の規約\n");
});
}

test("削除した変更対象の基点本文を読めなければ記録して未完了にする", async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "logo.bin"), Buffer.from([1, 0, 2, 0]));
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "バイナリ追加");
  git(f.repo, "rm", "-q", "logo.bin"); git(f.repo, "commit", "-qm", "バイナリ削除");
  successfulClaude(f.dir);
  const result = await f.run("--extra-usage-disabled");
  expect(result.json).toMatchObject({ status: "incomplete", score: null });
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "SNAPSHOT_EXCLUDED" }));
  expect(result.json.execution.excludedSources).toContainEqual({ path: "logo.bin", reason: "base_binary" });
  expect(result.json.execution.stages).toEqual([]);
});

test("変更対象が不正UTF-8なら置換文字でレビューせず未完了にする", async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "value.ts"), Buffer.from([255, 128, 10]));
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "不正UTF-8");
  successfulClaude(f.dir);
  const result = await f.run("--extra-usage-disabled");
  expect(result.json).toMatchObject({ status: "incomplete", score: null });
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "SNAPSHOT_EXCLUDED" }));
  expect(result.json.execution.excludedSources).toContainEqual({ path: "value.ts", reason: "invalid_utf8" });
  expect(result.json.execution.stages).toEqual([]);
});


test("README規約の確認を省略したレビューはStandardsを合格や5点にしない", async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "README.md"), "# 規約\nSkill変更時は4か所のversionを同期する。\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "README規約");
  adjudicatingClaude(f.dir, `output.requirements = output.requirements.filter(r => r.reference.source !== "standard:README.md");`);
  const result = await f.run("--extra-usage-disabled");
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({ status: "incomplete", score: null, review: { standards: "incomplete" } });
  expect(result.json.coverage).toContainEqual(expect.objectContaining({ axis: "standards", requirement: "Skill変更時は4か所のversionを同期する。", status: "unverified", reference: expect.objectContaining({ source: "standard:README.md" }) }));
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "COVERAGE_INCOMPLETE" }));
});

for (const exitCode of [0, 1]) {
  test(`実CLIの入力過大を利用枠不足へ誤分類せず未完了で保存する（exit=${exitCode}）`, async () => {
    const f = await fixture();
    fakeClaude(f.dir, `
      if (process.argv.includes("status")) console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }));
      else {
        await Bun.stdin.text();
        console.log(JSON.stringify({ subtype: "success", is_error: true, result: "Prompt is too long",
          usage: { input_tokens: 0, output_tokens: 0, fallback_credit: null }, modelUsage: {} }));
        process.exit(${exitCode});
      }
    `);
    const result = await f.run("--extra-usage-disabled");
    expect(result.exitCode).toBe(1);
    expect(result.json.score).toBeNull();
    expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "INPUT_TOO_LARGE" }));
    expect(result.json.problems.some((p: any) => p.code === "USAGE_LIMIT")).toBe(false);
    expect(result.json.execution.stages.some((s: any) => s.phase === "verification")).toBe(false);
  });
}

for (const stale of [false, true]) {
  test(`簡潔な出力契約は固定要求から出典を復元し、別対象は拒否する（stale=${stale}）`, async () => {
    const f = await fixture();
    adjudicatingClaude(f.dir, `
      output.format = 2;
      output.target = ${stale ? '"別の対象"' : 'input.target.hash'};
      output.causeGroups = [];
      output.requirements = output.requirements.map(({ id, status, implementation, verification, evidence }) => ({ id, status, implementation, verification, evidence, findingIds: [], scopeEvidence: null, rationale: "公開契約を確認" }));
    `);
    const result = await f.run("--extra-usage-disabled");
    if (stale) {
      expect(result.json.score).toBeNull();
      expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "STALE_EVIDENCE" }));
    } else {
      expect(result.json).toMatchObject({ status: "completed", score: 5 });
      expect(result.json.coverage[0]).toMatchObject({ target: result.json.target.hash, requirement: "公開名valueで値2を返す。", reference: { quote: "公開名valueで値2を返す。" } });
    }
  });
}

test("必須範囲の切れたリンクはモデルを起動せず止め、参考範囲のリンクは記録して続行する", async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "README.md"), "# 説明\n[古い設計](missing/design.md)\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "説明資料");
  adjudicatingClaude(f.dir);
  const unplanned = await f.run("--extra-usage-disabled");
  expect(unplanned.json.problems).toContainEqual(expect.objectContaining({ code: "STANDARD_UNREADABLE" }));
  expect(unplanned.json.execution.stages).toEqual([]);
  const prepared = await f.cli("review", "prepare", "--repo", f.repo, "--base", "HEAD^", "--issue", f.issue);
  const standard = prepared.json.sources.find((s: any) => s.type === "standard");
  const plan = join(f.dir, "scope.json");
  const write = (kind: string) => writeFileSync(plan, JSON.stringify({ version: 1, standards: [{ source: `standard:${standard.id}`, hash: standard.hash, ranges: [
    { start: 1, end: 3, kind, rationale: "リンク先の扱いを確かめる計画" },
  ] }] }));
  write("required");
  const required = await f.run("--scope-plan", plan, "--extra-usage-disabled");
  expect(required.json.problems).toContainEqual(expect.objectContaining({ code: "STANDARD_UNREADABLE" }));
  write("reference");
  const reference = await f.run("--scope-plan", plan, "--extra-usage-disabled");
  expect(reference.json).toMatchObject({ status: "completed", score: 5 });
  expect(reference.json.requirements.unresolvedReferences).toEqual([{ path: "missing/design.md", referencedFrom: "README.md", line: 2 }]);
});

test("全行が参考範囲の規約は主入力を索引だけにし、本文ファイルは読める", async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "README.md"), "# 説明\n参考の背景説明。\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "規約");
  const prepared = await f.cli("review", "prepare", "--repo", f.repo, "--base", "HEAD^", "--issue", f.issue);
  const standard = prepared.json.sources.find((s: any) => s.type === "standard");
  const plan = join(f.dir, "scope.json");
  writeFileSync(plan, JSON.stringify({ version: 1, standards: [{ source: `standard:${standard.id}`, hash: standard.hash, ranges: [
    { start: 1, end: 3, kind: "reference", rationale: "背景説明であり必須要求ではない" },
  ] }] }));
  adjudicatingClaude(f.dir, `
    const row = input.sources.find(s => s.source === "standard:README.md");
    if (!row.referenceOnly || row.headings || row.applicability) throw new Error("参考だけの規約へ見出し一覧を渡さない");
    if (input.standardScope.standards.length) throw new Error("参考だけの規約の範囲を渡さない");
    if (!(await Bun.file(row.path).text()).includes("参考の背景説明。")) throw new Error("本文は取得可能にする");
  `);
  const result = await f.run("--scope-plan", plan, "--extra-usage-disabled");
  expect(result.json).toMatchObject({ status: "completed", score: 5 });
  expect(result.json.standardScope.standards).toHaveLength(1);
});

test("規約の適用計画で参考範囲を明示し、Specは残して固定資料を必要時に読める", async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "README.md"), "# 説明\n公開名valueを維持する。\n参考の背景説明。\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "規約");
  const prepared = await f.cli("review", "prepare", "--repo", f.repo, "--base", "HEAD^", "--issue", f.issue);
  const standard = prepared.json.sources.find((s: any) => s.type === "standard");
  const plan = join(f.dir, "scope.json");
  writeFileSync(plan, JSON.stringify({ version: 1, standards: [{ source: `standard:${standard.id}`, hash: standard.hash, ranges: [
    { start: 1, end: 2, kind: "required", rationale: "公開名の規約を確認する" },
    { start: 3, end: 4, kind: "reference", rationale: "背景説明と末尾空行であり必須要求ではない" },
  ] }] }));
  adjudicatingClaude(f.dir, `
    if (input.reviewUnits.some(u => u.requirement === "参考の背景説明。")) throw new Error("参考資料を必須要求にしない");
    if (!input.reviewUnits.some(u => u.axis === "spec")) throw new Error("Specを省略しない");
    if (input.sources.some(s => s.content)) throw new Error("本文を主入力へ重複して渡さない");
    const sourceFile = input.sources.find(s => s.source === "standard:README.md");
    if (!(await Bun.file(sourceFile.path).text()).includes("参考の背景説明。")) throw new Error("固定した参考資料は取得可能にする");
  `);
  const result = await f.run("--scope-plan", plan, "--extra-usage-disabled");
  expect(result.json).toMatchObject({ status: "completed", score: 5, scope: { kind: "limited" } });
  expect(result.json.standardScope.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(result.json.coverage.some((r: any) => r.requirement === "参考の背景説明。")).toBe(false);
  expect(result.json.sources.find((s: any) => s.type === "standard").content).toContain("参考の背景説明。");
});

test("各工程へ担当単位と主要求だけを渡し、出典・段落・適用範囲を1回ずつにして入力量を記録する", async () => {
  const f = await fixture();
  await f.cli("issue", "update", f.issue, "-d", "利用時は、\n公開名valueで値2を返す。");
  writeFileSync(join(f.repo, "README.md"), "# 規約\n変更時は、\n公開名valueを維持する。\n参考の背景説明。\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "規約");
  const prepared = await f.cli("review", "prepare", "--repo", f.repo, "--base", "HEAD^", "--issue", f.issue);
  const standard = prepared.json.sources.find((s: any) => s.type === "standard");
  const plan = join(f.dir, "scope.json");
  writeFileSync(plan, JSON.stringify({ version: 1, standards: [{ source: `standard:${standard.id}`, hash: standard.hash, ranges: [
    { start: 1, end: 3, kind: "required", rationale: "公開名の規約を必須として確認する" },
    { start: 4, end: 5, kind: "reference", rationale: "背景説明と末尾空行は参考にとどめる" },
  ] }] }));
  const trace = join(f.dir, "inputs.jsonl");
  fakeClaude(f.dir, `
    import { appendFileSync } from "node:fs";
    if (process.argv.includes("status")) console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }));
    else {
      const body = await Bun.stdin.text(), input = JSON.parse(body), schema = process.argv[process.argv.indexOf("--json-schema") + 1];
      appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ phase: input.phase, body, bodyBytes: Buffer.byteLength(body), schemaBytes: Buffer.byteLength(schema) }) + "\\n");
      ${echoReviewReferences}
      const requirements = input.reviewUnits.filter(u => input.assignedRequirementIds.includes(u.id)).map(u => ({ ...u, target: input.target.hash, status: "satisfied", implementation: [{ path: "value.ts", revision: "head", line: 1 }], verification: { method: "inspection", detail: "公開exportの値と要求を照合した" }, evidence: "value.ts:1 は公開名valueで2を返す" }));
      console.log(JSON.stringify({ type: "result", subtype: "success", modelUsage: { "claude-review-effective": {} }, structured_output: { completed: true, axis: input.phase, candidates: [], requirements, consistency: { status: "consistent", evidence: "固定した要求と規約を相互確認した" } } }));
    }
  `);
  const result = await f.run("--scope-plan", plan, "--extra-usage-disabled");
  expect(result.json, result.stderr).toMatchObject({ status: "completed", score: 5 });
  const calls = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const issueParagraph = JSON.stringify("利用時は、\n公開名valueで値2を返す。"), standardParagraph = JSON.stringify("変更時は、\n公開名valueを維持する。\n参考の背景説明。");
  const count = (body: string, text: string) => body.split(text).length - 1;
  const specIds = [`issue:${f.issue}:L1`, `issue:${f.issue}:L2`], standardIds = ["standard:README.md:L2", "standard:README.md:L3"];
  const expected: Record<string, { assigned: string[]; units: string[] }> = {
    standards: { assigned: standardIds, units: [...specIds, ...standardIds] },
    spec: { assigned: specIds, units: specIds },
    verification: { assigned: [...standardIds, ...specIds], units: [...specIds, ...standardIds] },
  };
  expect(calls.map(c => c.phase).sort()).toEqual(["spec", "standards", "verification"]);
  for (const call of calls) {
    const input = JSON.parse(call.body), want = expected[call.phase]!;
    expect(input.assignedRequirementIds).toEqual(want.assigned);
    expect(input.reviewUnits.map((u: any) => u.id).sort()).toEqual([...want.units].sort());
    for (const unit of input.reviewUnits) {
      expect(Object.keys(unit.reference).sort()).toEqual(["line", "source"]);
      expect(unit.context).toBeUndefined();
      expect(input.reviewParagraphs.map((p: any) => p.id)).toContain(unit.paragraph);
      expect(unit.requiredAssessmentReferences).toEqual(({ [specIds[0]!]: [1], [specIds[1]!]: [2, 1], [standardIds[0]!]: [2], [standardIds[1]!]: [3, 2] } as Record<string, number[]>)[unit.id]!.map(line => ({ source: unit.reference.source, line })));
    }
    expect(count(call.body, issueParagraph)).toBe(1);
    expect(count(call.body, standardParagraph)).toBe(call.phase === "spec" ? 0 : 1);
    expect(count(call.body, "公開名の規約を必須として確認する")).toBe(1);
    expect(count(call.body, "背景説明と末尾空行は参考にとどめる")).toBe(1);
    expect(call.body).not.toContain(standard.hash);
    const indexed = input.sources.find((s: any) => s.source === "standard:README.md");
    expect(indexed).toEqual({ source: "standard:README.md", title: expect.any(String), path: expect.stringMatching(/^\.review-input-[^/]+\/source-\d+\.txt$/), lines: 5, headings: [{ title: "# 規約", line: 1 }] });
    expect(input.sourceFiles).toBeUndefined();
    expect(input.standardScope.standards).toEqual([{ source: "standard:README.md", ranges: expect.any(Array) }]);
  }
  const stages = result.json.execution.stages;
  for (const stage of stages) {
    const call = calls.find(c => c.phase === stage.phase);
    expect(stage.input).toEqual({ bodyBytes: call.bodyBytes, schemaBytes: call.schemaBytes, assignedRequirementIds: expected[stage.phase]!.assigned.length, reviewUnits: expected[stage.phase]!.units.length });
  }
  expect(result.json.sources.find((s: any) => s.type === "standard")).toMatchObject({ hash: standard.hash, content: expect.stringContaining("参考の背景説明。"), applicability: expect.any(Array) });
  expect(result.json.execution.sourceFiles).toContainEqual(expect.objectContaining({ source: "standard:README.md", hash: standard.hash }));
});

for (const outside of [false, true]) {
  test(`新形式の候補は引用を固定行から取得して同原因を統合し、差分外の必須指摘を拒否する（outside=${outside}）`, async () => {
    const f = await fixture();
    writeFileSync(join(f.repo, "value.ts"), "  export const value = 3;\n// 元からある説明\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "準備");
    writeFileSync(join(f.repo, "value.ts"), "  export const value = 4;\n// 元からある説明\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "対象");
    adjudicatingClaude(f.dir, missingRequirement + `
      output.format = 2; output.target = input.target.hash;
      if (output.candidates.length) {
        const c = output.candidates[0];
        c.contract = { source: unit.reference.source, line: unit.reference.line };
        c.changeEvidence = { path: "value.ts", revision: "head", line: ${outside ? 2 : 1} };
        output.candidates.push({ ...c, id: "same-cause", rootCause: "別表現の原因" });
      }
      output.causeGroups = input.phase === "verification" ? [{ id: "wrong-value", members: ["spec:missing", "spec:same-cause"], rationale: "同じ公開値の誤りであり同時に直る" }] : [];
      output.requirements = output.requirements.map(({ id, status, implementation, verification, evidence, findingIds, findingLinks }) => ({ id, status, implementation, verification, evidence, findingLinks, findingIds: findingIds ?? [], scopeEvidence: null, rationale: "公開値を確認" }));
    `);
    const result = await f.run("--extra-usage-disabled");
    if (outside) {
      expect(result.json.score).toBeNull();
      expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "FINDING_UNVERIFIED" }));
    } else {
      expect(result.json).toMatchObject({ status: "completed", score: 2 });
      expect(result.json.findings[0].location.quote).toBe("  export const value = 4;");
      expect(result.json.findings[0].contract.quote).toBe("公開名valueで値2を返す。");
      expect(result.json.rootCauses).toHaveLength(1);
      expect(result.json.rootCauses[0].candidates).toHaveLength(2);
    }
  });
}

for (const mode of ["hash", "missing", "spec", "unresolved", "gap", "changed"] as const) {
  test(`規約適用計画の不整合・Spec除外・途中変更を未完了にする（${mode}）`, async () => {
    const f = await fixture();
    writeFileSync(join(f.repo, "README.md"), "公開名valueを維持する。\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "規約");
    const p = await f.cli("review", "prepare", "--repo", f.repo, "--base", "HEAD^", "--issue", f.issue);
    const standard = p.json.sources.find((s: any) => s.type === "standard");
    const row: any = { source: `standard:${standard.id}`, hash: standard.hash, ranges: [{ start: 1, end: 2, kind: "required", rationale: "公開名の規約を保持" }] };
    if (mode === "hash") row.hash = "違う版";
    if (mode === "spec") row.source = `issue:${f.issue}`;
    if (mode === "unresolved") row.ranges[0].kind = "unresolved";
    if (mode === "gap") row.ranges[0].end = 1;
    const plan = join(f.dir, "scope.json");
    writeFileSync(plan, JSON.stringify({ version: 1, standards: mode === "missing" ? [] : [row] }));
    adjudicatingClaude(f.dir, mode === "changed" ? `if (input.phase === "verification") await Bun.write(${JSON.stringify(plan)}, "{}");` : "");
    const result = await f.run("--scope-plan", plan, "--extra-usage-disabled");
    expect(result.json.score).toBeNull();
    expect(result.json.problems).toContainEqual(expect.objectContaining({ code: mode === "changed" ? "REQUIREMENTS_CHANGED" : mode === "unresolved" ? "SCOPE_UNVERIFIED" : "SCOPE_PLAN_INVALID" }));
    if (mode !== "changed") expect(result.json.execution.stages).toEqual([]);
  });
}


test("新形式は範囲宣言の充足を固定資料の引用で確認できる", async () => {
  const f = await fixture();
  await f.cli("issue", "update", f.issue, "--description", "今回の評価対象は公開値の契約だけとする。");
  adjudicatingClaude(f.dir, `
    output.format = 2; output.target = input.target.hash; output.causeGroups = [];
    output.requirements = output.requirements.map(r => ({ ...r, implementation: [{ source: r.reference.source, line: r.reference.line }], evidence: "固定した範囲宣言と今回の対象を照合した" }));
  `);
  const result = await f.run("--extra-usage-disabled");
  expect(result.json).toMatchObject({ status: "completed", score: 5 });
  expect(result.json.coverage[0].implementation[0].quote).toBe("今回の評価対象は公開値の契約だけとする。");
});

test("探索担当が候補の軸を変更したら検証前に拒否する", async () => {
  const f = await fixture();
  adjudicatingClaude(f.dir, missingRequirement + `
    output.format = 2; output.target = input.target.hash; output.causeGroups = [];
    if (input.phase === "spec") output.candidates[0].axis = "standards";
  `);
  const result = await f.run("--extra-usage-disabled");
  expect(result.json.score).toBeNull();
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "OUTPUT_INVALID" }));
  expect(result.json.execution.stages.some((s: any) => s.phase === "verification")).toBe(false);
});

test("既存のSpec未充足で今回の要求との関係が不明なら採点と自動修正を止める", async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "value.ts"), "export const value = 3;\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "既存の未充足");
  writeFileSync(join(f.repo, "notes.md"), "今回の説明変更\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "説明変更");
  adjudicatingClaude(f.dir, missingRequirement + `
    output.format = 2; output.target = input.target.hash;
    if (output.candidates.length) Object.assign(candidate, { origin: "pre_existing", baselineEvidence: { path: "value.ts", revision: "base", line: 1 }, changeEvidence: null });
    output.causeGroups = input.phase === "verification" ? [{ id: "wrong-value", members: ["spec:missing"], rationale: "基点から存在する公開値の不一致" }] : [];
  `);
  const result = await f.run("--extra-usage-disabled", "--repair-once");
  expect(result.json).toMatchObject({ status: "incomplete", score: null });
  expect(result.json.coverage[0].status).toBe("unsatisfied");
  expect(result.json.findings[0]).toMatchObject({ decision: "required", origin: "pre_existing", baselineEvidence: { quote: "export const value = 3;" } });
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "BASELINE_SCOPE_UNVERIFIED" }));
  expect(result.json.repair.model).toBeUndefined();
});


for (const mode of ["outside", "explicit", "missing_reference", "standard_only", "changed", "change_evidence", "unknown_finding", "mixed_requirement", "base_other_path", "sdk_single", "sdk_combined", "scope_other_line", "sdk_range", "sdk_range_substring"]) {
  test(`既存課題のスコープ判定を根拠と今回の要求に対応させる（${mode}）`, async () => {
    const f = await fixture();
    if (mode !== "explicit") await f.cli("issue", "update", f.issue, "--description", "参考の既存契約は公開名valueで値2を返すこと。\n今回の要求はnotes.mdの説明追加だけで、公開値の修正は含めない。");
    writeFileSync(join(f.repo, "README.md"), "# 規約\n公開名valueを保つ。\n");
    writeFileSync(join(f.repo, "value.ts"), "export const value = 3;\n");
    if (mode === "base_other_path") writeFileSync(join(f.repo, "peer.ts"), "export const value = 3;\n");
    if (mode.startsWith("sdk_")) writeFileSync(join(f.repo, "deps.lock"), mode.startsWith("sdk_range") ? '"library-a": "^1.2.3"\n' : "library-a@1.2.3\nlibrary-b@4.5.6\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "既存の未充足");
    writeFileSync(join(f.repo, "notes.md"), "今回の説明変更\n");
    if (mode === "changed") writeFileSync(join(f.repo, "value.ts"), "export const value = 4;\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "今回の変更");
    adjudicatingClaude(f.dir, missingRequirement + `
      if (input.scopePolicy !== "changes-and-explicit-requirements-v1") throw new Error("範囲方針が未指定");
      output.format = 2; output.target = input.target.hash;
      const scopeUnit = input.reviewUnits.filter(u => u.axis === "spec").at(-1);
      const referenceUnit = ${JSON.stringify(mode)} === "standard_only" ? { reference: { source: "standard:README.md", line: 2 } } : scopeUnit;
      Object.assign(candidate, {
        origin: "pre_existing", baselineEvidence: { path: ${JSON.stringify(mode === "base_other_path" ? "peer.ts" : "value.ts")}, revision: "base", line: 1 },
        changeEvidence: ${mode === "change_evidence" ? '{ path: "notes.md", revision: "head", line: 1 }' : 'null'},
        decision: ${JSON.stringify(mode === "explicit" ? "required" : "out_of_scope")}, scopeEvidence: null,
        scopeAssessment: { kind: ${JSON.stringify(mode === "explicit" ? "explicit_requirement" : "unrelated_existing")},
          rationale: ${JSON.stringify(mode === "explicit" ? "今回の要求が公開値の修正を指定している" : "基点から同じ公開値であり、今回の説明追加は利用条件を変えず値の修正を要求しない")},
          references: ${mode === "missing_reference" ? '[]' : '[{ source: referenceUnit.reference.source, line: referenceUnit.reference.line }]'} }
      });
      if (${JSON.stringify(mode)}.startsWith("sdk_")) candidate.sdk = { status: "verified", evidence: "固定した依存版と契約を照合した",
        version: ${JSON.stringify(mode === "sdk_combined" ? "library-a@1.2.3 / library-b@4.5.6" : mode === "sdk_range" ? "^1.2.3" : mode === "sdk_range_substring" ? "1.2.3" : "library-a@1.2.3")}, source: { path: "deps.lock", revision: "head", line: 1 } };
      output.requirements = output.requirements.map(r => r.id === unit.id ? { ...r,
        status: ${JSON.stringify(mode === "explicit" ? "unsatisfied" : "out_of_scope")},
        findingIds: [${JSON.stringify(mode === "unknown_finding" ? "unknown" : "missing")}], scopeEvidence: ${mode === "scope_other_line" ? "scopeUnit.reference" : "unit.reference"},
        evidence: "公開値3の未充足は残っている", rationale: candidate.scopeAssessment.rationale } : r);
      if (${JSON.stringify(mode)} === "mixed_requirement" && output.candidates.length) {
        output.candidates.push({ ...candidate, id: "new-problem", origin: "introduced", baselineEvidence: null,
          decision: "unverified", scopeAssessment: null, rootCause: "new-problem", scopeEvidence: null });
      }
      output.causeGroups = input.phase === "verification" ? output.candidates.map(c => ({ id: c.rootCause, members: ["spec:" + c.id], rationale: "それぞれの原因" })) : [];
    `);
    const result = await f.run("--extra-usage-disabled", ...(mode === "outside" ? ["--repair-once"] : []));
    if (mode === "outside" || mode === "sdk_single") {
      expect(result.json).toMatchObject({ status: "completed", score: 5, scopePolicy: "changes-and-explicit-requirements-v1", scope: { kind: "limited", excludedFindings: ["spec:missing"] } });
      expect(result.json.findings[0]).toMatchObject({ decision: "out_of_scope", baselineEvidence: { quote: "export const value = 3;" }, scopeAssessment: { kind: "unrelated_existing", references: [expect.objectContaining({ hash: expect.any(String), quote: expect.stringContaining("説明追加だけ") })] } });
      expect(result.json.coverage.find((r: any) => r.findingIds?.includes("missing"))).toMatchObject({ status: "out_of_scope", evidence: "公開値3の未充足は残っている" });
      expect(result.json.scope.excludedRequirements).toHaveLength(1);
      expect(result.json.repair?.model).toBeUndefined();
      expect(readFileSync(join(f.repo, "value.ts"), "utf8")).toBe("export const value = 3;\n");
    } else if (mode === "explicit") {
      expect(result.json).toMatchObject({ status: "completed", score: 2, review: { spec: "failed" } });
      expect(result.json.findings[0]).toMatchObject({ decision: "required", origin: "pre_existing", scopeAssessment: { kind: "explicit_requirement" } });
      expect(result.json.problems).toEqual([]);
      expect(result.json.coverage.find((r: any) => r.findingIds?.includes("missing"))?.status).toBe("unsatisfied");
    } else {
      expect(result.json).toMatchObject({ status: "incomplete", score: null });
      expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "COVERAGE_INCOMPLETE" }));
      expect(result.json.coverage.some((r: any) => r.status === "unverified")).toBe(true);
      const field = mode === "base_other_path" ? "baselineEvidence:" : mode.startsWith("sdk_") ? "sdk.source/version:" : mode === "scope_other_line" ? "scopeEvidence:" : null;
      if (field) expect(result.json.problems.some((p: any) => p.message.includes(field))).toBe(true);
      if (mode === "scope_other_line") expect(result.json.findings[0].decision).toBe("out_of_scope");
      if (mode === "base_other_path" || mode === "sdk_combined") expect(result.json.findings[0]).toMatchObject({ decision: "unverified", proposedDecision: "out_of_scope" });
    }
  });
}

for (const decision of ["required", "unverified", "optional"]) {
  test(`差分レビューの通常報告は任意提案を省き、同原因の採否と必須未確認を保持する（${decision}）`, async () => {
    const f = await fixture();
    if (decision !== "optional") {
      writeFileSync(join(f.repo, "value.ts"), "export const value = 3;\n");
      git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "値を変更");
    }
    adjudicatingClaude(f.dir, missingRequirement + `
      if (input.candidatePolicy !== "diff-defects-v1") throw new Error("候補方針が未指定");
      output.format = 2; output.target = input.target.hash;
      Object.assign(candidate, { origin: "introduced", changeEvidence: { path: "value.ts", revision: "head", line: 1 }, baselineEvidence: null,
        scopeAssessment: null, decision: ${JSON.stringify(decision)}, needsSpecificationDecision: ${decision === "unverified"}, rationale: "主候補の判定根拠" });
      if (output.candidates.length) output.candidates.push({ ...candidate, id: "suggestion", decision: "optional", needsSpecificationDecision: false, rationale: "通常報告に出さない整理提案" });
      output.requirements = output.requirements.map(r => r.id === unit.id ? { ...r, status: ${JSON.stringify(decision === "required" ? "unsatisfied" : decision === "unverified" ? "unverified" : "satisfied")} } : r);
      if (${JSON.stringify(decision)} === "optional") for (const r of output.requirements) { r.findingIds = []; r.findingLinks = []; }
      output.causeGroups = input.phase === "verification" ? [{ id: "shared-cause", members: ["spec:missing", "spec:suggestion"], rationale: "同じ箇所の改善でも採否は独立に保持する" }] : [];
    `);
    const result = await runNod(["review", "run", "--repo", f.repo, "--base", "HEAD^", "--issue", f.issue,
      "--provider", "claude", "--review-model", "claude-review-exact", "--implementation-models", "gpt-implementation-exact", "--extra-usage-disabled"], { cwd: f.repo, db: f.db, env: f.env });
    const artifactPath = result.stdout.match(/^保存先: (.+)$/m)?.[1];
    expect(artifactPath).toBeDefined();
    const artifact = JSON.parse(readFileSync(artifactPath!, "utf8"));
    expect(artifact.candidatePolicy).toBe("diff-defects-v1");
    expect(artifact.findings).toContainEqual(expect.objectContaining({ id: "suggestion", decision: "optional", rootCause: "shared-cause", rationale: "通常報告に出さない整理提案" }));
    expect(artifact.findings).toContainEqual(expect.objectContaining({ id: "missing", decision, rootCause: "shared-cause" }));
    expect(result.stdout).not.toContain("通常報告に出さない整理提案");
    expect(result.stdout).not.toContain("候補 spec:suggestion");
    if (decision === "optional") {
      expect(artifact).toMatchObject({ status: "completed", score: 5 });
      expect(result.stdout).not.toContain("候補 spec:missing");
      expect(result.exitCode).toBe(0);
    } else {
      expect(result.stdout).toContain(`候補 spec:missing: ${decision}`);
      expect(artifact).toMatchObject({ status: decision === "required" ? "completed" : "incomplete", score: decision === "required" ? 2 : null });
      expect(result.exitCode).toBe(1);
    }
  });
}

test("差分外の利用側でも変更された依存先との因果関係を示す指摘は維持する", async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "value.ts"), 'export { value } from "./provider";\n');
  writeFileSync(join(f.repo, "provider.ts"), "export const value = 2;\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "既存の利用側");
  writeFileSync(join(f.repo, "provider.ts"), "export const value = 3;\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "依存先の値を変更");
  adjudicatingClaude(f.dir, missingRequirement + `
    if (!(await Bun.file("value.ts").text()).includes('from "./provider"') || !(await Bun.file("provider.ts").text()).includes("value = 3")) throw new Error("関連コードが読めない");
    output.format = 2; output.target = input.target.hash;
    Object.assign(candidate, { origin: "introduced", changeEvidence: { path: "provider.ts", revision: "head", line: 1 }, baselineEvidence: null, scopeAssessment: null,
      rationale: "利用側は未変更だが依存先の変更で公開値が3になった", evidence: { kind: "static", detail: "providerの変更がvalueの再exportへ伝わる" } });
    output.causeGroups = input.phase === "verification" ? [{ id: "public-value-regression", members: ["spec:missing"], rationale: "依存先の変更による公開値の破綻" }] : [];
  `);
  const result = await f.run("--extra-usage-disabled");
  expect(result.json).toMatchObject({ status: "completed", score: 2, candidatePolicy: "diff-defects-v1" });
  expect(result.json.target.files).toEqual(["provider.ts"]);
  expect(result.json.findings[0]).toMatchObject({ decision: "required", location: { path: "value.ts" }, changeEvidence: { path: "provider.ts" } });
});

test("旧実行証拠オプションはモデル起動前に拒否する", async () => {
  const f = await fixture();
  const result = await f.run("--extra-usage-disabled", "--evidence-plan", join(f.dir, "unused.json"));
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("evidence-plan");
});

test("独立チェックの成功・失敗・未実行をレビューへ渡さず同じ入力契約で判定する", async () => {
  const f = await fixture(), trace = join(f.dir, "inputs.jsonl");
  adjudicatingClaude(f.dir, `
    const { appendFileSync } = await import("node:fs");
    if (input.executionEvidence !== undefined || input.executionChecks !== undefined) throw new Error("結果が混入");
    if (input.code.some(c => c.path.includes(".review-evidence"))) throw new Error("結果のファイルが混入");
    appendFileSync(${JSON.stringify(trace)}, JSON.stringify({phase: input.phase, target: input.target, units: input.reviewUnits, args: process.argv}) + "\\n");
  `);
  for (const status of ["passed", "failed", "not_run"]) {
    writeFileSync(join(f.repo, "check-result.json"), JSON.stringify({ status, diagnostic: "レビューへ渡さない外部診断" }));
    const result = await f.run("--extra-usage-disabled");
    expect(result.json, result.stderr).toMatchObject({ status: "completed", score: 5, reviewPolicy: "independent-v1" });
    expect(result.json.executionEvidence).toBeUndefined();
  }
  const rows = readFileSync(trace, "utf8").trim().split("\n").map(s => JSON.parse(s));
  expect(rows).toHaveLength(9);
  expect(new Set(rows.map(r => JSON.stringify({ target: r.target, units: r.units })) ).size).toBe(1);
  expect(rows.every(r => r.args[r.args.indexOf("--tools") + 1] === "Read,Grep,Glob")).toBe(true);
});

test("モデルが実行結果を自己申告してもレビュー証拠に採用しない", async () => {
  const f = await fixture();
  adjudicatingClaude(f.dir, `if (input.phase === "verification") output.requirements[0].verification = { method: "execution", detail: "Biome成功", recordIds: ["fabricated"] };`);
  const result = await f.run("--extra-usage-disabled");
  expect(result.json.score).toBeNull();
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "REVIEW_LAYER_VIOLATION" }));
});

for (const mode of ["valid", "unknown", "diagnostic", "changed", "ignored"] as const) test(`自動チェック担当の要求は事前固定した分担だけで対象外にする（${mode}）`, async () => {
  const f = await fixture();
  await f.cli("issue", "update", f.issue, "-d", "公開名valueで値2を返す。\nBiomeの書式検査を実行して成功する。");
  const prepared = await f.cli("review", "prepare", "--repo", f.repo, "--base", "HEAD^", "--issue", f.issue);
  const source = prepared.json.sources.find((s: any) => s.type === "issue");
  const plan = join(f.dir, "responsibility.json");
  const data: any = { version: 1, assignments: [{ sourceHash: mode === "unknown" ? "wrong" : source.hash, line: 2, owner: "automatic_check", rationale: "書式検査の実行と合否は自動チェック工程が担当する" }] };
  if (mode === "diagnostic") data.diagnostics = ["Biome成功"];
  writeFileSync(plan, JSON.stringify(data));
  adjudicatingClaude(f.dir, `
    for (const row of output.requirements) {
      const a = input.responsibility?.assignments.find(a => a.source === row.reference.source && a.line === row.reference.line);
      if (a && ${JSON.stringify(mode)} !== "ignored") Object.assign(row, { status: "out_of_scope", implementation: [], scopeEvidence: row.reference, rationale: a.rationale });
    }
    if (${JSON.stringify(mode)} === "changed" && input.phase === "verification") await Bun.write(${JSON.stringify(plan)}, "{}");
  `);
  const result = await f.run("--extra-usage-disabled", "--responsibility-plan", plan);
  if (mode === "valid") {
    expect(result.json, result.stderr).toMatchObject({ status: "completed", score: 5 });
    expect(result.json.coverage.map((r: any) => r.status)).toEqual(["satisfied", "out_of_scope"]);
    expect(result.json.coverage[1].rationale).toBe(data.assignments[0].rationale);
  } else {
    expect(result.json.score).toBeNull();
    expect(result.json.problems).toContainEqual(expect.objectContaining({ code: mode === "changed" ? "REQUIREMENTS_CHANGED" : mode === "ignored" ? "COVERAGE_INCOMPLETE" : "RESPONSIBILITY_INVALID" }));
    if (["unknown", "diagnostic"].includes(mode)) expect(result.json.execution.stages).toEqual([]);
  }
});

for (const mode of ["automatic", "with_hook", "missing", "stale", "conflicting", "review_outside", "unresolved", "omitted"] as const) {
  test(`候補の担当を根拠付きで分離し、hook不具合と判定不足を隠さない（${mode}）`, async () => {
    const f = await fixture();
    writeFileSync(join(f.repo, "biome.json"), '{"formatter":{"enabled":true}}\n');
    writeFileSync(join(f.repo, "check.sh"), "bunx biome check .\nexit 0\n");
    writeFileSync(join(f.repo, "README.md"), "# 開発規約\n書式はBiomeに従う。\n検査の失敗を終了コードへ伝播する。\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "検査設定とhook");
    adjudicatingClaude(f.dir, `
      output.format = 2; output.target = input.target.hash;
      const mode = ${JSON.stringify(mode)};
      const standard = { reference: { source: "standard:README.md", line: 2 } };
      const formatting = { id: "format", axis: "standards", target: input.target.hash,
        location: { path: "value.ts", revision: "head", line: 1 }, contract: { source: standard.reference.source, line: 2 },
        condition: "書式設定が適用されるファイル", failure: "書式違反の候補であり実行結果は確認しない", impact: { score: 4, description: "書式の問題のみ" },
        evidence: { kind: "static", detail: "固定formatter設定から担当を確認した", recordIds: [] }, reproduction: "レビュー内では検査を実行しない", rootCause: "formatting",
        decision: "out_of_scope", rationale: "書式の合否は自動チェック担当", defense: "既存formatter設定を確認", sdk: { status: "not_applicable", evidence: "書式の担当判定" },
        scopeEvidence: null, needsSpecificationDecision: false, changeEvidence: null, origin: "introduced", baselineEvidence: null,
        responsibility: { owner: "automatic_check", rationale: "formatterが有効な設定であり書式違反の確認を担当する", references: [{ path: "biome.json", revision: "head", line: 1 }, { source: standard.reference.source, line: 2 }] } };
      if (mode === "missing") formatting.responsibility.references = [];
      if (mode === "stale") formatting.responsibility.references[0].line = 999;
      if (mode === "conflicting") formatting.decision = "unverified";
      if (mode === "review_outside") formatting.responsibility.owner = "review";
      if (mode === "unresolved") { formatting.responsibility.owner = "unresolved"; formatting.decision = "unverified"; }
      if (mode === "omitted") delete formatting.responsibility;
      const hook = { ...formatting, id: "hook", location: { path: "check.sh", revision: "head", line: 2 }, contract: { source: standard.reference.source, line: 3 },
        condition: "Biomeが非0で終了する", failure: "後続のexit 0が先行コマンドの失敗を消す", impact: { score: 3, description: "検査ゲートの失敗伝播が壊れる" },
        evidence: { kind: "static", detail: "check.shの先行コマンドの終了状態を捨ててexit 0している", recordIds: [] },
        decision: "required", rootCause: "exit-propagation", rationale: "検査の合否そのものではなく制御の不具合", changeEvidence: { path: "check.sh", revision: "head", line: 2 },
        responsibility: { owner: "review", rationale: "Biomeという語を含むが終了値の制御を確認する", references: [{ path: "check.sh", revision: "head", line: 2 }] } };
      output.candidates = input.phase === "spec" ? [] : mode === "with_hook" ? [formatting, hook] : [formatting];
      if (mode === "with_hook") for (const r of output.requirements) if (r.reference.source === "standard:README.md" && r.reference.line === 3) Object.assign(r, { status: "unsatisfied", findingIds: ["hook"], findingLinks: [{ findingId: "hook", requirementEvidence: [r.reference, { source: r.reference.source, line: 2 }], codeEvidence: [hook.location],
        operation: { requirement: "検査を実行する", candidate: "検査を実行する", match: "same" },
        condition: { requirement: "検査が失敗したとき", candidate: "検査が失敗したとき", match: "same" },
        obligation: { requirement: "失敗を終了コードへ伝播する", candidate: "失敗を終了コードへ伝播する", match: "same" },
        effectOfFix: "resolves_this_violation", rationale: "無条件のexit 0を直せば、当該検査の失敗終了値が呼出元へ伝播する" }] });
      output.causeGroups = input.phase === "verification" ? output.candidates.map(c => ({ id: c.rootCause, members: [c.axis + ":" + c.id], rationale: "書式と終了値の制御は異なる原因" })) : [];
    `);
    const result = await f.run("--extra-usage-disabled");
    if (mode === "automatic" || mode === "with_hook") {
      expect(result.json, result.stderr).toMatchObject({ status: "completed", score: mode === "with_hook" ? 3 : 5, problems: [] });
      expect(result.json.findings[0]).toMatchObject({ id: "format", decision: "out_of_scope", responsibility: { owner: "automatic_check", references: [
        { path: "biome.json", quote: '{"formatter":{"enabled":true}}' }, { source: "standard:README.md", quote: "書式はBiomeに従う。" },
      ] } });
      expect(result.json.coverage.some((r: any) => r.status === "out_of_scope")).toBe(false);
      if (mode === "with_hook") {
        expect(result.json.findings[1]).toMatchObject({ id: "hook", decision: "required", responsibility: { owner: "review" } });
        expect(result.json.coverage).toContainEqual(expect.objectContaining({ status: "unsatisfied", findingIds: ["hook"] }));
      }
      expect(JSON.parse(readFileSync(result.json.artifactPath, "utf8")).findings).toEqual(result.json.findings);
    } else {
      expect(result.json).toMatchObject({ status: "incomplete", score: null });
      expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "FINDING_UNVERIFIED" }));
      expect(result.json.findings[0].decision).toBe("unverified");
    }
  });
}

for (const [subtype, apiStatus, expectedCode] of [
  ["error_max_structured_output_retries", null, "OUTPUT_INVALID"],
  ["error_during_execution", 500, "CLI_FAILED"],
  ["PRIVATE_ERROR_SENTINEL", null, "CLI_FAILED"],
  ["success", null, "CLI_FAILED"],
] as const) {
  test(`非0終了の安全なmetadataを保持し、本文を漏らさず成功にしない（${subtype}）`, async () => {
    const f = await fixture();
    fakeClaude(f.dir, `
      if (process.argv.includes("status")) console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }));
      else {
        await Bun.stdin.text();
        console.log(JSON.stringify({ type: "result", subtype: ${JSON.stringify(subtype)}, api_error_status: ${JSON.stringify(apiStatus)}, errors: ["PRIVATE_ERROR_SENTINEL"], modelUsage: { "claude-review-effective": {} }, usage: { output_tokens: 12 } }));
        console.error("PRIVATE_STDERR_SENTINEL");
        process.exit(1);
      }
    `);
    const result = await f.run("--extra-usage-disabled");
    expect(result.json).toMatchObject({ status: "incomplete", score: null });
    const stage = result.json.execution.stages.find((s: any) => s.cliStatus);
    expect(stage).toMatchObject({ status: "incomplete", output: null, effectiveModels: ["claude-review-effective"], usage: { output_tokens: 12 },
      cliStatus: { exitCode: 1, resultSubtype: subtype === "PRIVATE_ERROR_SENTINEL" ? "unrecognized" : subtype, apiErrorStatus: apiStatus }, problem: { code: expectedCode } });
    const artifact = readFileSync(result.json.artifactPath, "utf8");
    expect(artifact).not.toContain("PRIVATE_ERROR_SENTINEL");
    expect(artifact).not.toContain("PRIVATE_STDERR_SENTINEL");
    expect(result.json.execution.stages.some((s: any) => s.phase === "verification")).toBe(false);
  });
}


test("探索2軸と検証へ行の固定IDと条件を含む段落文脈を渡す", async () => {
  const f = await fixture();
  await f.cli("issue", "update", f.issue, "--description", "登録時は、\n公開名valueで値2を返す。\n\n取消時は別処理とする。");
  adjudicatingClaude(f.dir, `
    const units = input.reviewUnits.filter(u=>u.axis === "spec");
    const paragraph = unit => unit.paragraph && input.reviewParagraphs.find(p => p.id === unit.paragraph).content;
    if (units.length !== 3 || paragraph(units[0]) !== "登録時は、\\n公開名valueで値2を返す。" || units[1].paragraph !== units[0].paragraph || units[2].paragraph !== undefined) throw new Error("条件や別操作の境界が変わった");
    output.format = 2; output.target = input.target.hash; output.causeGroups = [];
  `);
  const result = await f.run("--extra-usage-disabled");
  expect(result.json.status).toBe("completed");
  expect(result.json.execution.stages).toHaveLength(3);
  expect(result.json.coverage[1]).toMatchObject({ requirement: "公開名valueで値2を返す。", context: { startLine: 1, endLine: 2, content: "登録時は、\n公開名valueで値2を返す。" } });
});

for (const mode of ["valid", "missing", "operation", "condition", "obligation", "unchanged", "unknown", "unrelated_code", "wrong_source", "duplicate"] as const) {
  test(`要求への対応が不明でも独立した必須候補を消さず、対応記録を保存する（${mode}）`, async () => {
    const f = await fixture();
    writeFileSync(join(f.repo, "value.ts"), "export const value = 3;\n");
    writeFileSync(join(f.repo, "other.ts"), "export const other = 1;\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "対象");
    adjudicatingClaude(f.dir, missingRequirement + `
      output.format = 2; output.target = input.target.hash;
      for (const c of output.candidates) c.changeEvidence = c.location;
      output.causeGroups = input.phase === "verification" ? [{ id: "wrong-value", members: ["spec:missing"], rationale: "公開値の誤り" }] : [];
      if (input.phase === "verification") {
        const r = output.requirements.find(r => r.id === unit.id), link = r.findingLinks[0], mode = ${JSON.stringify(mode)};
        if (mode === "missing") delete r.findingLinks;
        if (["operation", "condition", "obligation"].includes(mode)) link[mode].match = "different";
        if (["unchanged", "unknown"].includes(mode)) link.effectOfFix = mode;
        if (mode === "unrelated_code") link.codeEvidence = [{ path: "other.ts", revision: "head", line: 1 }];
        if (mode === "wrong_source") link.requirementEvidence = [];
        if (mode === "duplicate") r.findingLinks.push(link);
      }
    `);
    const result = await f.run("--extra-usage-disabled");
    expect(result.json.findings[0]).toMatchObject({ id: "missing", decision: "required" });
    expect(result.json.score).toBe(mode === "valid" ? 2 : null);
    const row = result.json.coverage.find((r: any) => r.findingIds?.includes("missing"));
    expect(row.status).toBe(mode === "valid" ? "unsatisfied" : "unverified");
    if (mode === "valid") {
      expect(row.findingLinks[0].requirementEvidence[0].quote).toBe("公開名valueで値2を返す。");
      expect(row.findingLinks[0].codeEvidence[0].quote).toBe("export const value = 3;");
    } else expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "REQUIREMENT_LINK_UNVERIFIED" }));
    expect(JSON.parse(readFileSync(result.json.artifactPath, "utf8")).coverage).toEqual(result.json.coverage);
  });
}

// 新形式の契約を偽モデルからCLI全体へ通す。実モデルの発見率の評価ではない。
const modernRequirements = `
  output.format = 3; output.target = input.target.hash; output.causeGroups = [];
  for (const row of output.requirements) {
    row.findingIds ??= []; row.findingLinks ??= []; row.scopeEvidence ??= null; row.rationale ??= "固定本文を確認した";
    row.contentAssessment = { kind: "obligation", obligations: [row.requirement], rationale: "今回の実装に適用する要求", references: row.requiredAssessmentReferences };
  }
`;

for (const mode of ["context", "mixed", "erased", "missing_reference", "different_kind", "unknown", "missing_implementation"] as const) test(`本文分類と説明の記録を保存し、分類で必須要求を隠さない（${mode}）`, async () => {
  const f = await fixture();
  const mixed = ["mixed", "erased", "missing_implementation"].includes(mode);
  await f.cli("issue", "update", f.issue, "-d", mixed ? "過去の調査は未完了である。公開名valueで値2を返す。" : "過去の調査は未完了である。\n\n公開名valueで値2を返す。");
  adjudicatingClaude(f.dir, modernRequirements + `
    const row = output.requirements.find(r => r.reference.line === 1);
    if (row) {
      row.contentAssessment.kind = ${JSON.stringify(mixed ? "mixed" : "validation_gap")};
      row.contentAssessment.obligations = ${JSON.stringify(mixed ? ["公開名valueで値2を返す。"] : [])};
      if (!${mixed}) { row.status = "context"; row.implementation = []; }
      if (input.phase === "verification") {
        const exploration = input.candidates.find(s => s.axis === "spec").requirements.find(r => r.id === row.id);
        if (!exploration.contentAssessment) throw new Error("探索の分類記録が失われた");
        const mode = ${JSON.stringify(mode)};
        if (mode === "erased") { row.contentAssessment.kind = "validation_gap"; row.contentAssessment.obligations = []; row.status = "context"; row.implementation = []; }
        if (mode === "missing_reference") row.contentAssessment.references = [];
        if (mode === "different_kind") row.contentAssessment.kind = "background";
        if (mode === "unknown") { row.contentAssessment.kind = "unknown"; row.status = "unverified"; }
        if (mode === "missing_implementation") row.implementation = [];
      }
    }
  `);
  const result = await f.run("--extra-usage-disabled");
  const good = ["context", "mixed"].includes(mode);
  expect(result.json, result.stderr).toMatchObject({ status: good ? "completed" : "incomplete", score: good ? 5 : null });
  expect(result.json.coverage[0].status).toBe(good ? mode === "context" ? "context" : "satisfied" : "unverified");
  expect(result.json.sources.some((s: any) => s.content.includes("過去の調査は未完了"))).toBe(true);
  expect(JSON.parse(readFileSync(result.json.artifactPath, "utf8")).coverage).toEqual(result.json.coverage);
});

for (const mode of ["valid", "wrong_axis", "behavior", "satisfied", "unknown"] as const) test(`他軸の要対応をSpecの未充足に関連付け、採否と両軸の結果を保持する（${mode}）`, async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "value.ts"), "export const value = 3;\n");
  writeFileSync(join(f.repo, "README.md"), "# 規約\n公開名valueを維持する。\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "公開契約を変更");
  adjudicatingClaude(f.dir, missingRequirement + modernRequirements + `
    candidate.axis = "standards"; candidate.expectedBehavior = "値2を返す"; candidate.changeEvidence = candidate.location;
    output.candidates = input.phase === "spec" ? [] : [candidate];
    output.causeGroups = input.phase === "verification" ? [{ id: "wrong-value", members: ["standards:missing"], rationale: "公開定数の値" }] : [];
    for (const row of output.requirements) if (row.id === unit.id) {
      row.findingIds = ["standards:missing"];
      for (const link of row.findingLinks) Object.assign(link, { findingAxis: "standards", relation: "violation", observedBehavior: candidate.failure });
      if (input.phase === "verification") {
        const mode = ${JSON.stringify(mode)}, link = row.findingLinks[0];
        if (mode === "wrong_axis") link.findingAxis = "spec";
        if (mode === "behavior") link.obligation.candidate = candidate.failure;
        if (mode === "satisfied") row.status = "satisfied";
        if (mode === "unknown") { row.status = "unverified"; row.findingIds = []; link.relation = "unresolved"; link.condition.match = "unknown"; }
      }
    }
  `);
  const result = await f.run("--extra-usage-disabled");
  expect(result.json.findings[0]).toMatchObject({ axis: "standards", id: "missing", decision: "required", expectedBehavior: "値2を返す" });
  expect(result.json.score).toBe(mode === "valid" ? 2 : null);
  expect(result.json.review).toEqual({ standards: "failed", spec: mode === "valid" ? "failed" : "incomplete" });
  expect(result.json.coverage.find((r: any) => r.axis === "spec").status).toBe(mode === "valid" ? "unsatisfied" : "unverified");
});

for (const mixed of [false, true]) test(`URL到達性は独立検査へ分担し、同じ文の設計要求は消さない（mixed=${mixed}）`, async () => {
  const f = await fixture();
  await f.cli("issue", "update", f.issue, "-d", "公開名valueで値2を返す。\n\n外部URLの現在の到達性を検査する。" + (mixed ? "失敗を終了コードへ伝える。" : ""));
  const prepared = await f.cli("review", "prepare", "--repo", f.repo, "--base", "HEAD^", "--issue", f.issue);
  const source = prepared.json.sources.find((s: any) => s.type === "issue");
  const plan = join(f.dir, "responsibility.json");
  const assignment = { sourceHash: source.hash, line: 3, owner: "automatic_check", rationale: "外部の稼働状態は独立した検査で確認する" };
  writeFileSync(plan, JSON.stringify({ version: 1, assignments: [assignment] }));
  adjudicatingClaude(f.dir, modernRequirements + `
    const row = output.requirements.find(r => r.reference.line === 3);
    if (row) {
      const a = input.responsibility.assignments[0];
      row.status = "out_of_scope"; row.implementation = []; row.scopeEvidence = row.reference; row.rationale = a.rationale;
      row.contentAssessment.kind = "independent_check"; row.contentAssessment.obligations = [];
      if (${mixed} && input.phase === "spec") { row.contentAssessment.kind = "mixed"; row.contentAssessment.obligations = ["失敗を終了コードへ伝える。"]; }
    }
  `);
  const result = await f.run("--extra-usage-disabled", "--responsibility-plan", plan);
  expect(result.json.score).toBe(mixed ? null : 5);
  expect(result.json.coverage.find((r: any) => r.reference.line === 3).status).toBe(mixed ? "unverified" : "out_of_scope");
});

for (const withStandard of [false, true]) test(`担当要求だけを出力schemaへ割り当て、本文分類の参照を行別に示す（規約=${withStandard}）`, async () => {
  const f = await fixture();
  await f.cli("issue", "update", f.issue, "-d", "利用時は、\n公開名valueで値2を返す。");
  if (withStandard) {
    writeFileSync(join(f.repo, "README.md"), "# 規約\n公開名valueを維持する。\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "規約を固定する");
  }
  adjudicatingClaude(f.dir, modernRequirements + `
    const schema = JSON.parse(process.argv[process.argv.indexOf("--json-schema") + 1]);
    const assigned = input.reviewUnits.filter(u => input.phase === "verification" || u.axis === input.phase);
    if (JSON.stringify(input.assignedRequirementIds) !== JSON.stringify(assigned.map(u => u.id))) throw new Error("担当IDが一致しない");
    const req = schema.properties.requirements;
    if (req.maxItems !== assigned.length) throw new Error("担当件数が制約されていない");
    if (assigned.length && JSON.stringify(req.items.properties.id.enum) !== JSON.stringify(assigned.map(u => u.id))) throw new Error("他軸IDを出力可能");
    const second = input.reviewUnits.find(u => u.axis === "spec" && u.reference.line === 2);
    if (!second || JSON.stringify(second.requiredAssessmentReferences.map(r => r.line)) !== "[2,1]") throw new Error("行と段落の参照がない");
    if (input.phase === "verification" && !input.assignedRequirementIds.includes(second.id)) throw new Error("検証から要求が落ちた");
  `);
  const result = await f.run("--extra-usage-disabled");
  expect(result.json, result.stderr).toMatchObject({ status: "completed", score: 5 });
  expect(result.json.execution.stages).toHaveLength(3);
  if (!withStandard) expect(result.json.execution.stages[0].output.requirements).toEqual([]);
});

test("出力schemaを無視した他軸の要求IDを復元時にも拒否する", async () => {
  const f = await fixture();
  adjudicatingClaude(f.dir, modernRequirements + `
    if (input.phase === "standards") output.requirements = [{ id: input.reviewUnits.find(u => u.axis === "spec").id }];
  `);
  const result = await f.run("--extra-usage-disabled");
  expect(result.json).toMatchObject({ status: "incomplete", score: null });
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "OUTPUT_INVALID", message: "今回の確認対象にない要求IDです" }));
});

for (const effort of [undefined, "high"] as const) test(`明示したeffortを全レビュー工程へ渡し、省略時は上書きしない（${effort ?? "省略"}）`, async () => {
  const f = await fixture();
  adjudicatingClaude(f.dir, modernRequirements + `
    const index = process.argv.indexOf("--effort");
    if (${effort !== undefined} ? index < 0 || process.argv[index + 1] !== "high" : index !== -1) throw new Error("effort指定が変わった");
  `);
  const result = await f.run("--extra-usage-disabled", ...(effort ? ["--review-effort", effort] : []));
  expect(result.json).toMatchObject({ status: "completed", score: 5 });
  expect(result.json.execution.stages).toHaveLength(3);
  expect(result.json.execution.requestedEffort).toBe(effort);
  expect(JSON.parse(readFileSync(result.json.initialReviewPath, "utf8")).execution.requestedEffort).toBe(effort);
});

test("未対応のeffortはモデルを起動せず未完了にする", async () => {
  const f = await fixture(), marker = join(f.dir, "unexpected-call");
  fakeClaude(f.dir, `await Bun.write(${JSON.stringify(marker)}, "called");`);
  const result = await f.run("--extra-usage-disabled", "--review-effort", "invalid");
  expect(result.json).toMatchObject({ status: "incomplete", score: null });
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "INVALID_REVIEW_EFFORT" }));
  expect(existsSync(marker)).toBe(false);
});

test("high指定でも実装モデルとの重複はモデル起動前に拒否する", async () => {
  const f = await fixture(), marker = join(f.dir, "unexpected-call");
  fakeClaude(f.dir, `await Bun.write(${JSON.stringify(marker)}, "called");`);
  const result = await f.run("--extra-usage-disabled", "--review-effort", "high", "--review-model", "claude-opus-5-5", "--implementation-models", "claude-opus-5-5");
  expect(result.json).toMatchObject({ status: "incomplete", score: null });
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "MODEL_OVERLAP" }));
  expect(existsSync(marker)).toBe(false);
});

test("出典の診断を工程・全体・初回記録へ保存し、不正なモデル文字列を残さない", async () => {
  const f = await fixture();
  adjudicatingClaude(f.dir, modernRequirements + `
    if (input.phase === "spec") output.requirements[0].contentAssessment.references = [{ source: "未検証の秘密値に相当する文字列", line: 7 }];
  `);
  const result = await f.run("--extra-usage-disabled");
  expect(result.json).toMatchObject({ status: "incomplete", score: null });
  const problem = result.json.problems.find((p: any) => p.referenceDiagnostic);
  expect(problem).toMatchObject({ code: "OUTPUT_INVALID", referenceDiagnostic: { reason: "unknown_source", field: "requirements[0].contentAssessment.references[0]", requirementUnitIndex: 0, sourceIndex: null, line: 7 } });
  expect(result.json.execution.stages.find((s: any) => s.phase === "spec").problem).toEqual(problem);
  for (const path of [result.json.artifactPath, result.json.initialReviewPath]) {
    const saved = readFileSync(path, "utf8");
    expect(JSON.parse(saved).problems).toContainEqual(problem);
    expect(saved).not.toContain("未検証の秘密値に相当する文字列");
  }
});

for (const mode of ["typed", "untyped"] as const) test(`規約の出典を資料索引と同じtype:idで指示・復元し、型なしIDは補正せず拒否する（${mode}）`, async () => {
  const f = await fixture(), trace = join(f.dir, "inputs.jsonl");
  writeFileSync(join(f.repo, "AGENTS.md"), "# 規約\n公開名valueを保つ。\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "規約を追加");
  adjudicatingClaude(f.dir, modernRequirements + `
    require("node:fs").appendFileSync(${JSON.stringify(trace)}, JSON.stringify(input) + "\\n");
    if (${mode === "untyped"} && input.phase === "standards") output.requirements[0].contentAssessment.references = [{ source: "AGENTS.md", line: 2 }];
  `);
  const result = await f.run("--extra-usage-disabled");
  const inputs = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const sourceIndex = result.json.sources.findIndex((s: any) => s.type === "standard" && s.id === "AGENTS.md");
  for (const input of inputs) {
    // 出典の指示は資料索引のtype:idだけを返させ、hash・quoteを出力形式として示さない。
    const instructions = input.instructions + input.adjudicationInstructions;
    expect(instructions).toContain("sources[].source");
    expect(instructions).not.toMatch(/\{source[^}]*(hash|quote)/);
    expect(input.sources).toContainEqual(expect.objectContaining({ source: "standard:AGENTS.md" }));
  }
  if (mode === "untyped") {
    expect(result.json).toMatchObject({ status: "incomplete", score: null });
    expect(inputs.map(input => input.phase)).not.toContain("verification");
    expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "OUTPUT_INVALID", referenceDiagnostic: { reason: "unknown_source", field: "requirements[0].contentAssessment.references[0]",
      requirementUnitIndex: expect.any(Number), sourceIndex: null, sourceForm: "id_without_type", matchedSourceIndex: sourceIndex, line: 2, lineCount: null } }));
    return;
  }
  expect(result.json, result.stderr).toMatchObject({ status: "completed", score: 5 });
  const standard = result.json.sources[sourceIndex];
  expect(result.json.execution.stages.find((s: any) => s.phase === "standards").output.requirements[0].contentAssessment.references)
    .toEqual([{ source: "standard:AGENTS.md", line: 2, hash: standard.hash, quote: "公開名valueを保つ。" }]);
  // 検証へ渡す探索記録の出典も、資料索引と同じtype:idのまま保つ。
  const verification = inputs.find(input => input.phase === "verification"), cited: string[] = [];
  const walk = (node: any): void => { if (!node || typeof node !== "object") return; if (typeof node.source === "string" && Number.isInteger(node.line)) cited.push(node.source); Object.values(node).forEach(walk); };
  walk(verification.candidates);
  expect(cited).toContain("standard:AGENTS.md");
  const indexed = verification.sources.map((s: any) => s.source);
  for (const source of cited) expect(indexed).toContain(source);
});

for (const forgedQuote of [false, true]) test(`format=3の固定引用を復元し、明示された偽の引用は補正しない（forged=${forgedQuote}）`, async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "legacy.ts"), "export const legacy = 1;\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "既存の実装");
  writeFileSync(join(f.repo, "value.ts"), "export const value = 2; // 公開値\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "公開値の説明");
  await f.cli("issue", "update", f.issue, "-d", "公開名valueで値2を返す。\n\n今回の対象はvalue.tsのみとする。");
  adjudicatingClaude(f.dir, modernRequirements + `
    const ref = input.reviewUnits.find(u => u.axis === "spec" && u.reference.line === 3)?.reference;
    const candidate = { id: "existing", axis: "spec", target: input.target.hash,
      location: { path: "legacy.ts", revision: "head", line: 1 }, baselineEvidence: { path: "legacy.ts", revision: "base", line: 1 },
      origin: "pre_existing", changeEvidence: null, contract: { path: "legacy.ts", revision: "head", line: 1 },
      condition: "旧APIを使う", expectedBehavior: "旧APIの公開値を使う", failure: "従来の制約が残る", impact: { score: 3, description: "従来の利用制限" },
      evidence: { kind: "static", detail: "基点と同じ行で今回の影響を受けない", recordIds: [] }, reproduction: "旧APIを参照する", rootCause: "old-behavior",
      decision: "out_of_scope", rationale: "今回の対象外", defense: "新しい公開値とは独立", sdk: { status: "not_applicable", evidence: "定数の公開のみ", version: null, source: null },
      scopeEvidence: null, needsSpecificationDecision: false,
      responsibility: { owner: "review", rationale: "公開契約", references: [{ path: "legacy.ts", revision: "head", line: 1 }] },
      scopeAssessment: { kind: "unrelated_existing", rationale: "対象はvalue.tsのみで旧APIを変更しない", references: [ref, { path: "legacy.ts", revision: "base", line: 1 }] } };
    if (${forgedQuote}) candidate.baselineEvidence.quote = "export const legacy = 999;";
    output.candidates = input.phase === "standards" ? [] : [candidate];
    output.causeGroups = input.phase === "verification" ? [{ id: "old-behavior", members: ["spec:existing"], rationale: "従来の制約" }] : [];
  `);
  const result = await f.run("--extra-usage-disabled");
  expect(result.json, result.stderr).toMatchObject({ status: forgedQuote ? "incomplete" : "completed", score: forgedQuote ? null : 5 });
  expect(result.json.findings[0]).toMatchObject({ decision: forgedQuote ? "unverified" : "out_of_scope", location: { quote: "export const legacy = 1;" }, baselineEvidence: { quote: forgedQuote ? "export const legacy = 999;" : "export const legacy = 1;" } });
  expect(result.json.findings[0].responsibility.references[0].quote).toBe("export const legacy = 1;");
});

for (const mode of ["separate", "missing", "unknown"] as const) test(`段落内の背景を別契約の指摘から分離しても不具合と採点を保持する（${mode}）`, async () => {
  const f = await fixture();
  await f.cli("issue", "update", f.issue, "-d", "公開名valueで値2を返す。\n旧版は内部の利用者だけが使っていた。");
  writeFileSync(join(f.repo, "value.ts"), "export const value = 3;\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "公開値の違反を固定");
  adjudicatingClaude(f.dir, missingRequirement + modernRequirements + `
    candidate.expectedBehavior = "値2を返す"; candidate.changeEvidence = candidate.location;
    output.causeGroups = input.phase === "verification" ? [{ id: "wrong-value", members: ["spec:missing"], rationale: "公開定数の値" }] : [];
    for (const row of output.requirements) {
      if (row.reference.line === 1) {
        row.findingIds = ["spec:missing"];
        for (const link of row.findingLinks) Object.assign(link, { findingAxis: "spec", relation: "violation", observedBehavior: candidate.failure });
      } else {
        row.status = "context"; row.implementation = [];
        row.contentAssessment.kind = "background"; row.contentAssessment.obligations = [];
        if (input.phase === "verification" && ${JSON.stringify(mode)} !== "missing") row.findingLinks = [{
          findingAxis: "spec", findingId: "missing", relation: "rejected", observedBehavior: candidate.failure,
          requirementEvidence: [row.reference, unit.reference], codeEvidence: [candidate.location],
          operation: { requirement: "過去の利用状況の説明", candidate: "valueをimportする", match: "different" },
          condition: { requirement: "過去の経緯", candidate: "現在の公開値の利用", match: ${JSON.stringify(mode === "unknown" ? "unknown" : "different")} },
          obligation: { requirement: "追加の実装義務なし", candidate: candidate.expectedBehavior, match: "different" },
          effectOfFix: "unchanged", rationale: "公開値の修正は過去の利用状況の説明に影響しない"
        }];
      }
    }
  `);
  const result = await f.run("--extra-usage-disabled");
  expect(result.json, JSON.stringify(result.json.problems)).toHaveProperty("findings");
  expect(result.json.findings).toContainEqual(expect.objectContaining({ axis: "spec", id: "missing", decision: "required" }));
  expect(result.json.coverage.find((r: any) => r.reference.line === 1).status).toBe("unsatisfied");
  expect(result.json.coverage.find((r: any) => r.reference.line === 2).status).toBe(mode === "separate" ? "context" : "unverified");
  expect(result.json.status).toBe(mode === "separate" ? "completed" : "incomplete");
  expect(result.json.score).toBe(mode === "separate" ? 2 : null);
});

for (const mode of ["delete_base", "delete_head_context", "delete_base_context", "delete_missing", "replace_head", "replace_base", "file_delete_base"] as const)
  test(`削除・置換の根拠と指摘位置を分離し、不適切な変更参照を診断する（${mode}）`, async () => {
    const f = await fixture();
    await f.cli("issue", "update", f.issue, "-d", "api.tsの公開関数valueは値2を返す。");
    writeFileSync(join(f.repo, "api.ts"), "export function value() {\n  let result = 3;\n  result = 2;\n  return result;\n}\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "正常な公開関数を固定");
    if (mode === "file_delete_base") git(f.repo, "rm", "api.ts");
    else writeFileSync(join(f.repo, "api.ts"), mode.startsWith("replace")
      ? "export function value() {\n  let result = 3;\n  result = 4;\n  return result;\n}\n"
      : "export function value() {\n  let result = 3;\n  return result;\n}\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "公開関数の回帰を固定");
    const rejected = ["delete_head_context", "delete_base_context", "delete_missing"].includes(mode);
    const changeEvidence = mode === "delete_missing" ? null : { path: "api.ts", revision: ["delete_head_context", "replace_head"].includes(mode) ? "head" : "base", line: mode === "delete_base_context" ? 1 : 3 };
    adjudicatingClaude(f.dir, missingRequirement + modernRequirements + `
      candidate.location = { path: "api.ts", revision: ${JSON.stringify(mode === "file_delete_base" ? "base" : "head")}, line: 3 };
      candidate.expectedBehavior = "値2を返す"; candidate.condition = "公開関数valueを呼び出す";
      candidate.failure = ${JSON.stringify(mode === "file_delete_base" ? "関数が削除され利用できない" : mode.startsWith("replace") ? "値4を返す" : "値3を返す")};
      candidate.changeEvidence = ${JSON.stringify(changeEvidence)}; candidate.origin = "introduced";
      output.causeGroups = input.phase === "verification" ? [{ id: "wrong-value", members: ["spec:missing"], rationale: "公開関数の回帰" }] : [];
      for (const row of output.requirements) {
        row.implementation = [candidate.location]; row.findingIds = ["spec:missing"];
        for (const link of row.findingLinks) Object.assign(link, { findingAxis: "spec", relation: "violation", observedBehavior: candidate.failure, codeEvidence: [candidate.location], operation: { requirement: "公開関数valueを呼ぶ", candidate: "公開関数valueを呼ぶ", match: "same" } });
      }
    `);
    const r = await f.run("--extra-usage-disabled");
    expect(r.json, JSON.stringify(r.json.problems)).toMatchObject({ status: rejected ? "incomplete" : "completed", score: rejected ? null : 2 });
    if (changeEvidence) expect(r.json.findings[0].changeEvidence).toMatchObject(changeEvidence);
    else expect(r.json.findings[0].changeEvidence).toBeNull();
    if (rejected) expect(r.json.problems).toContainEqual(expect.objectContaining({ code: "FINDING_UNVERIFIED", message: expect.stringContaining("changeEvidence: 追加行はhead、削除行はbase") }));
    else expect(r.json.findings[0].decision).toBe("required");
  });
