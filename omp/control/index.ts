// pstack を OMP で使う組の制御の拡張。適用（scripts/pstack-omp/cli.ts apply）が nod のデータ置き場の pstack-omp/omp/control に写し、
// 利用者の OMP の設定の extensions にこのディレクトリだけを登録する。読み込みの設定は同じ写しの harness.json（適用が書く組の記録）から、
// 禁止操作を止める規則は同じ写しの rules.json（nod のリポジトリの omp/control/rules.json。形は rules.ts）から読む。
// 写しは書き込み権限を外した、作業中のリポジトリや clone の外の置き場で、規則も組の記録の sha256 で確かめる。
//
// - 組の記録と規則を検証する（読める、形が正しい、指すディレクトリがある、組の各ファイルの sha256 が記録と同じ、files に規則が入っている、
//   規則の形が正しい）。正しくなければ、メインでも子でも全ツールと子の起動を遮断し、理由を返す。読み込みの設定も規則も入れない
//   （新しい構成のまま、読み込み先や規則が壊れた状態でツールを使わせない）。
// - 正しければ、拡張の読み込み（factory）で、読み込みの設定と規則の上書きを同じ処理で実行時の層（永続しない。global・project・--config
//   より強く、OMP の運用者の層にも入るのでプロジェクトの設定では緩められない）に書く。固定するキーは extensions・disabledExtensions・
//   skills.customDirectories・skills.manualSkills・tools.approval・bash.patterns。値が同じでも実行時の層から来ていなければ書く
//   （config.yml の書き換えや --config・プロジェクトの層で、実行中に変わらないように）。
//   セッションの開始（session_start）より前に書くのは、メインの task ツールが作られるときにエージェント定義を探すので、
//   そのときまでに OMP 向けのディレクトリ（content）が extensions に入っていないと、メインの task の一覧に poteto-agent が出ないため。
//   factory はセッションごと（子と孫も）に呼ばれ、同じプロセスの子と孫は親と同じ設定を使うので、同じ値なら書き直さない。
// - worker thread の写し（mirror）の設定には書かない（親の設定を写したもので、親が既に書いている）。worker thread はこの拡張を
//   ディスクから読み直すので、同じ検証をし直し、さらにメインのスレッドが検証した組の記録の sha256（環境変数で渡す）と同じかを確かめる。
//   実行中にディスクの組や規則が変わっていれば遮断する。
// - tool_call では、規則のうち構造化された引数だけを検査する（github の op、task の isolated と子と孫が起動するエージェント、
//   書き込みのツールのパス）。シェルの中身は解釈しない（bash は OMP の bash.patterns の deny が止める）。子と孫かどうかは、
//   モデルが渡す引数ではなく実行基盤の ctx.agent で見分ける。子の起動は before_subagent_spawn でも同じく検査する。
// - TUI は、providers・shortcuts・renderer などを何も登録しない拡張の読み込みを、入力欄の表示の後に回すことがある
//   （OMP の extensibility/extensions/startup-deferral.ts）。そうなると task ツールが作られた後に書くことになるので、
//   後回しにさせないため、customType が pstack-omp の message renderer を登録する（この拡張はその種類のメッセージを送らない）。
// - このプロセスが適用より前に始まっていたら（適用より前のセッションに、後から読み込まれたとき）、何もしない。新しいセッションから効く。
// 検証はプロセス（worker thread ではスレッド）で1度だけ行い、同じプロセスの全セッション（メイン・子・孫）で同じ結果を使う。
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, Settings, ToolCallEvent, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { isRecord, parseRules, resolvePlaces, type Rules } from "./rules";

const HERE = import.meta.dir;
// 写しの根（content/ と control/ を持つ）
const ROOT = dirname(HERE);
const HARNESS = join(HERE, "harness.json");
const RULES = "control/rules.json";
const NAME = "pstack-omp";
// メインのスレッドが検証した組の記録の sha256 を、worker thread の子に渡す環境変数
const HARNESS_ENV = "NOD_PSTACK_OMP_HARNESS_SHA256";
// パスを引数に持つ書き込みのツール
const WRITE_TOOLS = ["write", "edit", "apply_patch", "ast_edit"];

