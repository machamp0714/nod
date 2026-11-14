#!/usr/bin/env bun
// nod:code-review の親が、同じ head SHA に対する CI の結果を GitHub から読み、必須のチェックがすべて成功かを判定する（parent.md 3節・10節・13節）。
// 必須のチェックは次の3つの出典の和集合とし、どれか1つに絞らない: ブランチ保護（branches/<基点> の protection.required_status_checks）、
// ルールセット（rules/branches/<基点> の required_status_checks）、Workspace の規約の「必須のチェック」の節。どれかの出典を決められなければ判定を甘くせず不可にする。
// GitHub へは読み取り（GET）だけで、CI を実行・再実行・待機しない。観測した時点の結果で判定する。
// 使い方: bun ci-checks.ts --repo <元のリポジトリの絶対パス> --base <基点の GitHub ブランチ名> --head <head の40桁 SHA>
//   --rules <Workspace 規約（nod workspace rules show の出力）のファイルの絶対パス> --out <記録の出力ディレクトリの絶対パス（存在しないか空）>
// gh は NOD_GH（無ければ gh）を、--repo を作業ディレクトリにして起動する。
// 結果: 標準出力に JSON を1行出し、同じものを <out>/result.json に書く。gh の生の応答は <out>/ の repo.json・branch.json・rules.json・commit.json・
// check-runs.ndjson・statuses.ndjson（取れたものだけ）、gh の失敗は <out>/errors.txt に置き、結果の files にそれぞれの sha256 を入れる。
// 終了コード 0 = 判定した（判定が成功でなくても 0）、2 = 引数の誤り（code INVALID_INPUT）
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

type Verdict = "成功" | "失敗" | "未確定" | "結果なし" | "取得できず" | "必須のチェックなし" | "必須のチェックを決められず";
// 必須のチェック1件ごとの結果
type CheckResult = "成功" | "失敗" | "未確定" | "結果なし";
type SourceName = "branch-protection" | "rulesets" | "workspace-rules";

// 必須のチェック。appId があれば、その app の check run だけで満たす
interface Check {
  context: string;
  appId: number | null;
}

// 出典ごとの読み取りの結果。read = 1件以上読めた、none = 読めて0件、undetermined = 決められず
interface Source {
  status: "read" | "none" | "undetermined";
  message: string;
  checks: Check[];
}

// 照合に使った check run と commit status。outcome は判定用で、結果の JSON には出さない
interface Run {
  kind: "check-run" | "status";
  id: number | null;
  name: string;
  status: string;
  conclusion: string | null;
  appId: number | null;
  url: string | null;
  completedAt: string | null;
  outcome: "success" | "failure" | "pending";
}

interface Required extends Check {
  sources: SourceName[];
  result: CheckResult;
  runs: Omit<Run, "outcome">[];
}

type Gh = { ok: true; stdout: string } | { ok: false; httpStatus: number | null; message: string };

