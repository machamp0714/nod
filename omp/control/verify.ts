// pstack-omp の組（写し）の検証。専用ランチャー（写しの bin/omp）が omp を起動する前に実行する preflight.ts と、制御の拡張（index.ts）が
// 同じものを使う。組の記録の形と写しの照合は、適用（scripts/pstack-omp/harness.ts）と状態の表示（status.ts）も使う。
// OMP のモジュールには依存しない（preflight.ts は OMP の外で動くため）。
//
// 検証すること（どれかが通らなければ理由を返す）:
// - 組の記録（control/harness.json）が読め、形が正しい
// - 写しが記録と一致する（copyProblems）: 記録の control が写しの control で、content と生成したスキルの置き場が写しの中に在り、
//   files に規則・専用ランチャー・サンドボックスのプロファイル・設定の重ね・制御の拡張・preflight.ts が入り、写しの全ファイル（harness.json を除く）が
//   記録の sha256 と一致し、記録に無いファイルが無い
// - 規則（control/rules.json）の形が正しい
// - いまの OMP の設定の置き場（ompAgentDir。環境変数と omp の引数で OMP と同じく決める）の実パスが、記録の agentDir と同じ。
//   名前つきの profile や ~/.omp でない設定の根（PI_CONFIG_DIR）なら、守る集合が実際の置き場に当たるかを決められないので通さない
// - 写しのサンドボックスのプロファイル（control/sandbox.sb）が、いま解決した守る集合から作るもの（rules.ts の sandboxProfile）と同じ
//   （適用の後に守る置き場やその途中のリンクの実体が変わると、プロファイルはその実体を覆わない）
// - 写しの設定の重ね（control/bash-patterns.yml。専用ランチャーが omp に --config で渡す）が、いまの規則と置き場から作るもの
//   （rules.ts の bashOverlay。bash.patterns に規則の deny）と同じ（読めない・違えば、規則の bash の拒否が効くかを決められない）
// - このプロセスが、守る集合と、作業ディレクトリ（どれも）とその祖先（ファイルシステムの根まで）のどのプロジェクトでも書かせないパスと、
//   それらのディレクトリの下（何段下でも）のリンクの参照先に書けない（サンドボックスに閉じ込められている。writable）
// 適用の時刻では何も省かない（どのプロセスでも、組を検証してから使う）。
import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  type Stats,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { bashOverlay, type Guard, guarded, type Guarded, isRecord, parseRules, type Places, realAncestor, resolvePlaces, type Rules, sandboxProfile } from "./rules";

// 写しの根からの、組の記録・規則・専用ランチャー・サンドボックスのプロファイル・設定の重ね・制御の拡張・組の検証の入口
export const HARNESS_FILE = "control/harness.json";
export const RULES_FILE = "control/rules.json";
export const LAUNCHER_FILE = "bin/omp";
export const PROFILE_FILE = "control/sandbox.sb";
export const OVERLAY_FILE = "control/bash-patterns.yml";
export const CONTROL_ENTRY = "control/index.ts";
export const PREFLIGHT_ENTRY = "control/preflight.ts";
// 組の記録の files に必ず入るファイル（無ければ、写しから消しても記録との照合で気づけない）
const REQUIRED = [RULES_FILE, LAUNCHER_FILE, PROFILE_FILE, OVERLAY_FILE, CONTROL_ENTRY, PREFLIGHT_ENTRY];

// 組の記録（写しの control/harness.json）。適用（harness.ts）が書く
export interface Harness {
  version: 2;
  // 適用した時刻（ISO 8601。表示だけに使う）
  appliedAt: string;
  // 元にした固定の記録と、適用したときの OMP の版
  pin: { repository: string; commit: string; pstackVersion: string; ompVersion: string };
  ompVersion: string;
  // 写しの中の OMP 向けのディレクトリと制御の拡張
  content: string;
  control: string;
  // 適用した OMP の設定の置き場（規則の {agentDir}）
  agentDir: string;
  // 専用ランチャーがサンドボックスの中で起動する omp の実行ファイルの実パス（規則の {ompBin}）
  ompBin: string;
  // 専用ランチャーが組の検証（preflight.ts）を実行する bun の実行ファイルの実パス（規則の {bunBin}）
  bunBin: string;
  // skills.customDirectories の先頭に入れるスキルの置き場（写しの中の生成した pstack と cursor-team-kit）
  skillDirectories: string[];
  // 一覧から外すスキル（生成した全スキルと、OMP 向けのディレクトリのスキル）
  manualSkills: string[];
  // 写しの根からの相対パス → sha256（harness.json を除く写しの全ファイル）
  files: Record<string, string>;
}

