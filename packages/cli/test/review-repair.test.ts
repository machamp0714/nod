import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

async function fixture(options: { repairBody?: string; reviewBody?: string; check?: string; preparation?: string; repairModels?: string[] } = {}) {
  const repo = makeRepo();
  const db = tempDb();
  registerRepo(db, repo, "FIX");
  writeFileSync(join(repo, "value.ts"), "export const value = 3;\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "修正対象");
  const dir = tempDir("repair-cli-");
  const env = { NOD_DOCS_DIR: tempDir("repair-docs-"), PATH: `${dir}:${process.env.PATH}` };
  const cli = (...args: string[]) => runNod([...args, "--json"], { cwd: repo, db, env });
  const issue = (await cli("issue", "create", "公開値を2にする", "--description", "公開名valueで値2を返す。")).json.id;
  const model = join(dir, "claude");
  writeFileSync(model, `#!/usr/bin/env bun
    if (process.argv.includes("status")) console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }));
    else {
      const input = JSON.parse(await Bun.stdin.text());
      let output;
      if (input.phase === "repair") {
        output = { completed: true, target: input.target.hash, needsSpecificationDecision: false, rationale: "確定した公開値の要求へ戻す", changes: [{ path: "value.ts", content: "export const value = 2;\\n", findingIds: ["spec:wrong-value"] }] };
        ${options.repairBody ?? ""}
      } else {
        if (input.executionEvidence !== undefined || input.executionChecks !== undefined || input.checks !== undefined) throw new Error("チェック結果がレビューへ混入");
        const content = await Bun.file("value.ts").text();
        const broken = !content.includes("value = 2;");
        const unit = input.reviewUnits.find(u => u.axis === "spec");
        const candidate = { id: "wrong-value", axis: "spec", target: input.target.hash, location: { path: "value.ts", revision: "head", line: 1, quote: content.trim() }, contract: unit.reference,
          condition: "valueをimportする", failure: "要求値2と異なる", impact: { score: 2, description: "公開値が不正" }, evidence: { kind: "static", detail: "固定コードの右辺を照合した" }, reproduction: "valueと2を比較する", rootCause: "wrong-value", needsSpecificationDecision: false, decision: "required", rationale: "確定契約に反する", defense: "補正処理はない", sdk: { status: "not_applicable", evidence: "定数exportのみ" } };
        output = { completed: true, axis: input.phase, candidates: broken && input.phase !== "standards" ? [candidate] : [],
          requirements: input.reviewUnits.filter(u => input.phase === "verification" || u.axis === input.phase).map(u => ({ ...u, target: input.target.hash, status: broken && u.id === unit.id ? "unsatisfied" : "satisfied", findingIds: broken ? ["wrong-value"] : [], implementation: [{ path: "value.ts", revision: "head", line: 1, quote: content.trim() }], verification: { method: "inspection", detail: "公開値と確定要求を照合" }, evidence: "value.ts:1の右辺で確認" })), consistency: { status: "consistent", evidence: "要求と規約の内容を照合" } };
        ${options.reviewBody ?? ""}
      }
      console.log(JSON.stringify({ type: "result", subtype: "success", modelUsage: Object.fromEntries((input.phase === "repair" ? ${JSON.stringify(options.repairModels ?? ["claude-implementation-exact"])} : ["claude-review-effective"]).map(m => [m, {}])), usage: { input_tokens: 10 }, structured_output: output }));
    }
  `);
  chmodSync(model, 0o755);
  if (process.env.NOD_REPAIR_REAL_SANDBOX !== "1") {
    const sandbox = join(dir, "sandbox-exec");
    writeFileSync(sandbox, `#!/usr/bin/env bun\nconst args = process.argv.slice(2); if (args[0] !== "-p" || !args[1].includes("deny network*") || !args[1].includes("deny file-write*")) process.exit(98); const p = Bun.spawn(args.slice(2), { stdin: "inherit", stdout: "inherit", stderr: "inherit" }); process.exit(await p.exited);\n`);
    chmodSync(sandbox, 0o755);
  }
  const plan = join(dir, "preparation.json");
  writeFileSync(plan, JSON.stringify({ version: 1, isolation: "copy", rationale: "規約を確認し、依存不要の定数を隔離コピーで検証する", standards: [],
    prepare: options.preparation ? [{ command: process.execPath, args: ["-e", options.preparation], rationale: "必要な準備" }] : [],
    verify: [{ command: process.execPath, args: ["-e", options.check ?? 'const { value } = await import("./value.ts"); if (value !== 2) process.exit(1);'], rationale: "公開名と値2を実行確認する" }] }));
  const run = (...args: string[]) => cli("review", "run", "--repo", repo, "--base", "HEAD^", "--issue", issue, "--provider", "claude", "--review-model", "claude-review-exact", "--implementation-models", "claude-implementation-exact", "--extra-usage-disabled", ...args);
  const repair = (...args: string[]) => run("--repair-once", "--repair-provider", "claude", "--repair-model", "claude-implementation-exact", "--repair-plan", plan, ...args);
  const autoRepair = (...args: string[]) => run("--auto-repair", "--repair-provider", "claude", "--repair-model", "claude-implementation-exact", "--repair-plan", plan, ...args);
  return { repo, db, dir, run, repair, autoRepair, plan, cli, issue };
}

test("確認済みの要対応だけを隔離修正・検証・別モデル再レビューし、初回記録と元の作業を保持する", async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "work.txt"), "利用者のstaged\n"); git(f.repo, "add", "work.txt");
  writeFileSync(join(f.repo, "work.txt"), "利用者のunstaged\n");
  const index = readFileSync(join(f.repo, ".git/index"));
  const result = await f.repair("--local");
  expect(result.exitCode, result.stderr + result.stdout).toBe(0);
  expect(result.json).toMatchObject({ status: "completed", score: 5, repair: { status: "ready", applied: false } });
  const initial = JSON.parse(readFileSync(result.json.initialReviewPath, "utf8"));
  expect(initial.score).toBe(2);
  expect(initial.findings[0].decision).toBe("required");
  expect(result.json.target.hash).not.toBe(initial.target.hash);
  expect(result.json.coverage.every((r: any) => r.target === result.json.target.hash && r.status === "satisfied")).toBe(true);
  expect(result.json.execution.stages.map((s: any) => s.phase)).toEqual(["standards", "spec", "verification"]);
  expect(result.json.repair.model.effectiveModels).toEqual(["claude-implementation-exact"]);
  expect(readFileSync(result.json.repair.patchPath, "utf8")).toContain("+export const value = 2;");
  expect(readFileSync(join(f.repo, "value.ts"), "utf8")).toBe("export const value = 3;\n");
  expect(readFileSync(join(f.repo, "work.txt"), "utf8")).toBe("利用者のunstaged\n");
  expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
  expect(JSON.parse(readFileSync(result.json.artifactPath, "utf8"))).toEqual(result.json);
});

