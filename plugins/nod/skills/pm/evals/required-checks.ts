import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 偽GitHubの基点ブランチの必須チェックの設定。unset=保護なし・ルールセットなし、set=ブランチ保護に必須チェック test、error=読取が権限不足（HTTP 403）で失敗する。 */
export type RequiredChecksMode = "unset" | "set" | "error";
const requiredChecksModes: RequiredChecksMode[] = ["unset", "set", "error"];
/** 読み取りの結果。設定あり=必須チェックを1件以上読めた、未設定=両方を読めて必須チェックが無い、確認できない=それ以外（読めない・見えない・想定外の形）。 */
export type RequiredChecksOutcome = "設定あり" | "未設定" | "確認できない";
/** 提出・マージの報告に書く、基点ブランチの必須チェックの設定。マージ可否・merge-ready・In Review・Done の条件ではなく報告事項。 */
export type RequiredChecks = { base: string; commands: string[][]; outcome: RequiredChecksOutcome; contexts: string[]; note: string };
export type GhResult = { exitCode: number; stdout: string; stderr: string };
export type Gh = (args: string[]) => GhResult;

/** 両方を読めて必須チェックが無いときだけ報告に書く文。読めないときには書かない。 */
const NO_REQUIRED_CHECKS = "このリポジトリは必須チェックが設定されておらず、CI が落ちていても GitHub はマージを止めない";
const REPO = "evaluation/api";
const MODE_FILE = "github-required-checks.json";

/** シナリオの偽GitHubの応答を保存する。保存が無ければ unset。 */
export function saveRequiredChecksMode(dir: string, mode: RequiredChecksMode) {
  writeFileSync(join(dir, MODE_FILE), JSON.stringify({ mode }));
}

/** setup の引数で指定した偽GitHubの応答（省略時 unset）。 */
export function requiredChecksModeArg(value: string | undefined): RequiredChecksMode {
  const mode = (value ?? "unset") as RequiredChecksMode;
  if (!requiredChecksModes.includes(mode)) throw new Error(`未対応の必須チェックの応答: ${value}（${requiredChecksModes.join("・")}）`);
  return mode;
}

/**
 * 偽GitHubの読取専用の `gh api`。evaluation/api の基点ブランチ（branches/<基点>）とそのルールセット（rules/branches/<基点>）だけを、
 * `--paginate`・`--slurp`・`?per_page=`・`?page=` を含めて受け付ける。それ以外（書込み・他の対象・未対応のオプション）は null。
 */
function fakeGhApi(dir: string, argv: string[]): GhResult | null {
  if (argv[0] !== "api") return null;
  const options = argv.slice(1).filter(arg => arg.startsWith("-"));
  const paths = argv.slice(1).filter(arg => !arg.startsWith("-"));
  if (paths.length !== 1 || options.some(option => option !== "--paginate" && option !== "--slurp")) return null;
  const [path, query = ""] = paths[0]!.replace(/^\//, "").split("?", 2);
  if (query !== "" && !query.split("&").every(pair => /^(per_page|page)=\d+$/.test(pair))) return null;
  const match = path!.match(new RegExp(`^repos/${REPO}/(branches|rules/branches)/([^/]+)$`));
  if (!match) return null;
  const branch = decodeURIComponent(match[2]!);
  const rules = match[1] === "rules/branches";
  if (options.includes("--slurp") && !options.includes("--paginate")) return { exitCode: 1, stdout: "", stderr: "the `--slurp` option is only supported with `--paginate`\n" };
  const file = join(dir, MODE_FILE);
  const mode: RequiredChecksMode = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).mode : "unset";
  if (mode === "error") {
    const documentation = rules ? "https://docs.github.com/rest/repos/rules#get-rules-for-a-branch" : "https://docs.github.com/rest/branches/branches#get-a-branch";
    return { exitCode: 1, stdout: JSON.stringify({ message: "Resource not accessible by integration", documentation_url: documentation, status: "403" }), stderr: "gh: Resource not accessible by integration (HTTP 403)\n" };
  }
  const body = rules ? [] : {
    name: branch, commit: { sha: "b".repeat(40) }, protected: mode === "set",
    protection: mode === "set"
      ? { enabled: true, required_status_checks: { enforcement_level: "non_admins", contexts: ["test"], checks: [{ context: "test", app_id: 15368 }] } }
      : { enabled: false, required_status_checks: { enforcement_level: "off", contexts: [], checks: [] } },
    protection_url: `https://api.github.com/repos/${REPO}/branches/${encodeURIComponent(branch)}/protection`,
  };
  return { exitCode: 0, stdout: JSON.stringify(options.includes("--slurp") ? [body] : body), stderr: "" };
}