const SHA = /^[0-9a-f]{40}$/i;
// Workspace 規約の「必須のチェック」の節の見出しと、節を終える見出し
const RULES_HEADING = /^#{1,6}\s*必須のチェック\s*$/;
const HEADING = /^#{1,6}(\s|$)/;
// 節の中の字下げしない箇条書き（- か *）
const BULLET = /^[-*]\s+(.*?)\s*$/;
const UNREGISTERED = "作業規約は登録されていません";
// git のブランチ名に使えない並び（git check-ref-format の規則の一部）と、オプションと取り違える先頭の -
const BAD_BRANCH = /[\s~^:?*[\\\x00-\x1f\x7f]|\.\.|@\{|\/\/|^[-/.]|[/.]$|\.lock$/;
// gh の呼び出しの上限時間。CI の完了は待たないので、応答が返らないときだけ打ち切る
const GH_TIMEOUT_MS = 120_000;

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

function emit(result: Record<string, unknown>, exitCode: 0 | 2): never {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(exitCode);
}

function usage(message: string): never {
  emit({ ok: false, code: "INVALID_INPUT", message }, 2);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// 同じ context と app の項目を1件にまとめる
function addCheck(checks: Check[], check: Check): void {
  if (!checks.some((c) => c.context === check.context && c.appId === check.appId)) checks.push(check);
}

function source(checks: Check[], readMessage: string, noneMessage: string): Source {
  return checks.length > 0 ? { status: "read", message: readMessage, checks } : { status: "none", message: noneMessage, checks };
}

function undetermined(message: string): Source {
  return { status: "undetermined", message, checks: [] };
}

function parseArgs(args: string[]): Record<"repo" | "base" | "head" | "rules" | "out", string> {
  const keys = ["repo", "base", "head", "rules", "out"] as const;
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, "") ?? "";
    const value = args[i + 1];
    if (!args[i]?.startsWith("--") || !(keys as readonly string[]).includes(key)) usage(`知らない引数です: ${args[i]}`);
    if (values.has(key)) usage(`--${key} が重なっています`);
    if (value === undefined) usage(`--${key} の値がありません`);
    values.set(key, value);
  }
  const missing = keys.filter((key) => !values.has(key));
  if (missing.length > 0) {
    usage(`--${missing.join("・--")} がありません。使い方: bun ci-checks.ts --repo <絶対パス> --base <ブランチ名> --head <40桁 SHA> --rules <絶対パス> --out <絶対パス>`);
  }
  return Object.fromEntries(keys.map((key) => [key, values.get(key) ?? ""])) as Record<(typeof keys)[number], string>;
}

// Workspace 規約の「必須のチェック」の節（複数あれば合わせる）の箇条書き。名前を囲むバッククォートは外す
function workspaceRules(body: string): Source {
  if (body.trim() === UNREGISTERED) return { status: "none", message: "作業規約が登録されていない", checks: [] };
  const checks: Check[] = [];
  let inSection = false;
  for (const line of body.split(/\r?\n/)) {
    if (RULES_HEADING.test(line)) inSection = true;
    else if (HEADING.test(line)) inSection = false;
    else if (inSection) {
      const name = BULLET.exec(line)?.[1]?.replace(/^`([^`]+)`$/, "$1");
      if (name) addCheck(checks, { context: name, appId: null });
    }
  }
  return source(checks, "作業規約の「必須のチェック」の節から読んだ", "作業規約に「必須のチェック」の節が無い、または節に項目が無い");
}

// ブランチ保護（branches/<基点> の応答）の必須のステータスチェック。/protection は admin 以外で読めないので使わない
function branchProtection(body: unknown): Source {
  const branch = record(body);
  if (typeof branch?.protected !== "boolean") return undetermined("ブランチの応答に protected が無い");
  if (!branch.protected) return { status: "none", message: "基点のブランチは保護されていない", checks: [] };
  const rsc = record(record(branch.protection)?.required_status_checks);
  if (rsc === null) return undetermined("ブランチは保護されているが、必須のステータスチェックが見えない（権限が足りない可能性がある）");
  if (rsc.enforcement_level === "off") return { status: "none", message: "必須のステータスチェックの強制が off", checks: [] };
  const checks: Check[] = [];
  const listed = rsc.checks ?? [];
  const contexts = rsc.contexts ?? [];
  if (!Array.isArray(listed) || !Array.isArray(contexts)) return undetermined("必須のステータスチェックの形が想定と違う");
  for (const item of listed) {
    const check = record(item);
    if (typeof check?.context !== "string") return undetermined("必須のステータスチェックの項目に context が無い");
    // app_id が無い・null・-1（どの app でもよい）なら app を問わない
    const appId = typeof check.app_id === "number" && check.app_id >= 0 ? check.app_id : null;
    addCheck(checks, { context: check.context, appId });
  }
  // contexts は checks の古い形の写し。checks に無い名前だけを app を問わない項目として加える
  for (const context of contexts) {
    if (typeof context !== "string") return undetermined("必須のステータスチェックの contexts の形が想定と違う");
    if (!checks.some((c) => c.context === context)) addCheck(checks, { context, appId: null });
  }
  return source(checks, "ブランチ保護の必須のステータスチェックを読んだ", "ブランチ保護に必須のステータスチェックが無い");
}

// ルールセット（rules/branches/<基点> の全ページ）の required_status_checks
function rulesets(pages: unknown): Source {
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) return undetermined("ルールセットの応答の形が想定と違う");
  const checks: Check[] = [];
  for (const rule of (pages as unknown[][]).flat()) {
    const r = record(rule);
    if (r?.type !== "required_status_checks") continue;
    const items = record(r.parameters)?.required_status_checks;
    if (!Array.isArray(items)) return undetermined("ルールセットの required_status_checks の形が想定と違う");
    for (const item of items) {
      const check = record(item);
      if (typeof check?.context !== "string") return undetermined("ルールセットの必須のステータスチェックに context が無い");
      addCheck(checks, { context: check.context, appId: typeof check.integration_id === "number" ? check.integration_id : null });
    }
  }
  return source(checks, "ルールセットの必須のステータスチェックを読んだ", "ルールセットに必須のステータスチェックが無い");
}

function checkRun(item: unknown): Run | null {
  const run = record(item);
  if (typeof run?.name !== "string" || typeof run.status !== "string") return null;
  const conclusion = typeof run.conclusion === "string" ? run.conclusion : null;
  // 完了して success 以外（neutral・skipped を含む）は失敗、未完了は未確定
  const outcome = run.status !== "completed" ? "pending" : conclusion === "success" ? "success" : "failure";
  return {
    kind: "check-run",
    id: typeof run.id === "number" ? run.id : null,
    name: run.name,
    status: run.status,
    conclusion,
    appId: typeof record(run.app)?.id === "number" ? (record(run.app)?.id as number) : null,
    url: typeof run.html_url === "string" ? run.html_url : null,
    completedAt: typeof run.completed_at === "string" ? run.completed_at : null,
    outcome,
  };
}

function commitStatus(item: unknown): Run | null {
  const status = record(item);
  if (typeof status?.context !== "string" || typeof status.state !== "string") return null;
  const pending = status.state === "pending";
  return {
    kind: "status",
    id: typeof status.id === "number" ? status.id : null,
    name: status.context,
    status: pending ? "pending" : "completed",
    conclusion: pending ? null : status.state,
    appId: null,
    url: typeof status.target_url === "string" ? status.target_url : null,
    completedAt: typeof status.updated_at === "string" ? status.updated_at : null,
    outcome: pending ? "pending" : status.state === "success" ? "success" : "failure",
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  for (const key of ["repo", "rules", "out"] as const) {
    if (!isAbsolute(args[key])) usage(`--${key} は絶対パスで指定してください: ${args[key]}`);
  }
  if (!SHA.test(args.head)) usage(`--head は40桁の16進の SHA で指定してください: ${args.head}`);
  if (args.base === "" || BAD_BRANCH.test(args.base)) usage(`--base はブランチ名で指定してください: ${args.base}`);
  const head = args.head.toLowerCase();
  const { repo, base, out } = args;
  try {
    if (!statSync(repo).isDirectory()) usage(`--repo がディレクトリではありません: ${repo}`);
  } catch {
    usage(`--repo が存在しません: ${repo}`);
  }
  let rulesBody: string;
  try {
    rulesBody = readFileSync(args.rules, "utf8");
  } catch (e) {
    usage(`--rules を読めません: ${args.rules}（${(e as NodeJS.ErrnoException).code ?? String(e)}）`);
  }
  try {
    if (readdirSync(out).length > 0) usage(`--out が空ではありません（上書きしない）: ${out}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") usage(`--out を使えません: ${out}（${(e as NodeJS.ErrnoException).code ?? String(e)}）`);
    mkdirSync(out, { recursive: true });
  }

  const gh = process.env.NOD_GH || "gh";
  const files: Record<string, string> = {};
  let errors = "";
  const save = (name: string, body: string) => {
    writeFileSync(join(out, name), body);
    files[name] = sha256(body);
  };
  // gh を読み取りだけで呼ぶ。成功なら生の応答を <out>/<file> に残し、失敗なら stderr（と応答の本文）を errors.txt に足す
  const call = (ghArgs: string[], file: string): Gh => {
    const shown = `gh ${ghArgs.join(" ")}`;
    let p: Bun.SyncSubprocess<"pipe", "pipe">;
    try {
      p = Bun.spawnSync([gh, ...ghArgs], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: GH_TIMEOUT_MS });
    } catch (e) {
      errors += `$ ${shown}\n${String(e)}\n\n`;
      return { ok: false, httpStatus: null, message: `${shown} を起動できない（${String(e)}）` };
    }
    const stdout = p.stdout?.toString() ?? "";
    const stderr = p.stderr?.toString() ?? "";
    if (p.exitCode === 0) {
      save(file, stdout);
      return { ok: true, stdout };
    }
    errors += `$ ${shown}\n終了: ${p.exitCode ?? p.signalCode}\n${stderr}${stdout === "" ? "" : `${stdout}\n`}\n`;
    const http = /\(HTTP (\d{3})\)/.exec(stderr);
    const first = stderr.trim().split("\n")[0] || `終了 ${p.exitCode ?? p.signalCode}`;
    return { ok: false, httpStatus: http ? Number(http[1]) : null, message: `${shown} が失敗（${first}）` };
  };
  // 1行1件の応答（--jq '.[] | tojson'）を読む。読めない行があれば null
  const lines = (stdout: string): unknown[] | null => {
    try {
      return stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as unknown);
    } catch {
      return null;
    }
  };
  const json = (stdout: string): unknown => {
    try {
      return JSON.parse(stdout) as unknown;
    } catch {
      return undefined;
    }
  };

  // 1. リポジトリ
  let repository: string | null = null;
  const repoView = call(["repo", "view", "--json", "nameWithOwner"], "repo.json");
  const nameWithOwner = repoView.ok ? record(json(repoView.stdout))?.nameWithOwner : undefined;
  if (typeof nameWithOwner === "string" && /^[\w.-]+\/[\w.-]+$/.test(nameWithOwner)) repository = nameWithOwner;
  const repoProblem = repository !== null ? null : repoView.ok ? "gh repo view の応答から owner/repo を読めない" : repoView.message;

  // 2. 必須のチェックの3つの出典
  let protection: Source;
  let rules: Source;
  if (repository === null) {
    protection = undetermined(`リポジトリを決められない: ${repoProblem}`);
    rules = undetermined(`リポジトリを決められない: ${repoProblem}`);
  } else if (SHA.test(base)) {
    protection = undetermined(`基点がブランチ名でない（SHA）: ${base}`);
    rules = undetermined(`基点がブランチ名でない（SHA）: ${base}`);
  } else {
    const branchPath = base.split("/").map(encodeURIComponent).join("/");
    const branch = call(["api", `repos/${repository}/branches/${branchPath}`], "branch.json");
    protection = branch.ok ? branchProtection(json(branch.stdout)) : undetermined(`ブランチ保護を読めない: ${branch.message}`);
    // 全ページを1つの配列（ページの配列）にまとめ、ページの連結で JSON を壊さない
    const ruleList = call(["api", "--paginate", "--slurp", `repos/${repository}/rules/branches/${branchPath}?per_page=100`], "rules.json");
    rules = ruleList.ok ? rulesets(json(ruleList.stdout)) : undetermined(`ルールセットを読めない: ${ruleList.message}`);
  }
  const workspace = workspaceRules(rulesBody);

  const required: Required[] = [];
  const named: [SourceName, Source][] = [
    ["branch-protection", protection],
    ["rulesets", rules],
    ["workspace-rules", workspace],
  ];
  for (const [name, src] of named) {
    for (const check of src.checks) {
      const same = required.find((r) => r.context === check.context && r.appId === check.appId);
      if (same) same.sources.push(name);
      else required.push({ ...check, sources: [name], result: "結果なし", runs: [] });
    }
  }

  // 3. 同じ head SHA の CI の結果
  const observedAt = new Date().toISOString();
  let headMissing: string | null = null;
  let fetchFailed: string | null = null;
  const runs: Run[] = [];
  if (repository === null) {
    fetchFailed = `リポジトリを決められない: ${repoProblem}`;
  } else {
    const commit = call(["api", `repos/${repository}/commits/${head}`], "commit.json");
    const commitSha = commit.ok ? record(json(commit.stdout))?.sha : undefined;
    if (!commit.ok && (commit.httpStatus === 404 || commit.httpStatus === 422)) headMissing = `head ${head} が GitHub に無い（${commit.message}）`;
    else if (!commit.ok) fetchFailed = `head のコミットを読めない: ${commit.message}`;
    else if (commitSha !== head) headMissing = `head ${head} が GitHub に無い（commits/${head} が別のコミット ${String(commitSha)} を返した）`;
    else {
      const checkRuns = call(["api", "--paginate", "--jq", ".check_runs[] | tojson", `repos/${repository}/commits/${head}/check-runs?per_page=100`], "check-runs.ndjson");
      const items = checkRuns.ok ? lines(checkRuns.stdout) : null;
      const parsed = items?.map(checkRun);
      if (!checkRuns.ok) fetchFailed = `check run を読めない: ${checkRuns.message}`;
      else if (!parsed || parsed.some((r) => r === null)) fetchFailed = "check run の応答の形が想定と違う";
      // 別の head の check run は使わない
      else runs.push(...parsed.filter((r, i): r is Run => r !== null && record(items?.[i])?.head_sha === head));

      const statuses = call(["api", "--paginate", "--jq", ".statuses[] | tojson", `repos/${repository}/commits/${head}/status?per_page=100`], "statuses.ndjson");
      const statusItems = statuses.ok ? lines(statuses.stdout)?.map(commitStatus) : null;
      if (!statuses.ok) fetchFailed ??= `commit status を読めない: ${statuses.message}`;
      else if (!statusItems || statusItems.some((r) => r === null)) fetchFailed ??= "commit status の応答の形が想定と違う";
      else runs.push(...statusItems.filter((r): r is Run => r !== null));
    }
  }

  // 必須のチェック1件ごと: 同名の check run（app 指定があればその app のものだけ）と、app 指定が無いときだけ同名の commit status
  for (const item of required) {
    const candidates = runs.filter((r) => r.name === item.context && (r.kind === "check-run" ? item.appId === null || r.appId === item.appId : item.appId === null));
    item.runs = candidates.map(({ outcome: _outcome, ...rest }) => rest);
    if (candidates.length === 0) item.result = "結果なし";
    else if (candidates.some((r) => r.outcome === "failure")) item.result = "失敗";
    else if (candidates.some((r) => r.outcome === "pending")) item.result = "未確定";
    else item.result = "成功";
  }

  const names = (result: CheckResult) =>
    required
      .filter((r) => r.result === result)
      .map((r) => `${r.context}${r.appId === null ? "" : `（app ${r.appId}）`}`)
      .join("・");
  const failed = required.filter((r) => r.result === "失敗");
  let verdict: Verdict;
  let reason: string;
  const unknownSources = named.filter(([, src]) => src.status === "undetermined");
  if (unknownSources.length > 0) {
    verdict = "必須のチェックを決められず";
    reason = `必須のチェックを決められない出典がある: ${unknownSources.map(([name, src]) => `${name}（${src.message}）`).join("、")}`;
  } else if (required.length === 0) {
    verdict = "必須のチェックなし";
    reason = "ブランチ保護・ルールセット・Workspace の規約のどれにも必須のチェックが無い";
  } else if (fetchFailed !== null) {
    verdict = "取得できず";
    reason = fetchFailed;
  } else if (headMissing !== null) {
    verdict = "結果なし";
    reason = headMissing;
  } else if (failed.length > 0) {
    verdict = "失敗";
    reason = `失敗した必須のチェックがある: ${failed.map((r) => `${r.context}（${r.runs.map((run) => run.conclusion).join("・")}）`).join("、")}`;
  } else if (required.some((r) => r.result === "未確定")) {
    verdict = "未確定";
    reason = `完了していない必須のチェックがある: ${names("未確定")}`;
  } else if (required.some((r) => r.result === "結果なし")) {
    verdict = "結果なし";
    reason = `head ${head} に結果の無い必須のチェックがある: ${names("結果なし")}`;
  } else {
    verdict = "成功";
    reason = `必須のチェック ${required.length} 件がすべて head ${head} で成功`;
  }

  if (errors !== "") save("errors.txt", errors);
  const result = {
    ok: true,
    verdict,
    repository,
    base,
    head,
    observedAt,
    sources: { branchProtection: protection, rulesets: rules, workspaceRules: workspace },
    required,
    reason,
    files,
  };
  writeFileSync(join(out, "result.json"), `${JSON.stringify(result)}\n`);
  emit(result, 0);
}

main();