for (const mode of ["once", "auto"] as const) test(`再レビューでも指定effortを維持し、修正モデルの設定へ混ぜない（${mode}）`, async () => {
  const f = await fixture({
    reviewBody: 'if (process.argv[process.argv.indexOf("--effort") + 1] !== "high") throw new Error("レビューeffortが失われた");',
    repairBody: 'if (process.argv.includes("--effort")) throw new Error("修正担当へレビューeffortが混入した");',
  });
  const result = await (mode === "auto" ? f.autoRepair : f.repair)("--review-effort", "high");
  expect(result.json, result.stderr).toMatchObject({ status: "completed", score: 5, execution: { requestedEffort: "high" } });
  expect(JSON.parse(readFileSync(result.json.initialReviewPath, "utf8")).execution.requestedEffort).toBe("high");
  expect(readFileSync(join(f.repo, "value.ts"), "utf8")).toBe("export const value = 3;\n");
});

test("必要な検証が失敗してもpatchと初回指摘を保存し、元の対象には反映しない", async () => {
  const f = await fixture({ check: "process.exit(7);" });
  const result = await f.repair();
  expect(result.json).toMatchObject({ status: "incomplete", score: null, repair: { status: "incomplete", applied: false } });
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  expect(readFileSync(result.json.repair.patchPath, "utf8")).toContain("+export const value = 2;");
  expect(JSON.parse(readFileSync(result.json.repair.reviewPath, "utf8"))).toMatchObject({ status: "completed", score: 5 });
  expect(JSON.parse(readFileSync(result.json.initialReviewPath, "utf8")).score).toBe(2);
  expect(readFileSync(join(f.repo, "value.ts"), "utf8")).toBe("export const value = 3;\n");
});

test("初回で新たな仕様判断が残れば修正を開始せず理由と未確認指摘を保存する", async () => {
  const f = await fixture({ reviewBody: 'for (const finding of output.candidates) finding.needsSpecificationDecision = true;' });
  const result = await f.repair();
  expect(result.json).toMatchObject({ status: "incomplete", score: null });
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "SPECIFICATION_DECISION_REQUIRED" }));
  expect(result.json.repair.model).toBeUndefined();
  expect(readFileSync(result.json.repair.patchPath, "utf8")).toBe("");
  expect(result.json.findings[0].decision).toBe("unverified");
});

test("検証コマンドが固定コードの実行属性を書き換えても独立レビューを保持し受け渡しを止める", async () => {
  const f = await fixture({ check: 'require("node:fs").chmodSync("value.ts", 0o755);' });
  const result = await f.repair();
  expect(result.json).toMatchObject({ status: "incomplete", score: null });
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "VALIDATION_TARGET_CHANGED" }));
  expect(JSON.parse(readFileSync(result.json.repair.reviewPath, "utf8"))).toMatchObject({ status: "completed", target: { hash: result.json.repair.finalTarget.hash } });
  expect(readFileSync(result.json.repair.patchPath, "utf8")).toContain("+export const value = 2;");
});

test("修正による退行を新しい対象版の指摘として保存し、初回指摘と分ける", async () => {
  const f = await fixture({
    repairBody: `output.changes[0].content = "export const value = 2; throw new Error('退行');\\n";`,
    check: 'if (!(await Bun.file("value.ts").text()).includes("value = 2;")) process.exit(1);',
    reviewBody: `if (content.includes("throw new Error")) {
      candidate.id = "regression"; candidate.rootCause = "module-throws"; candidate.failure = "import時に例外になる";
      if (input.phase !== "standards") output.candidates = [candidate];
      output.requirements = output.requirements.map(r => ({ ...r, status: "unsatisfied", findingIds: ["regression"] }));
    }`,
  });
  const result = await f.repair();
  expect(result.json.status).toBe("incomplete");
  expect(result.json.score).toBeNull();
  expect(result.json.findings).toContainEqual(expect.objectContaining({ id: "regression", decision: "required", target: result.json.target.hash }));
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "REREVIEW_INCOMPLETE" }));
  expect(JSON.parse(readFileSync(result.json.initialReviewPath, "utf8")).findings[0].id).toBe("wrong-value");
  expect(JSON.parse(readFileSync(result.json.repair.reviewPath, "utf8")).score).toBe(2);
  expect(readFileSync(join(f.repo, "value.ts"), "utf8")).toBe("export const value = 3;\n");
});

test("準備が失敗すれば修正モデルを呼ばず、復旧用の未完了状態を残す", async () => {
  const f = await fixture({ preparation: "process.exit(9);" });
  const result = await f.repair();
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "REPAIR_PREPARATION_FAILED" }));
  expect(result.json.repair.model).toBeUndefined();
  expect(result.json.repair.commands.some((c: any) => c.status === "incomplete")).toBe(true);
  expect(existsSync(result.json.repair.artifactPath)).toBe(true);
  expect(readFileSync(result.json.repair.patchPath, "utf8")).toBe("");
});