// 組の記録のうち、この拡張が使う部分
interface Harness {
  appliedAt: string;
  pin: { commit: string };
  content: string;
  control: string;
  agentDir: string;
  skillDirectories: string[];
  manualSkills: string[];
  // 写しの根からの相対パス → sha256
  files: Record<string, string>;
}

// 検証した組と規則。置き場のプレースホルダは解決済み
interface Control {
  harness: Harness;
  rules: Rules;
  harnessSha: string;
  bashDeny: string[];
  // 別名を解いた形
  protectedPaths: string[];
}

type Verdict = { kind: "ok"; control: Control } | { kind: "blocked"; reason: string } | { kind: "stale"; appliedAt: string };

let verdict: Verdict | undefined;

export default function control(pi: ExtensionAPI): void {
  const mirror = isMirror(pi.pi.settings);
  verdict ??= judge(mirror);
  pi.registerMessageRenderer(NAME, (message) => ({ render: () => [String(message.content)], invalidate: () => {} }));
  const current = verdict;
  if (current.kind === "ok" && !mirror) {
    try {
      overrideSettings(pi.pi.settings, current.control);
      process.env[HARNESS_ENV] = current.control.harnessSha;
    } catch (e) {
      verdict = blocked(`読み込みの設定と規則を書けませんでした: ${(e as Error).message}`);
    }
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.agent?.kind !== "main") return;
    const current = verdict!;
    if (current.kind === "stale") {
      report(ctx, `${NAME}: 適用（${current.appliedAt}）より前に始まったプロセスなので、このセッションには読み込みません。新しいセッションから効きます`, "info");
      return;
    }
    if (current.kind === "blocked") {
      report(ctx, `${NAME}: ${current.reason}`, "error");
      return;
    }
    const { harness, rules, bashDeny } = current.control;
    report(
      ctx,
      `${NAME}: 適用（${harness.appliedAt}、pin ${harness.pin.commit.slice(0, 12)}）の組を読み込みました（一覧から外すスキル ${harness.manualSkills.length} 個。` +
        `規則 版 ${rules.version}: 拒否するツール ${Object.keys(rules.toolApproval).join(", ")}、bash の拒否のパターン ${bashDeny.length} 個）`,
      "info",
    );
  });

  pi.on("tool_call", (event, ctx) => {
    const current = verdict!;
    if (current.kind === "blocked") return { block: true, reason: `${NAME}: ${current.reason}` };
    if (current.kind === "stale") return undefined;
    return inspect(event, ctx, current.control);
  });

  pi.on("before_subagent_spawn", (event, ctx) => {
    const current = verdict!;
    if (current.kind === "blocked") return { block: true, reason: `${NAME}: ${current.reason}` };
    if (current.kind === "stale") return undefined;
    return checkAgent(typeof event.agent === "string" ? event.agent : undefined, ctx, current.control.rules);
  });
}

function blocked(reason: string): Extract<Verdict, { kind: "blocked" }> {
  return {
    kind: "blocked",
    reason: `${reason}。組（${ROOT}）が正しくないので、ツールを実行しません。bun scripts/pstack-omp/cli.ts status で確かめ、apply し直すか remove してください`,
  };
}

