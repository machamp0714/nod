import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { reviewSourceFingerprint, type ReviewPreparation, type ReviewSource } from "./review-prepare";
import { ReviewFailure, reviewProcess } from "./review-process";
import { sensitiveReviewPath } from "./review-snapshot";
import { invokeRepairModel, type RepairModelResult } from "./review-repair-model";
import type { ReviewExecution, RunReviewInput } from "./review-run";

type Target = NonNullable<ReviewPreparation["target"]>;
type Command = { command: string; args: string[]; rationale: string };
type EnvironmentAssessment = { line: number; quote: string; kind: "required" | "informational" | "unresolved"; rationale: string };
type PreparationPlan = { version: 1; isolation: "copy"; rationale: string; standards: { source: string; hash: string; environment?: EnvironmentAssessment[] }[]; prepare: Command[]; verify: Command[] };
export interface RepairResult {
  status: "incomplete" | "ready" | "not_needed";
  applied: false;
  iteration: number;
  originalTarget: Target | null;
  inputTarget: Target | null;
  finalTarget?: Target;
  workspace: string;
  patchPath: string;
  cumulativePatchPath?: string;
  artifactPath: string;
  planHash?: string;
  excludedEnvironmentSources?: { path: string; reason: string }[];
  model?: RepairModelResult;
  commands: { phase: "prepare" | "verify"; command: Command; status: "completed" | "incomplete"; elapsedMs?: number; stdoutHash?: string; stderrHash?: string; problem?: { code: string; message: string } }[];
  reviewPath?: string;
  problems: { code: string; message: string }[];
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function fileStat(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim();

function preparationPlan(path: string | undefined, initial: ReviewExecution): { plan: PreparationPlan; hash: string } {
  if (!path) throw new ReviewFailure("REPAIR_PREPARATION_REQUIRED", "規約を確認した隔離準備・必要な検証の計画を--repair-planで指定してください");
  let plan: PreparationPlan;
  let body: string;
  try { body = readFileSync(path, "utf8"); plan = JSON.parse(body); }
  catch { throw new ReviewFailure("REPAIR_PREPARATION_INVALID", "準備計画JSONを読めません"); }
  if (plan.version !== 1 || plan.isolation !== "copy" || !text(plan.rationale) || !Array.isArray(plan.standards) || !Array.isArray(plan.prepare) || !Array.isArray(plan.verify) || !plan.verify.length) throw new ReviewFailure("REPAIR_PREPARATION_INVALID", "隔離方式・規約の確認根拠・必要な検証が準備計画にありません");
  for (const command of [...plan.prepare, ...plan.verify]) if (!command || !text(command.command) || !Array.isArray(command.args) || command.args.some(a => typeof a !== "string") || !text(command.rationale)) throw new ReviewFailure("REPAIR_PREPARATION_INVALID", "準備・検証は実行ファイル・引数配列・必要性を明示してください");
  validateReviewEnvironmentStandards(plan.standards, initial.sources);
  return { plan, hash: hash(body) };
}

export function validateReviewEnvironmentStandards(standards: PreparationPlan["standards"], sources: ReviewSource[]) {
  for (const source of sources.filter(s => s.type === "standard")) {
    const records = standards.filter(s => s && s.source === `standard:${source.id}` && s.hash === source.hash);
    if (records.length !== 1) throw new ReviewFailure("REPAIR_PREPARATION_REQUIRED", `準備計画には固定規約 ${source.id} の確認が1件必要です`);
    // 単語は確認箇所の索引にだけ使う。必須指示か機能説明かは呼出側が文脈と根拠を記録する。
    const mentions = source.content.split(/\r?\n/).flatMap((quote, index) => /\b(?:orca|worktree|docker|husky)\b/i.test(quote) ? [{ line: index + 1, quote }] : []);
    const assessments = records[0]!.environment ?? [];
    if (!Array.isArray(assessments) || assessments.length !== mentions.length) throw new ReviewFailure("REPAIR_PREPARATION_REQUIRED", `${source.id} の環境準備に関する全言及へ、出典と適用判断を記録してください`);
    for (const mention of mentions) {
      const matches = assessments.filter(a => a && a.line === mention.line);
      const assessment = matches[0];
      if (matches.length !== 1 || !assessment || assessment.quote !== mention.quote || !["required", "informational", "unresolved"].includes(assessment.kind) || !text(assessment.rationale)) throw new ReviewFailure("REPAIR_PREPARATION_INVALID", `${source.id}:${mention.line} の適用判断・引用・根拠が固定規約と対応していません`);
      if (assessment.kind === "unresolved") throw new ReviewFailure("REPAIR_PREPARATION_REQUIRED", `${source.id}:${mention.line} の環境準備の適用判断が未確認です`);
      if (assessment.kind === "required") throw new ReviewFailure("REPAIR_PREPARATION_UNSUPPORTED", `${source.id}:${mention.line} の必須環境準備には専用adapterが必要です。隔離コピーへ代替しません`);
    }
  }
}

function safePath(path: unknown): asserts path is string {
  if (!text(path) || isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some(p => ["", ".", ".."].includes(p) || p.toLowerCase() === ".git") || sensitiveReviewPath(path)) throw new ReviewFailure("REPAIR_PATH_INVALID", "修正は秘密情報を除くリポジトリ内の通常ファイルだけに限定します");
}

/** 1回だけ修正する。反復・元の作業への反映は呼出側の別工程とする。 */
export async function repairReviewOnce(db: Database, input: RunReviewInput, initial: ReviewExecution,
  review: (db: Database, input: RunReviewInput, fixed: ReviewPreparation) => Promise<ReviewExecution>, iteration = 1, origin: ReviewExecution = initial): Promise<ReviewExecution> {
  const directory = join(dirname(origin.initialReviewPath ?? origin.artifactPath), `repair-${iteration}`);
  mkdirSync(directory, { recursive: true });
  const repair: RepairResult = { status: "incomplete", applied: false, iteration, originalTarget: origin.target, inputTarget: initial.target, workspace: join(directory, "workspace"), patchPath: join(directory, "changes.patch"), artifactPath: join(directory, "repair.json"), commands: [], problems: [] };
  writeFileSync(repair.patchPath, "", { flag: "wx" });
  let result: ReviewExecution = { ...initial, initialReviewPath: origin.initialReviewPath, problems: [...initial.problems], remaining: [...initial.remaining], repair, artifactPath: join(directory, "result.json") };
  const deadline = Date.parse(origin.execution.deadline);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort); process.on("SIGTERM", abort); process.on("SIGHUP", abort);
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) controller.abort();
  const check = () => {
    if (controller.signal.aborted) throw new ReviewFailure("CANCELLED", "隔離修正が中断されました");
    if (Date.now() >= deadline) throw new ReviewFailure("DEADLINE_EXCEEDED", "初回準備からの全体期限に到達しました");
    if (reviewSourceFingerprint(db, initial as unknown as ReviewPreparation) !== initial.execution.sourceFingerprint) throw new ReviewFailure("REQUIREMENTS_CHANGED", "初回の要求・計画・規約が変更されました。新しい実行が必要です");
  };
  try {
    if ((initial.findings ?? []).some(f => f.needsSpecificationDecision === true)) throw new ReviewFailure("SPECIFICATION_DECISION_REQUIRED", "指摘に新たな仕様判断が残るため修正を開始できません");
    if (initial.status !== "completed") throw new ReviewFailure("INITIAL_REVIEW_INCOMPLETE", "初回の必要な確認が完了していないため修正を開始できません");
    check();
    const required = (initial.findings ?? []).filter(f => f.decision === "required");
    if (!required.length) { repair.status = "not_needed"; return result; }
    if (required.some(f => f.needsSpecificationDecision !== false)) throw new ReviewFailure("SPECIFICATION_DECISION_REQUIRED", "確定要求だけでは修正が決まらない指摘が残っています");
    if (!input.repairModel?.trim() || !input.repairProvider) throw new ReviewFailure("REPAIR_MODEL_REQUIRED", "利用者が選択した実装側の修正providerとモデルが必要です");
    if (!input.extraUsageDisabled) throw new ReviewFailure("BILLING_POLICY_UNVERIFIED", "追加使用無効の確認が必要です");
    const reviewModels = [...new Set(initial.execution.stages.flatMap(s => s.effectiveModels))];
    if (reviewModels.includes(input.repairModel)) throw new ReviewFailure("MODEL_OVERLAP", "修正モデルがレビュー担当と重なっています");
    const { plan, hash: planHash } = preparationPlan(input.repairPlan, initial);
    repair.planHash = planHash;
    writeFileSync(join(directory, "preparation-plan.json"), JSON.stringify(plan, null, 2) + "\n", { flag: "wx" });
    if (process.platform !== "darwin") throw new ReviewFailure("REPAIR_SANDBOX_UNAVAILABLE", "この環境用の書込・ネットワーク隔離adapterは未対応です");
    const target = initial.target!;
    mkdirSync(repair.workspace, { recursive: true });
    const work = realpathSync(repair.workspace);
    const snapshot = join(directory, "snapshot.git");
    mkdirSync(snapshot);
    const options = { cwd: work, deadline, signal: controller.signal };
    const git = async (args: string[], data?: string) => {
      check();
      return (await reviewProcess("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "--git-dir", snapshot, ...args], { ...options, input: data, maxBytes: 20 * 1024 * 1024 })).stdout;
    };
    const originalGit = async (...args: string[]) => (await reviewProcess("git", ["--no-optional-locks", "-C", target.repo, ...(target.local ? ["--git-dir", target.local.repo] : []), ...args], options)).stdout;
    await git(["init", "--bare", "--template=", `--object-format=${(await originalGit("rev-parse", "--show-object-format")).trim()}`, snapshot]);
    const objects = target.local ? join(target.local.repo, "objects") : resolve(target.repo, (await originalGit("rev-parse", "--git-path", "objects")).trim());
    writeFileSync(join(snapshot, "objects/info/alternates"), objects + "\n");
    const beforeTree = target.local?.treeSha ?? (await git(["rev-parse", `${target.headSha}^{tree}`])).trim();
    await git(["read-tree", beforeTree]);
    const entries = (await git(["ls-tree", "-rz", beforeTree])).split("\0").filter(Boolean);
    const modes = new Map<string, string>();
    repair.excludedEnvironmentSources = [];
    let totalBytes = 0;
    for (const entry of entries) {
      const [meta, path] = [entry.slice(0, entry.indexOf("\t")), entry.slice(entry.indexOf("\t") + 1)];
      const mode = meta.split(" ")[0]!;
      if (sensitiveReviewPath(path) || !["100644", "100755"].includes(mode)) {
        repair.excludedEnvironmentSources.push({ path, reason: sensitiveReviewPath(path) ? "sensitive_path" : "non_regular" });
        continue;
      }
      safePath(path);
      modes.set(path, mode);
      mkdirSync(dirname(join(work, path)), { recursive: true });
      // UTF-8への変換を挟まず、通常ファイルは固定Git blobのbyteを保持する。
      const oid = meta.split(" ")[2]!;
      const content = await reviewProcess("git", ["--git-dir", snapshot, "cat-file", "blob", oid], { ...options, maxBytes: 64 * 1024 * 1024 });
      writeFileSync(join(work, path), content.stdoutBytes);
      totalBytes += lstatSync(join(work, path)).size;
      if (totalBytes > 128 * 1024 * 1024) throw new ReviewFailure("REPAIR_PREPARATION_INCOMPLETE", "隔離検証用の資料が128MiBを超えるため環境準備を確認できません");
      chmodSync(join(work, path), mode === "100755" ? 0o755 : 0o644);
    }
    const fingerprints = new Map<string, string | null>([...modes].map(([path]) => [path, hash(readFileSync(join(work, path)))]));
    const unchanged = () => {
      for (const [path, digest] of fingerprints) {
        const file = join(work, path);
        const stat = fileStat(file);
        if (digest === null ? stat !== undefined : !stat?.isFile() || (stat.mode & 0o111 ? "100755" : "100644") !== modes.get(path) || hash(readFileSync(file)) !== digest) throw new ReviewFailure("VALIDATION_TARGET_CHANGED", "準備・検証コマンドが固定対象を変更しました");
      }
    };
    const temporaryDirectory = mkdtempSync(join(work, ".nod-review-tmp-"));
    const quote = (value: string) => JSON.stringify(value);
    const sandboxPolicy = `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath ${quote(work)}))(allow file-write* (literal "/dev/null"))(deny file-read* (subpath ${quote(realpathSync(target.repo))}))(deny file-read* (regex #"(^|/)([.]env([.][^/]*)?|[.]aws|credentials[^/]*|id_rsa|id_ed25519)(/|$)"))`;
    const runCommands = async (commands: Command[], phase: "prepare" | "verify") => {
      for (const command of commands) {
        check();
        const record: RepairResult["commands"][number] = { phase, command, status: "incomplete" };
        repair.commands.push(record);
        try {
          const response = await reviewProcess("sandbox-exec", ["-p", sandboxPolicy, command.command, ...command.args], { ...options, temporaryDirectory });
          record.elapsedMs = response.elapsedMs;
          record.stdoutHash = hash(response.stdout); record.stderrHash = hash(response.stderr);
          unchanged(); check(); record.status = "completed";
        } catch (error) {
          const code = error instanceof ReviewFailure && ["DEADLINE_EXCEEDED", "CANCELLED", "VALIDATION_TARGET_CHANGED", "REQUIREMENTS_CHANGED"].includes(error.code) ? error.code : phase === "prepare" ? "REPAIR_PREPARATION_FAILED" : "VALIDATION_FAILED";
          record.problem = { code, message: error instanceof ReviewFailure ? error.message : "隔離コマンドを実行できません" };
          throw new ReviewFailure(code, `${phase === "prepare" ? "環境準備" : "必要な検証"}に失敗しました。${record.problem.message}`);
        }
      }
    };
    // 準備が不要でもsandbox成立を確認する。非隔離実行へのfallbackはしない。
    await runCommands([{ command: "/usr/bin/true", args: [], rationale: "書込・ネットワーク隔離環境の成立確認" }], "prepare");
    await runCommands(plan.prepare, "prepare");
    check();
    repair.model = await invokeRepairModel({ provider: input.repairProvider, model: input.repairModel, implementationModels: initial.execution.implementationModels, reviewModels, cwd: initial.execution.contextPath!, deadline, signal: controller.signal,
      input: JSON.stringify({ phase: "repair", instructions: "日本語で、確定要求から一意に決まる確認済みrequiredだけを修正する。新仕様判断・任意改善・規約や要求を書き換える変更は禁止。モデルは読取専用。shell、Agent、Skill、外部接続を使わない。changesは相対path・変更後の全文content（削除はnull）・対応するaxis:idのfindingIds。未確定ならneedsSpecificationDecision=true。未修正箇所への変更は禁止。", target: { ...target, repo: undefined, local: target.local ? { ...target.local, repo: undefined } : undefined }, sources: initial.sources.map(({ path: _path, content: _content, ...s }) => s), sourceFiles: initial.execution.sourceFiles, excludedEnvironmentSources: repair.excludedEnvironmentSources, findings: required, coverage: initial.coverage, rootCauses: initial.rootCauses, scope: initial.scope }) });
    if (repair.model.problem) throw new ReviewFailure(repair.model.problem.code, repair.model.problem.message);
    check();
    const output = repair.model.output!;
    if (output.target !== target.hash) throw new ReviewFailure("REPAIR_TARGET_MISMATCH", "修正案の対象版が初回の固定対象と一致しません");
    const ids = new Set(required.map(f => `${f.axis}:${f.id}`));
    const seen = new Set<string>();
    const protectedPaths = new Set(initial.sources.flatMap(s => s.type === "standard" ? [s.path!] : s.path && !relative(target.repo, resolve(target.repo, s.path)).startsWith("..") ? [relative(target.repo, resolve(target.repo, s.path))] : []));
    // 全変更を検査してから書く。前半だけ適用して成功にすることはない。
    for (const change of output.changes) {
      safePath(change.path);
      if (seen.has(change.path) || !Array.isArray(change.findingIds) || !change.findingIds.length || change.findingIds.some(id => !ids.has(id)) || (change.content !== null && typeof change.content !== "string")) throw new ReviewFailure("REPAIR_CHANGE_INVALID", "変更の重複・required以外の対応・不正なcontentを受け取りました");
      seen.add(change.path);
      if (protectedPaths.has(change.path) || /(?:^|\/)(?:AGENTS|CLAUDE|CODING_STANDARDS|CONTRIBUTING)\.md$/i.test(change.path)) throw new ReviewFailure("REPAIR_REQUIREMENTS_PROTECTED", "要求・規約を書き換えて修正済みにすることはできません");
      if (change.content !== null && (change.content.includes("\0") || Buffer.byteLength(change.content) > 2 * 1024 * 1024)) throw new ReviewFailure("REPAIR_CHANGE_INVALID", "バイナリ・上限超過の変更は適用できません");
      let parent = dirname(join(work, change.path));
      while (parent !== work) { if (fileStat(parent) && !fileStat(parent)!.isDirectory()) throw new ReviewFailure("REPAIR_PATH_INVALID", "修正先の親は通常ディレクトリではありません"); parent = dirname(parent); }
      if (fileStat(join(work, change.path)) && !fileStat(join(work, change.path))!.isFile()) throw new ReviewFailure("REPAIR_PATH_INVALID", "修正先は通常ファイルではありません");
    }
    if (!output.changes.length) throw new ReviewFailure("REPAIR_NO_PROGRESS", "確認済み要対応に対する変更がありません");
    const originalPaths = new Set(modes.keys());
    const updates: string[] = [];
    for (const change of output.changes) {
      const destination = join(work, change.path);
      if (change.content === null) { rmSync(destination, { force: true }); fingerprints.set(change.path, null); updates.push(`0 ${"0".repeat(target.headSha.length)}\t${change.path}\0`); }
      else {
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, change.content);
        const mode = modes.get(change.path) ?? "100644";
        modes.set(change.path, mode);
        chmodSync(destination, mode === "100755" ? 0o755 : 0o644);
        fingerprints.set(change.path, hash(change.content));
        const oid = (await git(["hash-object", "-w", "--no-filters", "--", destination])).trim();
        updates.push(`${mode} ${oid}\t${change.path}\0`);
      }
    }
    await git(["update-index", "-z", "--index-info"], updates.join(""));
    const treeSha = (await git(["write-tree"])).trim();
    const patch = await git(["diff", "--src-prefix=a/", "--dst-prefix=b/", "--no-ext-diff", "--no-textconv", "--binary", beforeTree, treeSha, "--"]);
    writeFileSync(repair.patchPath, patch);
    if (!patch) throw new ReviewFailure("REPAIR_NO_PROGRESS", "修正後の対象が変更されていません");
    const finalTarget: Target = { ...target, commitMessages: undefined, commitMessagesTruncated: undefined, mode: "local", local: { repo: snapshot, treeSha, indexTreeSha: target.local?.indexTreeSha ?? beforeTree, indexHash: target.local?.indexHash ?? "", sourceFingerprint: target.local?.sourceFingerprint ?? "", stagedPatch: target.local?.stagedPatch ?? "", untracked: [...new Set([...(target.local?.untracked ?? []), ...output.changes.filter(c => !originalPaths.has(c.path) && c.content !== null).map(c => c.path)])] },
      hash: hash(JSON.stringify({ initial: target.hash, treeSha })), patch: await git(["diff", "--src-prefix=a/", "--dst-prefix=b/", "--no-ext-diff", "--no-textconv", "--binary", target.mergeBaseSha, treeSha, "--"]), files: (await git(["diff", "--name-only", "-z", target.mergeBaseSha, treeSha, "--"])).split("\0").filter(Boolean) };
    const cumulative = await git(["diff", "--src-prefix=a/", "--dst-prefix=b/", "--no-ext-diff", "--no-textconv", "--binary", origin.target!.local?.treeSha ?? origin.target!.headSha, treeSha, "--"]);
    repair.cumulativePatchPath = join(directory, "cumulative.patch");
    writeFileSync(repair.cumulativePatchPath, cumulative, { flag: "wx" });
    repair.finalTarget = finalTarget;
    check();
    const reviewDirectory = join(directory, "review");
    mkdirSync(reviewDirectory);
    const fixed: ReviewPreparation = { schemaVersion: 1, runId: initial.runId, startedAt: initial.startedAt, status: "prepared", score: null, target: finalTarget, sources: initial.sources, standardScope: initial.standardScope, responsibility: initial.responsibility, requirements: { ...initial.requirements, consistency: "unverified" }, review: { standards: "not_started", spec: "not_started" }, problems: [], remaining: [], artifactPath: join(reviewDirectory, "preparation.json") };
    writeFileSync(fixed.artifactPath, JSON.stringify(fixed, null, 2) + "\n", { flag: "wx" });
    const reviewed = await review(db, { ...input, deadline, signal: controller.signal, implementationModels: [...new Set([...initial.execution.implementationModels, ...repair.model.effectiveModels])].join(",") }, fixed);
    repair.reviewPath = reviewed.artifactPath;
    result = { ...reviewed, initialReviewPath: origin.initialReviewPath, repair, artifactPath: join(directory, "result.json") };
    check();
    // チェック結果はレビューに渡さず、受け渡し制御だけが確認する。
    await runCommands(plan.verify, "verify");
    if (reviewed.status !== "completed" || reviewed.score !== 5) throw new ReviewFailure("REREVIEW_INCOMPLETE", "修正後の両軸の確認・要求充足・要対応0件が成立していません");
    repair.status = "ready";
  } catch (error) {
    const problem = { code: error instanceof ReviewFailure ? error.code : "REPAIR_FAILED", message: error instanceof ReviewFailure ? error.message : "隔離修正に失敗しました" };
    repair.problems.push(problem);
    result.problems.push(problem);
    result.status = "incomplete"; result.score = null;
    result.remaining = [...new Set([...result.remaining, ...result.problems.map(p => p.message)])];
  } finally {
    controller.abort();
    process.off("SIGINT", abort); process.off("SIGTERM", abort); process.off("SIGHUP", abort);
    input.signal?.removeEventListener("abort", abort);
    result.execution = { ...result.execution, deadline: origin.execution.deadline, elapsedMs: Date.now() - Date.parse(origin.startedAt) };
    writeFileSync(repair.artifactPath, JSON.stringify(repair, null, 2) + "\n", { flag: "wx" });
    writeFileSync(result.artifactPath, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  }
  return result;
}