// 検証した組と規則。fault は通らなかった理由と、それが閉じ込めの失敗（confinement）か
export type Verdict =
  | { kind: "ok"; harness: Harness; rules: Rules; harnessSha: string; places: Places; guard: Guarded }
  | { kind: "blocked"; reason: string; confinement: boolean };

// 写しの control（controlDir）の組を検証する。cwds はどのプロジェクトでも書かせないパスを試す作業ディレクトリ（実パス。どれもその祖先でも試す）、
// args は omp に渡す引数（--profile で設定の置き場を決める。制御の拡張は引数を知らないので空）、env は設定の置き場を決める環境変数
export function verify(controlDir: string, cwds: string[], args: readonly string[] = [], env: Record<string, string | undefined> = process.env): Verdict {
  const root = dirname(controlDir);
  const refuse = (reason: string, confinement = false): Verdict => ({ kind: "blocked", reason, confinement });
  const path = join(root, HARNESS_FILE);
  let bytes: Buffer;
  let raw: unknown;
  try {
    bytes = readFileSync(path);
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (e) {
    return refuse(`組の記録 ${path} を読めません: ${(e as Error).message}`);
  }
  const harness = parseHarness(raw);
  if (typeof harness === "string") return refuse(`組の記録 ${path} の形が正しくありません: ${harness}`);
  const problems = copyProblems(root, harness);
  if (problems.length > 0) return refuse(`写し（${root}）が組の記録と違います: ${problems.join("。")}`);
  const rules = readRules(join(root, RULES_FILE));
  if (typeof rules === "string") return refuse(`規則 ${join(root, RULES_FILE)} が正しくありません: ${rules}`);
  const current = ompAgentDir(env, args);
  if (typeof current === "string") return refuse(`OMP の設定の置き場を決められません: ${current}`);
  if (realAncestor(harness.agentDir) !== current.path) {
    return refuse(`組は OMP の設定の置き場 ${harness.agentDir} に適用したもので、いまの置き場（${current.path}。${current.source}）と違います`);
  }
  const places: Places = { agentDir: harness.agentDir, workDir: realAncestor(dirname(root)), ompBin: harness.ompBin, bunBin: harness.bunBin, home: homedir() };
  const guard = guarded(rules, places);
  // 写しのプロファイルが、いまの守る集合から作るものと同じときだけ、プロファイルが守る置き場を下まで覆うとみなせる（writable の覆う置き場）
  const profilePath = join(root, PROFILE_FILE);
  let written: string;
  try {
    written = readFileSync(profilePath, "utf8");
  } catch (e) {
    return refuse(`サンドボックスのプロファイル ${profilePath} を読めません: ${(e as Error).message}`);
  }
  const expected = sandboxProfile(guard);
  if (written !== expected) {
    const only = (a: string, b: string) => {
      const lines = a.split("\n").filter((line) => line !== "" && !b.split("\n").includes(line));
      return lines.length === 0 ? "なし" : lines.join(" ");
    };
    return refuse(
      `写しのサンドボックスのプロファイル ${profilePath} が、いまの守る集合から作るものと違います（適用の後に、守る置き場かその途中のリンクの実体が変わり、` +
        `プロファイルがいまの実体を覆いません。プロファイルにだけある規則: ${only(written, expected)}。いまの守る集合にだけある規則: ${only(expected, written)}）。apply し直してください`,
    );
  }
  const overlayPath = join(root, OVERLAY_FILE);
  let overlay: string;
  try {
    overlay = readFileSync(overlayPath, "utf8");
  } catch (e) {
    return refuse(`写しの設定の重ね ${overlayPath} を読めません: ${(e as Error).message}`);
  }
  if (overlay !== bashOverlay(rules, places)) {
    return refuse(`写しの設定の重ね ${overlayPath} が、いまの規則と置き場から作るものと違います（bash.patterns の先頭に入れる規則の bash の拒否が違う）。apply し直してください`);
  }
  // 規則の allowPaths の、書いたままの形（親までの実パスと最後の要素。最後の要素のリンクは解かない）
  const allowed = rules.allowPaths.map((entry) => {
    const path = resolvePlaces(entry.replace(/\/+$/u, ""), places);
    return { path: join(realAncestor(dirname(path)), basename(path)), directory: entry.endsWith("/") };
  });
  const open = writable(guard, cwds, allowed);
  if (open.length > 0) return refuse(`サンドボックスに閉じ込められていません（このプロセスから書けてしまう置き場: ${open.join(", ")}）`, true);
  return { kind: "ok", harness, rules, harnessSha: sha256(bytes), places, guard };
}

// 規則のファイル。無い・読めない・不正なら理由
export function readRules(path: string): Rules | string {
  try {
    return parseRules(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    return `読めません: ${(e as Error).message}`;
  }
}

// OMP の名前つきの profile の名前の形（これに合わない名前は、OMP がどう扱うかを固定版の契約から決められない）
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]*$/u;

// いまの OMP の設定の置き場の実パスと、それを決めた環境変数や引数（source）。OMP 19.1.0 の契約（Document 1683 の論点 12、settings.md、
// config-usage.md）から決まる範囲だけで決め、決められなければ理由を返す。args は omp に渡す引数（分からなければ空）。
// - PI_CONFIG_DIR が空でも .omp でもなければ決めない（OMP の設定の根が ~/.omp から変わり、規則の守る集合 {home}/.omp/plugins/・
//   {home}/.omp/agents/ と allowPaths {home}/.omp/ が実際の根に当たるかを確かめられない）。
// - profile は、引数の --profile <値>・--profile=<値>（複数あれば同じ値でなければならず、値が無ければ決めない）、無ければ定義された
//   （空でも）OMP_PROFILE、無ければ PI_PROFILE で選ぶ。空・空白だけ・default は既定の profile。ほかは名前つきの profile で、決めない
//   （名前つきの profile は OMP の利用者の根を移すが、agent の外の plugins・agents などの置き場を契約から決められず、守れない）。
// - 既定の profile では、空でない PI_CODING_AGENT_DIR（OMP と同じく resolve する）、無ければ ~/.omp/agent。ただし、引数の --profile で
//   既定を選び、環境変数が名前つきの profile を選んでいれば決めない（切り替えの戻し方が契約に無い）。PI_PROFILE が名前つきの P なら、
//   P が名前の形に合わなければ決めず、PI_CODING_AGENT_DIR が ~/.omp/profiles/P/agent と同じなら、profile から引き継いだ値として使わない。
export function ompAgentDir(env: Record<string, string | undefined>, args: readonly string[]): { path: string; source: string } | string {
  const home = homedir();
  const root = env.PI_CONFIG_DIR;
  if (root !== undefined && root !== "" && root !== ".omp") {
    return `環境変数 PI_CONFIG_DIR（${root}）で OMP の設定の根が ~/.omp から変わっています。規則の守る集合と allowPaths（~/.omp の下）が実際の設定の根に当たるかを確かめられず、守れません`;
  }
  const flags = flagValues(args, "--profile");
  if (typeof flags === "string") return flags;
  if (new Set(flags).size > 1) return `引数 --profile が複数あり、値が違います（${flags.map((flag) => JSON.stringify(flag)).join(", ")}）`;
  const named = (value: string) => value.trim() !== "" && value !== "default";
  const variable = env.OMP_PROFILE !== undefined ? "OMP_PROFILE" : env.PI_PROFILE !== undefined ? "PI_PROFILE" : undefined;
  const chosen = variable === undefined ? undefined : env[variable]!;
  const selected = flags.length > 0 ? { source: `引数 --profile ${flags[0]}`, value: flags[0]! } : chosen === undefined ? undefined : { source: `環境変数 ${variable}`, value: chosen };
  if (selected !== undefined && named(selected.value)) {
    return `${selected.source} で名前つきの profile（${selected.value}）が選ばれています。名前つきの profile では、OMP の利用者の根の plugins・agents などの置き場を固定版の契約から決められず、守れません`;
  }
  if (flags.length > 0 && chosen !== undefined && named(chosen)) {
    return `引数 --profile ${flags[0]} で既定の profile を選んでいますが、環境変数 ${variable} が名前つきの profile（${chosen}）を選んでいます。既定へ切り替えたときの置き場を固定版の契約から決められません`;
  }
  const override = env.PI_CODING_AGENT_DIR;
  if (!override) return { path: realAncestor(join(home, ".omp", "agent")), source: "既定の置き場 ~/.omp/agent（PI_CODING_AGENT_DIR が無い）" };
  const legacy = env.PI_PROFILE;
  if (legacy !== undefined && named(legacy)) {
    if (!PROFILE_NAME.test(legacy)) {
      return `環境変数 PI_PROFILE（${legacy}）が置き場を決められない profile の名前なので、PI_CODING_AGENT_DIR（${override}）がその profile から引き継いだ値かを確かめられません`;
    }
    if (override === join(home, ".omp", "profiles", legacy, "agent")) {
      return { path: realAncestor(join(home, ".omp", "agent")), source: `既定の置き場 ~/.omp/agent（PI_CODING_AGENT_DIR は PI_PROFILE の profile（${legacy}）から引き継いだ値なので使わない）` };
    }
  }
  return { path: realAncestor(resolve(override)), source: "環境変数 PI_CODING_AGENT_DIR" };
}

// omp を起動する作業ディレクトリ（実パス）: 呼んだディレクトリ cwd（実パス）と、omp の引数の --cwd <値>・--cwd=<値> の全部の値
// （cwd を基準に解いた実パス）。どれが使われても試しから漏れないように全部を返す。値が無い・在るディレクトリでなければ理由
export function launchDirs(cwd: string, args: readonly string[]): string[] | string {
  const values = flagValues(args, "--cwd");
  if (typeof values === "string") return values;
  const dirs = [cwd];
  for (const value of values) {
    if (value === "") return "引数 --cwd の値が空です";
    const dir = resolve(cwd, value);
    if (!isDirectory(dir)) return `引数 --cwd の ${value}（${dir}）が在るディレクトリではありません`;
    dirs.push(real(dir));
  }
  return [...new Set(dirs)];
}

// 引数の name <値>・name=<値> の全部の値。name の後に値が無ければ理由
function flagValues(args: readonly string[], name: string): string[] | string {
  const values: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    if (arg === name) {
      if (at + 1 === args.length) return `引数 ${name} に値がありません`;
      at += 1;
      values.push(args[at]!);
    } else if (arg.startsWith(`${name}=`)) {
      values.push(arg.slice(name.length + 1));
    }
  }
  return values;
}