function judge(mirror: boolean): Verdict {
  let bytes: Buffer;
  let raw: unknown;
  try {
    bytes = readFileSync(HARNESS);
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (e) {
    return blocked(`組の記録 ${HARNESS} を読めません: ${(e as Error).message}`);
  }
  const harness = parseHarness(raw);
  if (typeof harness === "string") return blocked(`組の記録 ${HARNESS} の形が正しくありません: ${harness}`);
  if (real(harness.control) !== real(HERE)) return blocked(`組の記録の control（${harness.control}）がこの拡張の置き場（${HERE}）と違います`);
  for (const dir of [harness.content, ...harness.skillDirectories]) {
    if (!isDirectory(dir)) return blocked(`組の記録が指すディレクトリ ${dir} がありません`);
  }
  if (!(RULES in harness.files)) return blocked(`組の記録の files に規則 ${RULES} がありません`);
  const mismatched = Object.entries(harness.files).filter(([rel, sha]) => {
    try {
      return sha256(readFileSync(join(ROOT, rel))) !== sha;
    } catch {
      return true;
    }
  });
  if (mismatched.length > 0) return blocked(`組のファイルが記録と違います（無い、または sha256 が違う）: ${mismatched.map(([rel]) => rel).join(", ")}`);
  let rules: Rules | string;
  try {
    rules = parseRules(JSON.parse(readFileSync(join(ROOT, RULES), "utf8")));
  } catch (e) {
    rules = `読めません: ${(e as Error).message}`;
  }
  if (typeof rules === "string") return blocked(`規則 ${join(ROOT, RULES)} が正しくありません: ${rules}`);
  const harnessSha = sha256(bytes);
  const expected = process.env[HARNESS_ENV];
  if (mirror && expected !== undefined && expected !== harnessSha) {
    return blocked(`組の記録 ${HARNESS} が、メインのスレッドが検証したものと違います（実行中に組が変わった）`);
  }
  if (performance.timeOrigin < Date.parse(harness.appliedAt)) return { kind: "stale", appliedAt: harness.appliedAt };
  const places = { agentDir: harness.agentDir, workDir: dirname(ROOT) };
  return {
    kind: "ok",
    control: {
      harness,
      rules,
      harnessSha,
      bashDeny: rules.bashDeny.map((match) => resolvePlaces(match, places)),
      protectedPaths: rules.protectedPaths.map((path) => realAncestor(resolvePlaces(path, places))),
    },
  };
}

// 形が正しければ記録を、正しくなければ理由を返す
function parseHarness(raw: unknown): Harness | string {
  if (typeof raw !== "object" || raw === null) return "オブジェクトではありません";
  const r = raw as Record<string, unknown>;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x !== "");
  if (r.version !== 1) return `version が 1 ではありません: ${String(r.version)}`;
  if (typeof r.appliedAt !== "string" || Number.isNaN(Date.parse(r.appliedAt))) return "appliedAt が時刻ではありません";
  const pin = r.pin as Record<string, unknown> | null | undefined;
  if (typeof pin?.commit !== "string") return "pin.commit がありません";
  for (const key of ["content", "control", "agentDir"] as const) {
    if (typeof r[key] !== "string" || !isAbsolute(r[key])) return `${key} が絶対パスではありません`;
  }
  if (!strings(r.skillDirectories) || r.skillDirectories.length === 0 || !r.skillDirectories.every((dir) => isAbsolute(dir))) {
    return "skillDirectories が絶対パスの配列ではありません";
  }
  if (!strings(r.manualSkills) || r.manualSkills.length === 0) return "manualSkills が名前の配列ではありません";
  const files = r.files as Record<string, unknown> | null | undefined;
  if (typeof files !== "object" || files === null || Object.keys(files).length === 0) return "files がありません";
  for (const [rel, sha] of Object.entries(files)) {
    if (isAbsolute(rel) || normalize(rel).startsWith("..") || typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) {
      return `files の項目 ${rel} が写しの中の相対パスと sha256 ではありません`;
    }
  }
  return raw as Harness;
}