test("検証を実行中に初回からの期限へ達すればpatchを保持して子処理を止める", async () => {
  const f = await fixture({ check: 'process.on("SIGTERM", () => {}); setInterval(() => {}, 100);' });
  const result = await f.repair("--timeout-seconds", "2");
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "DEADLINE_EXCEEDED" }));
  expect(result.json).toMatchObject({ status: "incomplete", score: null });
  expect(result.json.execution.elapsedMs).toBeLessThan(5000);
  expect(JSON.parse(readFileSync(result.json.repair.reviewPath, "utf8"))).toMatchObject({ status: "completed", target: { hash: result.json.repair.finalTarget.hash } });
  expect(readFileSync(result.json.repair.patchPath, "utf8")).toContain("+export const value = 2;");
});

test("モデル用に除外した無関係なbinaryも検証環境ではbyteを保持する", async () => {
  const f = await fixture({ check: 'const b = await Bun.file("icon.bin").bytes(); if (b.length !== 3 || b[1] !== 255 || b[2] !== 128) process.exit(1); const { value } = await import("./value.ts"); if (value !== 2) process.exit(1);' });
  writeFileSync(join(f.repo, "icon.bin"), Buffer.from([0, 255, 128]));
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "検証に使う画像");
  writeFileSync(join(f.repo, "value.ts"), "export const value = 4;\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "値の不具合");
  const result = await f.repair();
  expect(result.json.status).toBe("completed");
  expect(result.json.score).toBe(5);
  expect(result.json.execution.excludedSources).toContainEqual({ path: "icon.bin", reason: "binary" });
  expect(readFileSync(join(result.json.repair.workspace, "icon.bin"))).toEqual(Buffer.from([0, 255, 128]));
});

// 偽sandboxで通ったことをOS隔離の証明にしない。通常Orca terminalから明示実行する。
test.skipIf(process.env.NOD_REPAIR_REAL_SANDBOX !== "1")("実OS隔離で外部書込・元repo読取・秘密候補読取・ネットワークを拒否する", async () => {
  const f = await fixture();
  const canary = join(f.dir, "outside-canary");
  const secret = join(f.dir, ".env.test-fixture");
  const key = join(f.dir, "fixture-server.pem");
  writeFileSync(canary, "保存する値"); writeFileSync(secret, "偽の秘密値"); writeFileSync(key, "偽の鍵");
  let connections = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { connections++; return new Response("接続は禁止"); } });
  try {
    expect((await fetch(`http://127.0.0.1:${server.port}`)).status).toBe(200);
    const plan = JSON.parse(readFileSync(f.plan, "utf8"));
    plan.verify[0].args = ["-e", `
      const fs = require("node:fs");
      const trace = []; const record = data => { trace.push(data); fs.writeFileSync("boundary-trace.json", JSON.stringify(trace)); };
      function denied(label, fn) { try { fn(); } catch (e) { record({ label, code: e.code, message: e.message }); if (["EPERM", "EACCES"].includes(e.code)) return; throw e; } record({ label, allowed: true }); throw new Error("隔離されていない"); }
      denied("outside_write", () => fs.writeFileSync(${JSON.stringify(canary)}, "変更"));
      denied("source_read", () => fs.readFileSync(${JSON.stringify(join(f.repo, "value.ts"))}));
      denied("secret_read", () => fs.readFileSync(${JSON.stringify(secret)}));
      denied("key_read", () => fs.readFileSync(${JSON.stringify(key)}));
      await new Promise((resolve, reject) => { const socket = require("node:net").createConnection({ host: "127.0.0.1", port: ${server.port} }); socket.on("connect", () => { socket.destroy(); reject(new Error("ネットワーク接続に成功した")); }); socket.on("error", e => { record({ label: "network", code: e.code, message: e.message }); ["EPERM", "EACCES", "ECONNREFUSED"].includes(e.code) ? resolve() : reject(e); }); });
      const { value } = await import("./value.ts"); if (value !== 2) process.exit(1);
    `];
    writeFileSync(f.plan, JSON.stringify(plan));
    const result = await f.repair();
    const tracePath = join(result.json.repair.workspace, "boundary-trace.json");
    expect(result.json.problems, existsSync(tracePath) ? readFileSync(tracePath, "utf8") : result.stderr).toEqual([]);
    expect(result.json.score).toBe(5);
    expect(readFileSync(canary, "utf8")).toBe("保存する値");
    expect((await fetch(`http://127.0.0.1:${server.port}`)).status).toBe(200);
    expect(connections).toBe(2);
  } finally { server.stop(true); }
});

test("修正モデルも新仕様判断を必要としたら変更案を適用せず停止する", async () => {
  const f = await fixture({ repairBody: 'output.needsSpecificationDecision = true;' });
  const result = await f.repair();
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "SPECIFICATION_DECISION_REQUIRED" }));
  expect(result.json.score).toBeNull();
  expect(readFileSync(result.json.repair.patchPath, "utf8")).toBe("");
  expect(readFileSync(join(result.json.repair.workspace, "value.ts"), "utf8")).toBe("export const value = 3;\n");
});

test("要求・規約を追加や書換えで合格にする修正案を適用しない", async () => {
  const f = await fixture({ repairBody: 'output.changes.push({ path: "AGENTS.md", content: "値3を許可する。", findingIds: ["spec:wrong-value"] });' });
  const result = await f.repair();
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "REPAIR_REQUIREMENTS_PROTECTED" }));
  expect(readFileSync(result.json.repair.patchPath, "utf8")).toBe("");
  expect(readFileSync(join(result.json.repair.workspace, "value.ts"), "utf8")).toBe("export const value = 3;\n");
  expect(existsSync(join(f.repo, "AGENTS.md"))).toBe(false);
});

