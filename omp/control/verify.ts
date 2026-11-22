// pstack-omp の組（写し）の検証。専用ランチャー（写しの bin/omp）が omp を起動する前に実行する preflight.ts と、制御の拡張（index.ts）が
// 同じものを使う。組の記録の形と写しの照合は、適用（scripts/pstack-omp/harness.ts）と状態の表示（status.ts）も使う。
// OMP のモジュールには依存しない（preflight.ts は OMP の外で動くため）。
//
// 検証すること（どれかが通らなければ理由を返す）:
// - 組の記録（control/harness.json）が読め、形が正しい
// - 写しが記録と一致する（copyProblems）: 記録の control が写しの control で、content と生成したスキルの置き場が写しの中に在り、
//   files に規則・専用ランチャー・サンドボックスのプロファイル・制御の拡張・preflight.ts が入り、写しの全ファイル（harness.json を除く）が
//   記録の sha256 と一致し、記録に無いファイルが無い
// - 規則（control/rules.json）の形が正しい
// - いまの OMP の設定の置き場（PI_CODING_AGENT_DIR。無ければ ~/.omp/agent）の実パスが、記録の agentDir と同じ
// - このプロセスが、守る集合とどのプロジェクトでも書かせないパスに書けない（サンドボックスに閉じ込められている。writable）
// 適用の時刻では何も省かない（どのプロセスでも、組を検証してから使う）。
import { createHash, randomBytes } from "node:crypto";
import {
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
  rmSync,
  type Stats,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { guarded, type Guarded, isRecord, parseRules, type Places, realAncestor, type Rules } from "./rules";

// 写しの根からの、組の記録・規則・専用ランチャー・サンドボックスのプロファイル・制御の拡張・組の検証の入口
export const HARNESS_FILE = "control/harness.json";
export const RULES_FILE = "control/rules.json";
export const LAUNCHER_FILE = "bin/omp";
export const PROFILE_FILE = "control/sandbox.sb";
export const CONTROL_ENTRY = "control/index.ts";
export const PREFLIGHT_ENTRY = "control/preflight.ts";
// 組の記録の files に必ず入るファイル（無ければ、写しから消しても記録との照合で気づけない）
const REQUIRED = [RULES_FILE, LAUNCHER_FILE, PROFILE_FILE, CONTROL_ENTRY, PREFLIGHT_ENTRY];

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

// 写しの control（controlDir）の組を検証する。cwd はどのプロジェクトでも書かせないパスを試す作業ディレクトリ（実パス）
export function verify(controlDir: string, cwd: string, env: Record<string, string | undefined> = process.env): Verdict {
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
  const agentDir = currentAgentDir(env);
  if (realAncestor(harness.agentDir) !== agentDir) {
    return refuse(`組は OMP の設定の置き場 ${harness.agentDir} に適用したもので、いまの置き場（${agentDir}。PI_CODING_AGENT_DIR）と違います`);
  }
  const places: Places = { agentDir: harness.agentDir, workDir: realAncestor(dirname(root)), ompBin: harness.ompBin, bunBin: harness.bunBin, home: homedir() };
  const guard = guarded(rules, places);
  const open = writable(guard, cwd);
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

// いまの OMP の設定の置き場の実パス（OMP と同じく PI_CODING_AGENT_DIR、無ければ ~/.omp/agent）
export function currentAgentDir(env: Record<string, string | undefined>): string {
  return realAncestor(resolve(env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent")));
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

// 守る集合と、どのプロジェクトでも書かせないパスのうち、このプロセスが書けてしまう置き場（閉じ込められていれば空）。
// FFI は使わず、拒否されるかを試す。
// - 在るファイルと祖先は、同じ mode への chmod。在るディレクトリは、同じ mode への chmod と、その中への mkdir（作れたら消す）。
//   chmod は EPERM（サンドボックスの拒否）で失敗しなければ書けるとみなす。在るファイルを書き込みで開いては試さない
//   （macOS では、実行中の実行ファイル（守る集合の omp と bun）を書き込みで開くと、書かなくても以後の起動がコード署名で止められる）。
// - 無いパス（祖先を除く）は、親が在れば作ってみる（ディレクトリは mkdir、ファイルは O_CREAT|O_EXCL で開く）。親が無ければ試さない。
// - 作成（無いパスと在るディレクトリの中の mkdir）は、拒否され、無いままなら書けない。作れてしまったら、作ったものだけを消して
//   （ディレクトリは rmdir、ファイルは unlink。再帰では消さないので、その間に別のプロセスが中に書いたものは消さない）書けるとみなす。
//   拒否は EPERM か、親が自分の持ち物で所有者の書き込みビットが立つときの EACCES（mode は許すので、拒否はサンドボックスによる）だけ。
//   ほかの失敗（同じ利用者が書き込みの権限を外した親の EACCES は、同じ利用者の chmod で戻せる）は書けるとみなす。
// - どのプロジェクトでも書かせないパスは、作業ディレクトリ（cwd、実パス）の下で試す。ただし規則の allowPaths の下に入るもの
//   （ホームを作業ディレクトリにしたときの ~/.omp など）は、プロファイルでもその照合から外れ、守る集合に入る部分は守る集合として
//   試すので、ここでは試さない。さらに親の無いパス（.claude の無いリポジトリの .claude/settings.json など）も試すため、
//   一時ディレクトリの下の自分の乱数名の作業用ディレクトリで、守られていない親を作ってから作成を試す（利用者のリポジトリには作らない）。
//   作業用ディレクトリは終わったら中身ごと消す。作れない・消せないときは確かめられないので書けるとみなす。
//   作業用ディレクトリで書けたら、作業ディレクトリの下の同じ相対パスを書けてしまう置き場として出す（プロファイルはどのディレクトリの下でも当てる）。
function writable({ paths, ancestors, projects, allows }: Guarded, cwd: string): string[] {
  const uid = process.getuid?.();
  const denied = (attempt: () => void): boolean => {
    try {
      attempt();
      return false;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  // 親 parent の下への作成の失敗 e が、サンドボックスの拒否か
  const refused = (e: unknown, parent: string): boolean => {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code !== "EACCES") return false;
    try {
      const stat = statSync(parent);
      return stat.uid === uid && (stat.mode & 0o200) !== 0;
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
    if (ancestor || !stat.isDirectory()) return !denied(chmod);
    return !denied(chmod) || create(join(path, `.pstack-omp-probe-${randomBytes(6).toString("hex")}`), true);
  };
  const scratch = (): string[] => {
    let work: string;
    try {
      work = mkdtempSync(join(tmpdir(), "pstack-omp-probe-"));
    } catch (e) {
      return [`${tmpdir()}（試しの作業用ディレクトリを作れません: ${(e as Error).message}）`];
    }
    const open: string[] = [];
    try {
      for (const { path, directory } of projects) {
        const target = join(work, path);
        try {
          mkdirSync(dirname(target), { recursive: true });
        } catch (e) {
          // 親も拒否されるなら、その下は作れない
          if ((e as NodeJS.ErrnoException).code !== "EPERM") open.push(join(cwd, path));
          continue;
        }
        if (create(target, directory)) open.push(join(cwd, path));
      }
    } finally {
      try {
        rmSync(work, { recursive: true, force: true });
      } catch (e) {
        open.push(`${work}（試しの作業用ディレクトリを消せません: ${(e as Error).message}）`);
      }
    }
    return open;
  };
  const open = [
    ...paths.filter(({ path, directory }) => probe(path, directory)).map(({ path }) => path),
    ...ancestors.filter((path) => probe(path, true, true)),
    ...projects
      .map(({ path, directory }) => ({ path: join(cwd, path), target: realAncestor(join(cwd, path)), directory }))
      // 規則の allowPaths の下は、プロファイルでもどのプロジェクトでも書かせないパスの照合から外れる
      .filter(({ target }) => !allows.some((allow) => (allow.directory ? within(target, allow.path) : target === allow.path)))
      .filter(({ path, directory }) => probe(path, directory))
      .map(({ path }) => path),
    ...scratch(),
  ];
  return [...new Set(open)];
}

// 同じディレクトリの別名（macOS の /tmp と /private/tmp、~ など）を同じとみなすための形
export function real(path: string): string {
  const expanded = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
  try {
    return realpathSync(expanded);
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