// 形が正しければ記録を、正しくなければ理由を返す
export function parseHarness(raw: unknown): Harness | string {
  if (!isRecord(raw)) return "オブジェクトではありません";
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x !== "");
  if (raw.version !== 2) return `version が 2 ではありません: ${String(raw.version)}`;
  if (typeof raw.appliedAt !== "string" || Number.isNaN(Date.parse(raw.appliedAt))) return "appliedAt が時刻ではありません";
  const pin = raw.pin;
  if (!isRecord(pin) || !["repository", "commit", "pstackVersion", "ompVersion"].every((key) => typeof pin[key] === "string")) return "pin がありません";
  if (typeof raw.ompVersion !== "string") return "ompVersion がありません";
  for (const key of ["content", "control", "agentDir", "ompBin", "bunBin"] as const) {
    const value = raw[key];
    if (typeof value !== "string" || !isAbsolute(value)) return `${key} が絶対パスではありません`;
  }
  if (!strings(raw.skillDirectories) || raw.skillDirectories.length === 0 || !raw.skillDirectories.every((dir) => isAbsolute(dir))) {
    return "skillDirectories が絶対パスの配列ではありません";
  }
  if (!strings(raw.manualSkills) || raw.manualSkills.length === 0) return "manualSkills が名前の配列ではありません";
  const files = raw.files;
  if (!isRecord(files) || Object.keys(files).length === 0) return "files がありません";
  for (const [rel, sha] of Object.entries(files)) {
    if (isAbsolute(rel) || normalize(rel).startsWith("..") || typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) {
      return `files の項目 ${rel} が写しの中の相対パスと sha256 ではありません`;
    }
  }
  return raw as unknown as Harness;
}