/** 偽CLIの `gh api` の入口。必須チェックの設定の読取なら応答を出してその終了コードで終わり、それ以外は reject で拒否する。 */
export function answerGhApi(dir: string, argv: string[], reject: (code: string, message: string) => never): never {
  const result = fakeGhApi(dir, argv) ?? reject("PM_GITHUB_WRITE", "偽GitHubの gh api は基点ブランチの必須チェックの設定の読取だけを提供します（書込み・他の対象・未対応のオプションは拒否）");
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr.trimEnd());
  process.exit(result.exitCode);
}

/** 偽workerが偽GitHubを実行ファイルとして呼ぶ。操作ログには偽CLIが origin: worker で残す。 */
export function workerGh(dir: string, env: Record<string, string | undefined>): Gh {
  return args => {
    const result = Bun.spawnSync([join(dir, "bin/gh"), ...args], { env: { ...env, PM_EVAL_ORIGIN: "worker" } });
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };
}

type Source = { name: string; checks: string[]; problem: string | null };
const object = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

// ブランチ保護（branches/<基点> の応答）の必須のステータスチェック。保護ありで設定が見えなければ確認できない。
function branchProtection(body: unknown): Omit<Source, "name"> {
  const branch = object(body);
  if (typeof branch?.protected !== "boolean") return { checks: [], problem: "ブランチの応答に protected が無い" };
  if (!branch.protected) return { checks: [], problem: null };
  const rsc = object(object(branch.protection)?.required_status_checks);
  if (rsc === null) return { checks: [], problem: "ブランチは保護されているが、必須のステータスチェックの設定が見えない（権限が足りない可能性がある）" };
  if (rsc.enforcement_level === "off") return { checks: [], problem: null };
  const listed = rsc.checks ?? [];
  const contexts = rsc.contexts ?? [];
  if (!Array.isArray(listed) || !Array.isArray(contexts)) return { checks: [], problem: "必須のステータスチェックの形が想定と違う" };
  const names = [...listed.map(item => object(item)?.context), ...contexts];
  if (!names.every(name => typeof name === "string")) return { checks: [], problem: "必須のステータスチェックの項目に名前が無い" };
  return { checks: [...new Set(names as string[])], problem: null };
}

// ルールセット（rules/branches/<基点> の全ページ）の required_status_checks。
function rulesets(pages: unknown): Omit<Source, "name"> {
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) return { checks: [], problem: "ルールセットの応答の形が想定と違う" };
  const names: unknown[] = [];
  for (const rule of pages.flat()) {
    const r = object(rule);
    if (r?.type !== "required_status_checks") continue;
    const items = object(r.parameters)?.required_status_checks;
    if (!Array.isArray(items)) return { checks: [], problem: "ルールセットの required_status_checks の形が想定と違う" };
    names.push(...items.map(item => object(item)?.context));
  }
  if (!names.every(name => typeof name === "string")) return { checks: [], problem: "ルールセットの必須のステータスチェックに名前が無い" };
  return { checks: [...new Set(names as string[])], problem: null };
}

function read(name: string, result: GhResult, parse: (body: unknown) => Omit<Source, "name">): Source {
  if (result.exitCode !== 0) return { name, checks: [], problem: `${name}を読めない（${result.stderr.trim().split("\n")[0] || `終了 ${result.exitCode}`}）` };
  let body: unknown;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    return { name, checks: [], problem: `${name}の応答が JSON でない` };
  }
  return { name, ...parse(body) };
}

/**
 * 基点ブランチの必須チェックの設定を、ブランチ保護とルールセットの両方から読み、設定あり・未設定・確認できないのどれか1つにする。
 * 読めない・見えないことは設定が無いことを示さないので、両方を読めて必須チェックが無いときだけ未設定とし、未設定の文を書く。
 */
export function readRequiredChecks(base: string, gh: Gh): RequiredChecks {
  const branch = encodeURIComponent(base);
  const commands = [["api", `repos/${REPO}/branches/${branch}`], ["api", "--paginate", "--slurp", `repos/${REPO}/rules/branches/${branch}?per_page=100`]];
  const sources = [read("ブランチ保護", gh(commands[0]!), branchProtection), read("ルールセット", gh(commands[1]!), rulesets)];
  const contexts = [...new Set(sources.flatMap(source => source.checks))];
  const problems = sources.flatMap(source => source.problem === null ? [] : [source.problem]);
  if (contexts.length > 0) {
    const found = contexts.map(context => `${context}（${sources.filter(source => source.checks.includes(context)).map(source => source.name).join("・")}）`);
    return { base, commands, outcome: "設定あり", contexts, note: `必須チェックが設定されている: ${found.join("、")}${problems.length ? `。ただし${problems.join("。")}` : ""}` };
  }
  if (problems.length === 0) return { base, commands, outcome: "未設定", contexts, note: NO_REQUIRED_CHECKS };
  return { base, commands, outcome: "確認できない", contexts, note: `必須チェックの設定を読めず、設定の有無を確認できない（${problems.join("。")}）` };
}