// 実行時の層に、読み込みの設定と規則の上書きを同じ処理で書く。どれも、いまの実効値（global・project・--config と、前に書いた実行時の層を
// 合わせたもの）を土台にし、何度計算しても同じ値になるようにする。全部の設定を見つけてから書く（片方だけが入る経路を作らない）。
// 値が同じで、既に実行時の層から来ていれば書かない（子と孫の factory で呼ばれたとき、設定の変更を知らせる仕組みを無駄に動かさない）
function overrideSettings(settings: Settings, { harness, rules, bashDeny }: Control): void {
  const handle = (id: string) => {
    const setting = lookup(id);
    if (setting === undefined) throw new Error(`OMP の設定 ${id} がありません`);
    const value = setting.get(settings);
    const write = (next: unknown) => {
      if (setting.provenance(settings) !== "runtime" || JSON.stringify(next) !== JSON.stringify(value)) setting.override(settings, next);
    };
    return { value, write };
  };
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : []);
  const extensions = handle("extensions");
  const customDirectories = handle("skills.customDirectories");
  const manualSkills = handle("skills.manualSkills");
  const disabledExtensions = handle("disabledExtensions");
  const approval = handle("tools.approval");
  const patterns = handle("bash.patterns");
  const ours = new Set([real(harness.content), real(harness.control)]);
  const skillDirs = new Set(harness.skillDirectories.map(real));
  const skillIds = new Set(harness.manualSkills.map((name) => `skill:${name}`));
  const manual = strings(manualSkills.value);
  const denies = new Set(bashDeny.map(collapse));

  // OMP 向けのディレクトリ（content）を足す。この拡張（control）も残す
  const nextExtensions = strings(extensions.value);
  for (const dir of [harness.control, harness.content]) {
    if (!nextExtensions.some((entry) => real(entry) === real(dir))) nextExtensions.push(dir);
  }
  const writes: [typeof extensions, unknown][] = [
    [extensions, nextExtensions],
    // 生成したスキルの置き場を先頭に置く（custom 同士は先が勝つので、pstack の tdd が利用者の置き場の tdd より優先される）
    [customDirectories, [...harness.skillDirectories, ...strings(customDirectories.value).filter((entry) => !skillDirs.has(real(entry)))]],
    // 読み込むスキルをすべて一覧から外す（名前で呼べば使える）
    [manualSkills, [...manual, ...harness.manualSkills.filter((name) => !manual.includes(name))]],
    // 組の置き場と、読み込むスキル（skill:<名前>）を無効にする指定を外す
    [disabledExtensions, strings(disabledExtensions.value).filter((entry) => !ours.has(real(entry)) && !skillIds.has(entry))],
    // 規則のツールの拒否で、同じキーを上書きする（ほかのキーは保つ）
    [approval, { ...(isRecord(approval.value) ? approval.value : {}), ...rules.toolApproval }],
    // 規則の deny を先頭に置く（OMP はパターンを先から照合し、最初に当たったものを使うことがあるので、利用者の allow より先にする）。
    // いまの実効値からは、規則と同じ deny を除いて後ろに残す
    [
      patterns,
      [
        ...bashDeny.map((match) => ({ match, approval: "deny" })),
        ...(Array.isArray(patterns.value) ? patterns.value : []).filter((p) => !(isRecord(p) && p.approval === "deny" && typeof p.match === "string" && denies.has(collapse(p.match)))),
      ],
    ],
  ];
  for (const [setting, next] of writes) setting.write(next);
}

// 規則のうち、構造化された引数で決まるものを検査する。拒否するなら理由を返す
function inspect(event: ToolCallEvent, ctx: ExtensionContext, { rules, protectedPaths }: Control): ToolCallEventResult | undefined {
  const input = isRecord(event.input) ? event.input : {};
  if (event.toolName === "github") {
    if (typeof input.op === "string" && rules.github.denyOps.includes(input.op)) {
      return { block: true, reason: `${NAME}: github の ${input.op} は、この組では拒否します（push と PR の作成はしない）` };
    }
    return undefined;
  }
  if (event.toolName === "task") {
    // task.batch では tasks の各項目、そうでなければ呼び出しそのものが1つの子
    const items = Array.isArray(input.tasks) ? input.tasks.filter(isRecord) : [input];
    for (const item of items) {
      if (rules.task.denyIsolated && item.isolated === true) {
        return { block: true, reason: `${NAME}: task の isolated: true は、この組では拒否します（clone の .omp/extensions が読まれうるため）` };
      }
      const denied = checkAgent(typeof item.agent === "string" ? item.agent : undefined, ctx, rules);
      if (denied !== undefined) return denied;
    }
    return undefined;
  }
  if (!WRITE_TOOLS.includes(event.toolName)) return undefined;
  for (const path of writtenPaths(input)) {
    const target = protectedTarget(path, ctx.cwd, protectedPaths);
    if (target !== undefined) return { block: true, reason: `${NAME}: ${event.toolName} で ${target} には書けません（OMP の設定と pstack-omp の組を、実行中のセッションから変えさせない）` };
  }
  return undefined;
}