test("準備規約のOrca・Docker要件を汎用コピーへ代替しない", async () => {
  const f = await fixture();
  const quote = "作業領域はOrca worktreeを作成し、検証はDocker内で実行する。";
  writeFileSync(join(f.repo, "CLAUDE.md"), "PM機能はOrcaで担当を監督する。\n" + quote + "\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "環境規約");
  const prepared = await f.cli("review", "prepare", "--repo", f.repo, "--base", "HEAD^", "--issue", f.issue);
  const plan = JSON.parse(readFileSync(f.plan, "utf8"));
  plan.standards = prepared.json.sources.filter((s: any) => s.type === "standard").map((s: any) => ({ source: `standard:${s.id}`, hash: s.hash, environment: [
    { line: 1, quote: "PM機能はOrcaで担当を監督する。", kind: "informational", rationale: "製品機能の説明。" },
    { line: 2, quote, kind: "required", rationale: "修正時の作業領域と検証場所を指定する必須指示。" },
  ] }));
  writeFileSync(f.plan, JSON.stringify(plan));
  const result = await f.repair();
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "REPAIR_PREPARATION_UNSUPPORTED" }));
  expect(result.json.repair.model).toBeUndefined();
  expect(result.json.score).toBeNull();
});

for (const [models, code] of [
  [["claude-review-effective"], "MODEL_OVERLAP"],
  [["claude-unexpected-effective"], "REPAIR_MODEL_UNEXPECTED"],
  [[], "MODEL_UNVERIFIED"],
] as const) {
  test(`修正の実効モデルを確認できない場合は変更を適用しない（${code}）`, async () => {
    const f = await fixture({ repairModels: [...models] });
    const result = await f.repair();
    expect(result.json.problems).toContainEqual(expect.objectContaining({ code }));
    expect(result.json.score).toBeNull();
    expect(readFileSync(result.json.repair.patchPath, "utf8")).toBe("");
    expect(readFileSync(join(f.repo, "value.ts"), "utf8")).toBe("export const value = 3;\n");
  });
}

test("Codex修正担当は実効モデルを証明できないため推論前に停止する", async () => {
  const f = await fixture();
  const marker = join(f.dir, "codex-called");
  const codex = join(f.dir, "codex");
  writeFileSync(codex, `#!/usr/bin/env bun\nif (process.argv.includes("status")) console.log("Logged in using ChatGPT"); else await Bun.write(${JSON.stringify(marker)}, "推論禁止");\n`);
  chmodSync(codex, 0o755);
  const result = await f.repair("--repair-provider", "codex", "--repair-model", "gpt-implementation-exact", "--implementation-models", "gpt-implementation-exact");
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "MODEL_UNVERIFIED" }));
  expect(existsSync(marker)).toBe(false);
  expect(readFileSync(result.json.repair.patchPath, "utf8")).toBe("");
});

test("明示選択なしの従来レビューは要対応を修正しない", async () => {
  const f = await fixture();
  const result = await f.run();
  expect(result.json.status).toBe("completed");
  expect(result.json.score).toBe(2);
  expect(result.json.repair).toBeUndefined();
  expect(readFileSync(join(f.repo, "value.ts"), "utf8")).toBe("export const value = 3;\n");
});

test("任意提案だけなら自動修正モデルを呼び出さない", async () => {
  const f = await fixture({ reviewBody: 'for (const candidate of output.candidates) candidate.decision = "optional"; for (const requirement of output.requirements) requirement.status = "satisfied";' });
  const result = await f.repair();
  expect(result.json.score).toBe(5);
  expect(result.json.repair.status).toBe("not_needed");
  expect(result.json.repair.model).toBeUndefined();
  expect(readFileSync(result.json.repair.patchPath, "utf8")).toBe("");
});

test("検証や再レビュー中に要求元が変われば修正成功へ読み替えない", async () => {
  const f = await fixture();
  const doc = (await f.cli("doc", "create", "repair-spec.md", "--kind", "spec", "--issue", f.issue, "--body", "公開名valueで値2を返す。")).json;
  const model = join(f.dir, "claude");
  writeFileSync(model, readFileSync(model, "utf8").replace('output = { completed: true, target:', `await Bun.write(${JSON.stringify(doc.path)}, "公開名valueで値4を返す。"); output = { completed: true, target:`));
  const result = await f.repair();
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "REQUIREMENTS_CHANGED" }));
  expect(result.json.score).toBeNull();
  expect(result.json.repair.reviewPath).toBeUndefined();
  expect(readFileSync(join(f.repo, "value.ts"), "utf8")).toBe("export const value = 3;\n");
});

test("修正先の親に準備工程が置いたsymlinkがあれば元ファイルを変更しない", async () => {
  const outside = tempDir("repair-outside-");
  const f = await fixture({ preparation: `require("node:fs").symlinkSync(${JSON.stringify(outside)}, "redirect");`, repairBody: 'output.changes.push({ path: "redirect/escape.txt", content: "書込禁止", findingIds: ["spec:wrong-value"] });' });
  const result = await f.repair();
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "REPAIR_PATH_INVALID" }));
  expect(existsSync(join(outside, "escape.txt"))).toBe(false);
  expect(readFileSync(result.json.repair.patchPath, "utf8")).toBe("");
});

test("検証ツールの一時ファイルも隔離作業領域内へ作成できる", async () => {
  const f = await fixture({ check: 'const os = require("node:os"); const fs = require("node:fs"); if (!os.tmpdir().startsWith(process.cwd() + "/")) process.exit(4); fs.mkdtempSync(os.tmpdir() + "/check-");' });
  const result = await f.repair();
  expect(result.json.status).toBe("completed");
  expect(result.json.score).toBe(5);
});

test("NULを含まない非UTF-8資料も固定Git blobのbyteで検証環境へ再現する", async () => {
  const f = await fixture({ check: 'const b = await Bun.file("legacy.dat").bytes(); if (b.length !== 3 || b[0] !== 255 || b[1] !== 128) process.exit(1);' });
  writeFileSync(join(f.repo, "legacy.dat"), Buffer.from([255, 128, 10]));
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "非UTF-8資料");
  writeFileSync(join(f.repo, "value.ts"), "export const value = 4;\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "値の不具合");
  const result = await f.repair();
  expect(result.json.status).toBe("completed");
  expect(result.json.execution.excludedSources).toContainEqual({ path: "legacy.dat", reason: "invalid_utf8" });
  expect(readFileSync(join(result.json.repair.workspace, "legacy.dat"))).toEqual(Buffer.from([255, 128, 10]));
});