// 写しが組の記録と違うところ（一致すれば空）。読めないファイルやディレクトリも違うところとして返す（例外にしない）
export function copyProblems(root: string, harness: Harness): string[] {
  const problems: string[] = [];
  const realRoot = real(root);
  const control = join(root, "control");
  if (real(harness.control) !== real(control)) problems.push(`組の記録の control（${harness.control}）が写しの ${control} と違います`);
  for (const dir of [harness.content, ...harness.skillDirectories]) {
    // 読み込む中身は写しの中だけ（各ファイルを files の sha256 で確かめる）
    if (!within(real(dir), realRoot)) problems.push(`組の記録が指すディレクトリ ${dir} が写し（${root}）の外です`);
    else if (!isDirectory(dir)) problems.push(`組の記録が指すディレクトリ ${dir} がありません`);
  }
  for (const rel of REQUIRED) if (!(rel in harness.files)) problems.push(`組の記録の files に ${rel} がありません`);
  const actual = scan(root, true);
  const recorded = harness.files;
  const files = [
    ...Object.keys(recorded)
      .filter((rel) => !(rel in actual))
      .map((rel) => `${rel}（無い）`),
    ...Object.keys(actual)
      .filter((rel) => !(rel in recorded) && actual[rel] !== null)
      .map((rel) => `${rel}（記録に無い）`),
    ...Object.keys(actual)
      .filter((rel) => actual[rel] === null)
      .map((rel) => `${rel}（読めない）`),
    ...Object.keys(recorded)
      .filter((rel) => typeof actual[rel] === "string" && actual[rel] !== recorded[rel])
      .map((rel) => `${rel}（sha256 が違う）`),
  ];
  if (files.length > 0) problems.push(`組のファイルが記録と違います: ${files.join(", ")}`);
  return problems;
}