// 子と孫（実行基盤の ctx.agent が main でないもの）が起動できるのは、規則のエージェントだけ。名前を省けば既定の task
function checkAgent(agent: string | undefined, ctx: ExtensionContext, rules: Rules): ToolCallEventResult | undefined {
  if (ctx.agent?.kind === "main") return undefined;
  const name = (agent ?? "task").toLowerCase();
  if (rules.task.subAgents.some((allowed) => allowed.toLowerCase() === name)) return undefined;
  return { block: true, reason: `${NAME}: 子と孫が起動できるエージェントは ${rules.task.subAgents.join(", ")} だけです（${agent} は起動しません）` };
}

// 書き込みのツールの引数のうち、書き込む先のパス（write・edit の path、ast_edit の paths、edit の input のファイルの見出しと移動先）
function writtenPaths(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  if (typeof input.path === "string") paths.push(unwrap(input.path));
  if (Array.isArray(input.paths)) paths.push(...input.paths.filter((p): p is string => typeof p === "string"));
  if (typeof input.input === "string") {
    for (const line of input.input.split("\n")) {
      const text = line.trim();
      const header = /^\[(.+)\]$/.exec(text)?.[1];
      const moved = /^MV\s+(.+)$/.exec(text)?.[1];
      const patched = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(text)?.[1];
      if (header !== undefined) paths.push(unwrap(`[${header}]`));
      if (moved !== undefined) paths.push(moved.replace(/^(["'])(.*)\1$/, "$2"));
      if (patched !== undefined) paths.push(patched.trim());
    }
  }
  return paths;
}

// [パス#TAG] の形からパスを取り出す
function unwrap(path: string): string {
  const inner = /^\[(.+)\]$/.exec(path.trim())?.[1];
  return inner === undefined ? path : inner.replace(/#[0-9A-Za-z]+$/, "");
}

// 書けない置き場に入るなら、その置き場を返す。内部の URL（local:// など）は見ない
function protectedTarget(path: string, cwd: string, protectedPaths: string[]): string | undefined {
  const plain = path.startsWith("file://") ? path.slice("file://".length) : path;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(plain)) return undefined;
  const expanded = plain === "~" || plain.startsWith("~/") ? join(homedir(), plain.slice(1)) : plain;
  const target = fold(realAncestor(resolve(cwd, expanded)));
  return protectedPaths.find((path) => {
    const dir = fold(path);
    return target === dir || target.startsWith(`${dir}/`) || target.startsWith(`${dir}:`);
  });
}

// worker thread の子の設定は、親（メインのスレッド）の設定の写し（mirror）か、その上に重ねた層である
function isMirror(settings: Settings): boolean {
  for (let scope: Settings | undefined = settings; scope !== undefined; scope = scope.overlayParent?.()) {
    if (scope.isMirror === true) return true;
  }
  return false;
}

// 同じディレクトリの別名（macOS の /tmp と /private/tmp、~ など）を同じとみなすための形
function real(path: string): string {
  const expanded = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
  try {
    return realpathSync(expanded);
  } catch {
    return resolve(expanded);
  }
}

// まだ無いパスでも、在る祖先まで別名を解いた形
function realAncestor(path: string): string {
  for (let at = path, rest = ""; ; ) {
    try {
      return join(realpathSync(at), rest);
    } catch {
      if (dirname(at) === at) return path;
      rest = join(basename(at), rest);
      at = dirname(at);
    }
  }
}

// macOS のファイルシステムは既定で大文字と小文字を区別しないので、比べるときは小文字にそろえる
function fold(path: string): string {
  return process.platform === "darwin" ? path.toLowerCase() : path;
}

// OMP の bash.patterns と同じく、前後の空白を除き、空白の並びを1つにする
function collapse(match: string): string {
  return match.trim().replace(/\s+/gu, " ");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function report(ctx: ExtensionContext, message: string, type: "info" | "error"): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
  else process.stderr.write(`${message}\n`);
}