test("自動修正は検証済みpatchを未適用のまま受け渡し修正後の対象だけに点数を付ける", async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "work.txt"), "利用者のstaged\n"); git(f.repo, "add", "work.txt");
  writeFileSync(join(f.repo, "work.txt"), "利用者のunstaged\n");
  const index = readFileSync(join(f.repo, ".git/index"));
  const result = await f.autoRepair("--local");
  expect(result.exitCode, result.stderr + result.stdout).toBe(0);
  expect(result.json).toMatchObject({ status: "completed", score: 5,
    autoRepair: { status: "patch_ready", application: "not_applied", applied: false, iterations: 1, maxIterations: 3 } });
  expect(result.json.problems).toEqual([]);
  const initial = JSON.parse(readFileSync(result.json.initialReviewPath, "utf8"));
  expect(result.json.target.hash).not.toBe(initial.target.hash);
  expect(result.json.target.hash).toBe(result.json.autoRepair.patchTarget.hash);
  expect(result.json.coverage.every((r: any) => r.target === result.json.target.hash && r.status === "satisfied")).toBe(true);
  expect(result.json.autoRepair.history).toHaveLength(1);
  expect(JSON.parse(readFileSync(result.json.repair.reviewPath, "utf8")).score).toBe(5);
  expect(JSON.parse(readFileSync(result.json.initialReviewPath, "utf8")).score).toBe(2);
  expect(readFileSync(result.json.autoRepair.patchPath, "utf8")).toContain("+export const value = 2;");
  expect(readFileSync(join(f.repo, "value.ts"), "utf8")).toBe("export const value = 3;\n");
  expect(readFileSync(join(f.repo, "work.txt"), "utf8")).toBe("利用者のunstaged\n");
  expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
  expect(JSON.parse(readFileSync(result.json.artifactPath, "utf8"))).toEqual(result.json);
});

test("新しい原因が減る反復は修正後の版から続け、初回からの累積patchと各版の履歴を残す", async () => {
  const f = await fixture({
    repairBody: 'output.changes[0].content = input.findings.some(f => f.id === "initial-a") ? "export const value = 4;\\n" : "export const value = 2;\\n"; output.changes[0].findingIds = input.findings.map(f => `${f.axis}:${f.id}`);',
    reviewBody: 'const causes = content.includes("value = 3;") ? ["initial-a", "initial-b"] : content.includes("value = 4;") ? ["new-cause"] : []; output.candidates = input.phase === "standards" ? [] : causes.map(id => ({ ...candidate, id, rootCause: id })); for (const r of output.requirements) { r.status = causes.length ? "unsatisfied" : "satisfied"; r.findingIds = causes; }',
    check: 'if (!(await Bun.file("value.ts").text()).includes("export const value")) process.exit(1);',
  });
  const result = await f.autoRepair();
  expect(result.json.autoRepair, result.stdout + result.stderr).toMatchObject({ status: "patch_ready", iterations: 2 });
  const history = result.json.autoRepair.history;
  expect(history).toHaveLength(2);
  expect(JSON.parse(readFileSync(history[0].reviewPath, "utf8")).score).toBe(2);
  expect(JSON.parse(readFileSync(history[1].reviewPath, "utf8")).score).toBe(5);
  expect(result.json.repair.inputTarget.hash).toBe(history[0].target.hash);
  expect(result.json.repair.originalTarget.hash).toBe(JSON.parse(readFileSync(result.json.initialReviewPath, "utf8")).target.hash);
  const patch = readFileSync(result.json.autoRepair.patchPath, "utf8");
  expect(patch).toContain("-export const value = 3;");
  expect(patch).toContain("+export const value = 2;");
  expect(patch).not.toContain("value = 4;");
  expect(readFileSync(join(f.repo, "value.ts"), "utf8")).toBe("export const value = 3;\n");
});

test("同じ根本原因が再レビューに残ったら再修正せず最終版と指摘を保持する", async () => {
  const f = await fixture({ repairBody: 'output.changes[0].content = "export const value = 4;\\n";', check: "process.exit(0);" });
  const result = await f.autoRepair();
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "REPAIR_CAUSE_RECURRED" }));
  expect(result.json.autoRepair.iterations).toBe(1);
  expect(result.json.score).toBeNull();
  expect(result.json.findings[0].rootCause).toBe("wrong-value");
  expect(readFileSync(result.json.autoRepair.patchPath, "utf8")).toContain("+export const value = 4;");
});

test("原因名が変わっても要対応の原因数が減らなければ進展なしとして停止する", async () => {
  const f = await fixture({
    repairBody: 'output.changes[0].content = "export const value = 4;\\n";', check: "process.exit(0);",
    reviewBody: 'if (content.includes("value = 4;")) for (const c of output.candidates) c.rootCause = "another-cause";',
  });
  const result = await f.autoRepair();
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "REPAIR_NO_PROGRESS" }));
  expect(result.json.autoRepair.iterations).toBe(1);
  expect(result.json.autoRepair.history).toHaveLength(1);
  expect(result.json.score).toBeNull();
});