// 写しの全ファイル（harness.json を除く）の、根からの相対パス → sha256。読めなければ例外（適用が組の記録を作るときに使う）
export function hashFiles(root: string): Record<string, string> {
  return scan(root, false) as Record<string, string>;
}

// 写しの全ファイル（harness.json を除く）の、根からの相対パス → sha256。tolerant なら、読めないファイルとディレクトリを null にする
function scan(root: string, tolerant: boolean): Record<string, string | null> {
  const files: Record<string, string | null> = {};
  const visit = (rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(join(root, rel)).sort();
    } catch (e) {
      if (!tolerant || rel === "") throw e;
      files[rel] = null;
      return;
    }
    for (const name of names) {
      const path = rel === "" ? name : `${rel}/${name}`;
      try {
        if (lstatSync(join(root, path)).isDirectory()) visit(path);
        else if (path !== HARNESS_FILE) files[path] = sha256(readFileSync(join(root, path)));
      } catch (e) {
        if (!tolerant) throw e;
        files[path] = null;
      }
    }
  };
  try {
    visit("");
  } catch (e) {
    if (!tolerant) throw e;
  }
  return files;
}

// 根の外の木（守る置き場の下のリンクの参照先の下）で調べる項目の数の上限。超えたら確かめきれないので書けるとみなす
const OUTSIDE_LIMIT = 10_000;