test("原因が減り続けても修正・再レビューは3回で止め、4回目を開始しない", async () => {
  const f = await fixture({
    repairBody: 'const content = await Bun.file("value.ts").text(); const value = Number(content.match(/value = (\\d+)/)[1]); output.changes[0].content = `export const value = ${value + 1};\\n`; output.changes[0].findingIds = input.findings.map(f => `${f.axis}:${f.id}`);',
    reviewBody: 'const value = Number(content.match(/value = (\\d+)/)[1]); const causes = Array.from({length: 7 - value}, (_, i) => `round-${value}-cause-${i}`); output.candidates = input.phase === "standards" ? [] : causes.map(id => ({ ...candidate, id, rootCause: id })); for (const r of output.requirements) { r.status = "unsatisfied"; r.findingIds = causes; }',
    check: "process.exit(0);",
  });
  const result = await f.autoRepair();
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "REPAIR_ITERATION_LIMIT" }));
  expect(result.json.autoRepair.iterations).toBe(3);
  expect(result.json.autoRepair.history).toHaveLength(3);
  expect(result.json.findings).toHaveLength(1);
  expect(result.json.findings[0].rootCause).toBe("round-6-cause-0");
  expect(result.json.score).toBeNull();
  expect(readFileSync(result.json.autoRepair.patchPath, "utf8")).toContain("+export const value = 6;");
  expect(readFileSync(join(f.repo, "value.ts"), "utf8")).toBe("export const value = 3;\n");
});

test("commit対象の自動修正は作業ツリーの未コミット編集で止めず、その内容を保持する", async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "value.ts"), "export const value = 77;\n");
  const result = await f.autoRepair();
  expect(result.json.autoRepair).toMatchObject({ status: "patch_ready", application: "not_applied", applied: false });
  expect(readFileSync(join(f.repo, "value.ts"), "utf8")).toBe("export const value = 77;\n");
});

test("再レビュー中の元ファイルの同時編集は検出し、利用者の内容とindexを保持する", async () => {
  const f = await fixture();
  const model = join(f.dir, "claude");
  writeFileSync(model, readFileSync(model, "utf8").replace('const broken = !content.includes', `if (input.phase === "verification" && content.includes("value = 2;")) await Bun.write(${JSON.stringify(join(f.repo, "value.ts"))}, "export const value = 99;\\n"); const broken = !content.includes`));
  const index = readFileSync(join(f.repo, ".git/index"));
  const result = await f.autoRepair("--local");
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "ORIGINAL_TARGET_CHANGED" }));
  expect(result.json.score).toBeNull();
  expect(readFileSync(join(f.repo, "value.ts"), "utf8")).toBe("export const value = 99;\n");
  expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
  expect(readFileSync(result.json.autoRepair.patchPath, "utf8")).toContain("+export const value = 2;");
});

const progressingRepair = {
  repairBody: 'output.changes[0].content = input.findings.some(f => f.id === "initial-a") ? "export const value = 4;\\n" : "export const value = 2;\\n"; output.changes[0].findingIds = input.findings.map(f => `${f.axis}:${f.id}`);',
  reviewBody: 'const causes = content.includes("value = 3;") ? ["initial-a", "initial-b"] : content.includes("value = 4;") ? ["new-cause"] : []; output.candidates = input.phase === "standards" ? [] : causes.map(id => ({ ...candidate, id, rootCause: id })); for (const r of output.requirements) { r.status = causes.length ? "unsatisfied" : "satisfied"; r.findingIds = causes; }',
};

test("2回目の検証も初回準備からの期限で子孫を停止し累積patchを保存する", async () => {
  const f = await fixture({ ...progressingRepair, check: `
    if ((await Bun.file("value.ts").text()).includes("value = 2;")) {
      const child = require("node:child_process").spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 100);'], { stdio: "ignore" });
      require("node:fs").writeFileSync("child.pid", String(child.pid));
      process.on("SIGTERM", () => {}); setInterval(() => {}, 100);
    }
  ` });
  const result = await f.autoRepair("--timeout-seconds", "4");
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "DEADLINE_EXCEEDED" }));
  expect(result.json.autoRepair.iterations).toBe(2);
  expect(result.json.score).toBeNull();
  expect(result.json.execution.elapsedMs).toBeLessThan(6000);
  const initial = JSON.parse(readFileSync(result.json.initialReviewPath, "utf8"));
  expect(result.json.execution.deadline).toBe(initial.execution.deadline);
  expect(JSON.parse(readFileSync(result.json.repair.reviewPath, "utf8"))).toMatchObject({ status: "completed", target: { hash: result.json.repair.finalTarget.hash } });
  expect(readFileSync(result.json.autoRepair.patchPath, "utf8")).toContain("+export const value = 2;");
  const pid = Number(readFileSync(join(result.json.repair.workspace, "child.pid"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});

test("2回目のモデルの利用枠不足で以前の累積patchと各回の失敗を保持する", async () => {
  const f = await fixture({ ...progressingRepair, repairBody: progressingRepair.repairBody + 'if (!input.findings.some(f => f.id === "initial-a")) { console.error("usage limit"); process.exit(9); }', check: "process.exit(0);" });
  const result = await f.autoRepair();
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "USAGE_LIMIT" }));
  expect(result.json.autoRepair.iterations).toBe(2);
  expect(result.json.autoRepair.history).toHaveLength(2);
  expect(result.json.score).toBeNull();
  expect(result.json.autoRepair.patchTarget.hash).toBe(result.json.autoRepair.history[0].target.hash);
  expect(readFileSync(result.json.autoRepair.patchPath, "utf8")).toContain("+export const value = 4;");
  expect(readFileSync(join(f.repo, "value.ts"), "utf8")).toBe("export const value = 3;\n");
});

test("再レビューの未確認は要対応の減少と読み替えず反復を止める", async () => {
  const f = await fixture({ reviewBody: 'if (content.includes("value = 2;")) for (const r of output.requirements) r.status = "unverified";' });
  const result = await f.autoRepair();
  expect(result.json.score).toBeNull();
  expect(result.json.autoRepair.status).toBe("incomplete");
  expect(result.json.autoRepair.iterations).toBe(1);
  expect(result.json.coverage[0].status).toBe("unverified");
  expect(result.json.autoRepair.checks).toBeUndefined();
  expect(readFileSync(result.json.autoRepair.patchPath, "utf8")).toContain("+export const value = 2;");
});

test("自動修正の再実行は新しいIDを使い、初回記録と過去の結果を上書きしない", async () => {
  const f = await fixture();
  const first = await f.autoRepair();
  const priorResult = readFileSync(first.json.artifactPath, "utf8");
  const priorInitial = readFileSync(first.json.initialReviewPath, "utf8");
  const second = await f.autoRepair();
  expect(second.json.runId).not.toBe(first.json.runId);
  expect(second.json.autoRepair.status).toBe("patch_ready");
  expect(readFileSync(first.json.artifactPath, "utf8")).toBe(priorResult);
  expect(readFileSync(first.json.initialReviewPath, "utf8")).toBe(priorInitial);
});

test("自動修正はstash・commit・push・PR投稿・mergeを実行しない", async () => {
  const f = await fixture();
  const forbidden = join(f.dir, "forbidden-operation");
  const realGit = Bun.which("git")!;
  const wrapper = join(f.dir, "git");
  writeFileSync(wrapper, `#!/usr/bin/env bun
    const args = process.argv.slice(2);
    if (args.some(a => ["stash", "commit", "push", "merge"].includes(a))) { await Bun.write(${JSON.stringify(forbidden)}, args.join(" ")); process.exit(99); }
    const p = Bun.spawn([${JSON.stringify(realGit)}, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }); process.exit(await p.exited);
  `);
  chmodSync(wrapper, 0o755);
  for (const name of ["gh", "curl", "ssh"]) {
    const path = join(f.dir, name);
    writeFileSync(path, `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(forbidden)}, ${JSON.stringify(name)}); process.exit(99);\n`);
    chmodSync(path, 0o755);
  }
  const head = readFileSync(join(f.repo, ".git/refs/heads/main"), "utf8");
  const index = readFileSync(join(f.repo, ".git/index"));
  const result = await f.autoRepair();
  expect(result.json.autoRepair.status).toBe("patch_ready");
  expect(existsSync(forbidden)).toBe(false);
  expect(readFileSync(join(f.repo, ".git/refs/heads/main"), "utf8")).toBe(head);
  expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
});

test("原因数が減っても最重影響が悪化したら進展とみなさない", async () => {
  const f = await fixture({ ...progressingRepair,
    reviewBody: progressingRepair.reviewBody + 'if (content.includes("value = 4;")) for (const c of output.candidates) c.impact.score = 1;',
    check: "process.exit(0);",
  });
  const result = await f.autoRepair();
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "REPAIR_NO_PROGRESS" }));
  expect(result.json.autoRepair.iterations).toBe(1);
  expect(JSON.parse(readFileSync(result.json.repair.reviewPath, "utf8")).score).toBe(1);
});

test("対象treeが初回へ戻る反復は無進展として停止し空の累積patchと各回の差分を残す", async () => {
  const f = await fixture({ ...progressingRepair,
    repairBody: progressingRepair.repairBody.replace('"export const value = 2;\\n"', '"export const value = 3;\\n"'), check: "process.exit(0);",
  });
  const result = await f.autoRepair();
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "REPAIR_NO_PROGRESS" }));
  expect(result.json.autoRepair.iterations).toBe(2);
  expect(readFileSync(result.json.autoRepair.patchPath, "utf8")).toBe("");
  expect(readFileSync(result.json.repair.patchPath, "utf8")).toContain("-export const value = 4;");
});

test("過去の確認済み根拠は候補検証だけへ渡し、名前が変わった同原因を既存IDで再発判定する", async () => {
  const f = await fixture({ ...progressingRepair, check: "process.exit(0);",
    reviewBody: progressingRepair.reviewBody + `
      if (input.phase !== "verification" && input.priorConfirmedFindings?.length) process.exit(91);
      if (content.includes("value = 4;") && input.phase === "verification" && input.priorConfirmedFindings?.some(f => f.rootCause === "initial-a" && f.evidence && f.contract)) {
        for (const c of output.candidates) c.rootCause = "initial-a";
      }
    `,
  });
  const result = await f.autoRepair();
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "REPAIR_CAUSE_RECURRED" }));
  expect(result.json.autoRepair.iterations).toBe(1);
  expect(result.json.findings[0].rootCause).toBe("initial-a");
  expect(result.json.findings[0].target).toBe(result.json.target.hash);
});

test("最終照合のGit読取直後の同時編集を検出してpatch受け渡しを未完了にする", async () => {
  const f = await fixture();
  const realGit = Bun.which("git")!;
  const checkpoint = join(f.dir, "application-check-count");
  const wrapper = join(f.dir, "git");
  writeFileSync(wrapper, `#!/usr/bin/env bun
    const fs = require("node:fs"); const args = process.argv.slice(2);
    const checkpoint = ${JSON.stringify(checkpoint)};
    if (args.includes("init") && args.some(a => a.includes("/application-check/snapshot.git"))) fs.writeFileSync(checkpoint, "0");
    const p = Bun.spawn([${JSON.stringify(realGit)}, ...args], { stdin: "inherit", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, status] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).arrayBuffer(), p.exited]);
    if (args.includes("--cached") && fs.existsSync(checkpoint)) {
      const count = Number(fs.readFileSync(checkpoint, "utf8")) + 1; fs.writeFileSync(checkpoint, String(count));
      if (count === 1) fs.writeFileSync(${JSON.stringify(join(f.repo, "value.ts"))}, "export const value = 99;\\n");
    }
    process.stdout.write(Buffer.from(stdout)); process.stderr.write(Buffer.from(stderr)); process.exit(status);
  `);
  chmodSync(wrapper, 0o755);
  const index = readFileSync(join(f.repo, ".git/index"));
  const result = await f.autoRepair("--local");
  expect(readFileSync(checkpoint, "utf8")).toBe("1");
  expect(result.json.autoRepair).toMatchObject({ status: "incomplete", application: "not_applied", applied: false,
    checks: { originalTargetUnchanged: false } });
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "ORIGINAL_TARGET_CHANGED" }));
  expect(result.json.score).toBeNull();
  expect(readFileSync(join(f.repo, "value.ts"), "utf8")).toBe("export const value = 99;\n");
  expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
  expect(readFileSync(result.json.autoRepair.patchPath, "utf8")).toContain("+export const value = 2;");
});