// 守る集合と、どのプロジェクトでも書かせないパスのうち、このプロセスが書けてしまう置き場（閉じ込められていれば空）。
// FFI は使わず、拒否されるかを試す。
// - 祖先は、同じ mode への chmod。EPERM（サンドボックスの拒否）か EROFS（読み取り専用のボリューム）で失敗しなければ書けるとみなす。
// - 在るファイルは、同じ mode への chmod が拒否されても、それだけでは書けないとみなさない（他の利用者の持ち物は、グループの書き込みビットや
//   ACL で書けても、chmod は所有者にしか許されず EPERM になる）。chmod が拒否されたら access(2) の W_OK を試し、EPERM・EROFS
//   （Seatbelt は access の W_OK にも書き込みの拒否を当てる）か EACCES（この利用者に書き込みの権限が無い）なら書けない、ほかの失敗と成功は
//   書けるとみなす（access は実の uid で判定するが、ランチャーは setuid しないので、このプロセスの uid と同じ）。
//   在るファイルを書き込みで開いては試さない（macOS では、実行中の実行ファイル（守る集合の omp と bun）を書き込みで開くと、
//   書かなくても以後の起動がコード署名で止められる）。
// - 在るディレクトリは、同じ mode への chmod と、その中への mkdir（作れたら消す）。chmod は EPERM か EROFS で失敗しなければ書けるとみなす。
// - 無いパス（祖先を除く）は、親が在れば作ってみる（ディレクトリは mkdir、ファイルは O_CREAT|O_EXCL で開く）。親が無ければ試さない。
// - 作成（無いパスと在るディレクトリの中の mkdir）は、拒否され、無いままなら書けない。作れてしまったら、作ったものだけを消して
//   （ディレクトリは rmdir、ファイルは unlink。再帰では消さないので、その間に別のプロセスが中に書いたものは消さない）書けるとみなす。
//   拒否は EPERM、EROFS、親が他の利用者の持ち物のときの EACCES（この利用者は権限を戻せない）、親が自分の持ち物で所有者の書き込みビットが
//   立つときの EACCES（mode は許すので、拒否はサンドボックスによる）。ほかの失敗（同じ利用者が書き込みの権限を外した自分の持ち物の親の
//   EACCES は、同じ利用者の chmod で戻せる）は書けるとみなす。
// - どのプロジェクトでも書かせないパスは、作業ディレクトリ（cwds、実パス。どれも）とその祖先（ファイルシステムの根まで）の下で試す
//   （OMP の task のエージェント定義の探索は、作業ディレクトリから根まで遡って最も近い .omp/agents をプロジェクトの定義として読む。
//   プロファイルはどのディレクトリの下でも拒否するが、実体が別の場所にあるリンクは実パスで照合されて拒否されないので、試して見つける）。
//   ただし書いたままのパス（祖先の実パスと相対パス。途中と最後の要素のリンクは解かない）が規則の allowPaths の書いたままの形の下に
//   入るもの（ホームを作業ディレクトリにしたときの ~/.omp など）は、プロファイルでもその照合から外れ、守る集合に入る部分
//   （~/.omp/agents など）は守る集合として試すので、ここでは試さない。リンクの先だけが allowPaths の下に入るもの（~/.omp の下へのリンクの
//   プロジェクトの .omp など）は、プロファイルが許してしまうので試す。さらに親の無いパス（.claude の無いリポジトリの .claude/settings.json など）も試すため、
//   一時ディレクトリの下の自分の乱数名の作業用ディレクトリで、守られていない親を1段ずつ作ってから作成を試す（利用者のリポジトリには作らない）。
//   終わったら、自分が作った親（mkdir が EEXIST なら自分のものではないので記録しない）を逆順に rmdir し、最後に作業用ディレクトリを rmdir する
//   （再帰では消さないので、その間に別のプロセスが中に書いたものは消さずに残す）。作れない・消せないときは確かめられないので書けるとみなす。
//   作業用ディレクトリで書けたら、どの作業ディレクトリの下の同じ相対パスも書けてしまう置き場として出す（プロファイルはどのディレクトリの下でも当てる）。
// - 上で書けなかった、在るディレクトリの守る置き場（守る集合のディレクトリと、試したどのプロジェクトでも書かせないパスのディレクトリ）の下は、
//   何段下でも歩いてシンボリックリンクを探す（.omp/agents や .omp/agents/poteto-agent.md が閉じ込めの外を指すリンクなら、Seatbelt は
//   実パスで照合するので、その先には拒否が当たらない）。書いたままのパスが実パスの置き場は、プロファイルが下まで覆うので（覆う置き場。
//   写しのプロファイルが、いまの守る集合から作るものと同じことを verify が先に確かめている）、
//   その中のファイルとディレクトリは試さず、参照先が覆う置き場のどれかの中のリンクも試さない。ほかのリンクは参照先を上と同じに試し、
//   書けたらリンクのパス（と参照先）を出す。参照先が書けないディレクトリなら、その下（根の外の木）も歩き、ファイル・ディレクトリ・リンクを
//   1つずつ試す（書けたものは出し、その下へは降りない）。書いたままのパスがリンクを通る守る置き場も、根の外の木として歩く。
//   歩いたディレクトリの実パスは二度歩かない（参照先から元へ戻るリンク、自分自身や互いを指すリンクでも終わる）。根の外の木で調べた項目が
//   OUTSIDE_LIMIT を超えたら、確かめきれないので書けるとみなす（覆う置き場の中の歩きには上限を置かない）。
//   OS が参照先を解決できないリンク（参照先が無い、循環する、たどる権限が無いなど。realpath(3) の失敗）は、参照先を自前で解いたり
//   作ってみたりせず、どこを指していても確かめられないとして書けるとみなす（このリンクと、守る置き場そのものやその途中の要素
//   （.claude/settings.json の .claude など）の解決できないリンクも同じ。守る置き場そのものやその途中の要素が在るかを、無い（ENOENT・
//   ENOTDIR）以外の失敗で確かめられないときも同じ）。読めないディレクトリやリンクも、確かめられないので書けるとみなす。
//   歩いている間に消えたものは飛ばす。
function writable({ paths, ancestors, projects }: Guarded, cwds: string[], allowed: Guard[]): string[] {
  const uid = process.getuid?.();
  // attempt が拒否されたか。permission なら、この利用者に権限が無いこと（EACCES）も拒否とみなす
  const denied = (attempt: () => void, permission = false): boolean => {
    try {
      attempt();
      return false;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === "EPERM" || code === "EROFS" || (permission && code === "EACCES");
    }
  };
  // 親 parent の下への作成の失敗 e が、サンドボックスの拒否か、この利用者が権限を戻せない失敗か
  const refused = (e: unknown, parent: string): boolean => {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EROFS") return true;
    if (code !== "EACCES") return false;
    try {
      const stat = statSync(parent);
      return stat.uid !== uid || (stat.mode & 0o200) !== 0;
    } catch {
      return false;
    }
  };
  const create = (path: string, directory: boolean): boolean => {
    const parent = dirname(path);
    if (!existsSync(parent)) return false;
    try {
      if (directory) mkdirSync(path);
      else closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
    } catch (e) {
      return !(refused(e, parent) && !existsSync(path));
    }
    try {
      if (directory) rmdirSync(path);
      else unlinkSync(path);
    } catch {
      // 消せなくても（中に別のプロセスが書いたなど）、書けたことに変わりはない
    }
    return true;
  };
  const probe = (path: string, directory: boolean, ancestor = false): boolean => {
    let stat: Stats;
    try {
      stat = statSync(path);
    } catch (e) {
      return !ancestor && (e as NodeJS.ErrnoException).code === "ENOENT" && create(path, directory);
    }
    const chmod = () => chmodSync(path, stat.mode & 0o7777);
    if (ancestor) return !denied(chmod);
    if (!stat.isDirectory()) return !denied(chmod) || !denied(() => accessSync(path, constants.W_OK), true);
    return !denied(chmod) || create(join(path, `.pstack-omp-probe-${randomBytes(6).toString("hex")}`), true);
  };
  // OS が参照先を解決できないリンク link（error は realpath の失敗）を、確かめられない置き場として出す形
  const unresolvable = (link: string, error: unknown) => `${link}（確かめられません: 参照先を解決できません（${(error as Error).message}））`;
  // path の途中か最後の要素のうち、OS が参照先を解決できない最初のリンクか、在るかを確かめられない要素（どちらも無ければ undefined）。
  // 要素が無い（ENOENT）か、途中がディレクトリでない（ENOTDIR）なら、その先は無いので見ない
  const broken = (path: string): string | undefined => {
    for (let at = "/", rest = path.split("/").filter(Boolean); rest.length > 0; ) {
      at = join(at, rest.shift()!);
      try {
        if (!lstatSync(at).isSymbolicLink()) continue;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return undefined;
        return `${at}（確かめられません: パスを解決できません（${(e as Error).message}））`;
      }
      try {
        realpathSync.native(at);
      } catch (e) {
        return unresolvable(at, e);
      }
    }
    return undefined;
  };
  const scratch = (): string[] => {
    let work: string;
    try {
      work = mkdtempSync(join(tmpdir(), "pstack-omp-probe-"));
    } catch (e) {
      return [`${tmpdir()}（試しの作業用ディレクトリを作れません: ${(e as Error).message}）`];
    }
    const open: string[] = [];
    const everywhere = (path: string) => open.push(...cwds.map((cwd) => join(cwd, path)));
    // 自分が作った親（作った順）
    const made: string[] = [];
    try {
      for (const { path, directory } of projects) {
        let parent = work;
        let ready = true;
        for (const name of dirname(path).split("/").filter((name) => name !== ".")) {
          parent = join(parent, name);
          try {
            mkdirSync(parent);
            made.push(parent);
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === "EEXIST") continue;
            // 親も拒否されるなら、その下は作れない
            if (code !== "EPERM") everywhere(path);
            ready = false;
            break;
          }
        }
        if (ready && create(join(work, path), directory)) everywhere(path);
      }
    } finally {
      for (const dir of [...made.reverse(), work]) {
        try {
          rmdirSync(dir);
        } catch (e) {
          open.push(`${dir}（試しの作業用ディレクトリを消せません: ${(e as Error).message}）`);
        }
      }
    }
    return open;
  };
  // 書けなかった、在るディレクトリの守る置き場（roots）の下のリンクのうち、参照先に書けてしまうもの
  const beneath = (roots: string[]): string[] => {
    const found: string[] = [];
    const unsure = (path: string, why: string) => found.push(`${path}（確かめられません: ${why}）`);
    const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
    const covered = roots.filter((root) => real(root) === root);
    const covers = (path: string) => covered.some((root) => within(path, root));
    const walked = new Set<string>();
    // 歩くディレクトリ（dir は辿ってきたパス、at はその実パス、inside は覆う置き場の中か）
    const pending: { dir: string; at: string; inside: boolean }[] = [];
    const enter = (dir: string, at: string, inside: boolean) => {
      if (walked.has(at)) return;
      walked.add(at);
      pending.push({ dir, at, inside });
    };
    // リンク link の参照先を試し、書けないディレクトリなら根の外の木として歩く
    const follow = (link: string) => {
      let target: string;
      try {
        target = realpathSync.native(link);
      } catch (e) {
        found.push(unresolvable(link, e));
        return;
      }
      if (covers(target)) return;
      if (probe(target, true)) found.push(`${link}（参照先 ${target}）`);
      else if (isDirectory(target)) enter(link, target, false);
    };
    for (const root of roots) {
      const at = real(root);
      if (at === root) enter(root, at, true);
      else if (!covers(at)) enter(root, at, false);
    }
    let budget = OUTSIDE_LIMIT;
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const { dir, at, inside } = next;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch (e) {
        if (!missing(e)) unsure(dir, `中を読めません（${(e as Error).message}）`);
        continue;
      }
      for (const name of names) {
        const path = join(dir, name);
        const sub = join(at, name);
        if (!inside) {
          if (covers(sub)) continue;
          budget -= 1;
          if (budget < 0) {
            found.push(`${dir}（確かめきれません: リンクの参照先の下の項目が ${OUTSIDE_LIMIT} を超えます）`);
            return found;
          }
        }
        let stat: Stats;
        try {
          stat = lstatSync(path);
        } catch (e) {
          if (!missing(e)) unsure(path, (e as Error).message);
          continue;
        }
        if (stat.isSymbolicLink()) follow(path);
        else if (inside) {
          if (stat.isDirectory()) enter(path, sub, true);
        } else if (probe(path, stat.isDirectory())) found.push(path);
        else if (stat.isDirectory()) enter(path, sub, false);
      }
    }
    return found;
  };
  const open: string[] = [];
  // 書けなかった、在るディレクトリの守る置き場（下を歩く）
  const roots: string[] = [];
  const check = ({ path, directory }: Guard) => {
    const link = broken(path);
    if (link !== undefined) open.push(link);
    else if (probe(path, directory)) open.push(path);
    else if (directory && isDirectory(path)) roots.push(path);
  };
  for (const guard of paths) check(guard);
  open.push(...ancestors.filter((path) => probe(path, true, true)));
  // 作業ディレクトリ（どれも）とその祖先（ファイルシステムの根まで）
  const dirs = new Set<string>();
  for (const cwd of cwds) {
    for (let at = cwd; ; at = dirname(at)) {
      dirs.add(at);
      if (dirname(at) === at) break;
    }
  }
  for (const dir of dirs) {
    for (const { path, directory } of projects) {
      const at = join(dir, path);
      // 書いたままのパスが規則の allowPaths の下なら、プロファイルでもどのプロジェクトでも書かせないパスの照合から外れる
      if (!allowed.some((allow) => (allow.directory ? within(at, allow.path) : at === allow.path))) check({ path: at, directory });
    }
  }
  open.push(...beneath(roots), ...scratch());
  return [...new Set(open)];
}

// 同じディレクトリの別名（macOS の /tmp と /private/tmp、~ など）を同じとみなすための形（OS の realpath(3) で解く）
export function real(path: string): string {
  const expanded = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
  try {
    return realpathSync.native(expanded);
  } catch {
    return resolve(expanded);
  }
}

// path（実パス）が dir（実パス）そのものか、その下か
function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