test("自動反復でも要求変更時は初回とpatchを保持して未完了になる", async () => {
  const f = await fixture();
  const doc = (await f.cli("doc", "create", "auto-repair-spec.md", "--kind", "spec", "--issue", f.issue, "--body", "公開名valueで値2を返す。")).json;
  const model = join(f.dir, "claude");
  writeFileSync(model, readFileSync(model, "utf8").replace('const broken = !content.includes', `if (input.phase === "verification" && content.includes("value = 2;")) await Bun.write(${JSON.stringify(doc.path)}, "公開名valueで値4を返す。"); const broken = !content.includes`));
  const result = await f.autoRepair();
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "REQUIREMENTS_CHANGED" }));
  expect(result.json.score).toBeNull();
  expect(result.json.autoRepair.iterations).toBe(1);
  expect(result.json.autoRepair.status).toBe("incomplete");
  expect(readFileSync(result.json.autoRepair.patchPath, "utf8")).toContain("+export const value = 2;");
  expect(readFileSync(join(f.repo, "value.ts"), "utf8")).toBe("export const value = 3;\n");
});


test("累積patchの保存失敗は受け渡し完了にせず各回の成果と元の対象を保持する", async () => {
  const f = await fixture({ reviewBody: `
    if (input.phase === "verification" && content.includes("value = 2;")) {
      const fs = require("node:fs"); const path = require("node:path");
      const destination = path.resolve(process.cwd(), "../../..", "changes.patch");
      fs.unlinkSync(destination); fs.mkdirSync(destination);
    }
  ` });
  const index = readFileSync(join(f.repo, ".git/index"));
  const result = await f.autoRepair();
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({ status: "incomplete", score: null,
    autoRepair: { status: "incomplete", application: "not_applied", applied: false } });
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "PATCH_SAVE_FAILED" }));
  expect(readFileSync(result.json.repair.cumulativePatchPath, "utf8")).toContain("+export const value = 2;");
  expect(JSON.parse(readFileSync(result.json.initialReviewPath, "utf8")).score).toBe(2);
  expect(readFileSync(join(f.repo, "value.ts"), "utf8")).toBe("export const value = 3;\n");
  expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
});


test("READMEのOrca機能説明を根拠付きで区別して隔離修正patchを受け渡す", async () => {
  const f = await fixture();
  const quote = "指定Workspaceと固定CycleのIssueをOrcaで監督する。";
  writeFileSync(join(f.repo, "README.md"), "# PM機能の説明\n" + quote + "\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "PMの機能説明");
  const index = readFileSync(join(f.repo, ".git/index"));
  const prepared = await f.cli("review", "prepare", "--repo", f.repo, "--base", "HEAD^", "--issue", f.issue);
  const plan = JSON.parse(readFileSync(f.plan, "utf8"));
  plan.standards = prepared.json.sources.filter((s: any) => s.type === "standard").map((s: any) => ({ source: `standard:${s.id}`, hash: s.hash,
    environment: [{ line: 2, quote, kind: "informational", rationale: "PM機能の説明であり、この修正の作業領域にOrcaを要求していない。" }] }));
  writeFileSync(f.plan, JSON.stringify(plan));
  const result = await f.autoRepair();
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  expect(result.json).toMatchObject({ status: "completed", score: 5, autoRepair: { status: "patch_ready", application: "not_applied" } });
  expect(readFileSync(result.json.autoRepair.patchPath, "utf8")).toContain("+export const value = 2;");
  expect(readFileSync(join(f.repo, "value.ts"), "utf8")).toBe("export const value = 3;\n");
  expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
});


for (const [scenario, code] of [
  ["判断なし", "REPAIR_PREPARATION_REQUIRED"],
  ["引用不一致", "REPAIR_PREPARATION_INVALID"],
  ["未確認", "REPAIR_PREPARATION_REQUIRED"],
  ["判断の重複と別行の欠落", "REPAIR_PREPARATION_INVALID"],
] as const) {
  test(`環境準備の適用判断を確認できなければ修正モデルを起動しない（${scenario}）`, async () => {
    const f = await fixture();
    const quote = "PM機能はOrcaで担当を監督する。";
    writeFileSync(join(f.repo, "README.md"), quote + "\n検証はDocker内で実行する。\n");
    git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "説明と準備規約");
    const prepared = await f.cli("review", "prepare", "--repo", f.repo, "--base", "HEAD^", "--issue", f.issue);
    const plan = JSON.parse(readFileSync(f.plan, "utf8"));
    const environment: any[] = [
      { line: 1, quote, kind: "informational", rationale: "機能説明。" },
      { line: 2, quote: "検証はDocker内で実行する。", kind: "required", rationale: "検証場所の指定。" },
    ];
    if (scenario === "判断なし") environment.length = 0;
    if (scenario === "引用不一致") environment[0].quote = "出典にない引用";
    if (scenario === "未確認") environment[0].kind = "unresolved";
    if (scenario === "判断の重複と別行の欠落") environment[1] = environment[0];
    plan.standards = prepared.json.sources.filter((s: any) => s.type === "standard").map((s: any) => ({ source: `standard:${s.id}`, hash: s.hash, environment }));
    writeFileSync(f.plan, JSON.stringify(plan));
    const result = await f.repair();
    expect(result.json).toMatchObject({ status: "incomplete", score: null });
    expect(result.json.problems).toContainEqual(expect.objectContaining({ code }));
    expect(result.json.repair.model).toBeUndefined();
    expect(result.json.repair.commands).toEqual([]);
    expect(readFileSync(join(f.repo, "value.ts"), "utf8")).toBe("export const value = 3;\n");
  });
}
