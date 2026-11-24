// OMP がエージェント定義とスキルを読む置き場から、名前を集める（名前のぶつかりの検査と状態の表示のため）。
// エージェントの名前は <dir>/*.md の frontmatter の name（無いか空ならファイル名）、スキルの名前は <dir>/*/SKILL.md の frontmatter の name の
// 前後の空白（改行を含む）を除いたもの（無いか、除いて空ならディレクトリ名。OMP 19.1.0 の scanSkillsFromDir と同じ。エージェントの名前は
// OMP も除かない）。OMP と同じく非再帰で読む。置き場が無ければ何も無いとみなす。
// OMP は description の無いスキルや enabled: false のスキルを読まないが、ここではそれを見分けず、在るスキルはすべて名前を集める。
// 定義のファイルが在るのに読めない（権限が無い、SKILL.md という名前のディレクトリなど）なら、名前を確かめられないので例外にせず、
// unreadable に入れて呼び出し側に返す（適用は止まり、状態の表示はそのファイルを表示する）。
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { OmpConfig } from "./config";
import { isMapping, stringList, valueAt } from "./config";

export interface Definition {
  kind: "agent" | "skill";
  name: string;
  // 定義のファイル
  path: string;
}

// 置き場から集めた定義と、在るのに読めないので名前を確かめられない定義のファイル
export interface Found {
  definitions: Definition[];
  unreadable: string[];
}

export function skillsIn(dir: string): Found {
  return collect(entries(dir).map((entry) => ({ kind: "skill", path: join(dir, entry, "SKILL.md"), fallback: entry })));
}

export function agentsIn(dir: string): Found {
  return collect(
    entries(dir)
      .filter((entry) => entry.endsWith(".md") && isFile(join(dir, entry)))
      .map((entry) => ({ kind: "agent", path: join(dir, entry), fallback: basename(entry, ".md") })),
  );
}

// OMP 向けのディレクトリ（拡張のパッケージ）の skills/ と agents/
export function packageDefinitions(dir: string): Found {
  return merge([skillsIn(join(dir, "skills")), agentsIn(join(dir, "agents"))]);
}

export interface UserPlaces extends Found {
  // 検査した置き場（報告のため）
  dirs: string[];
}

// 利用者の置き場: <agentDir>/agents、<agentDir>/skills、~/.agent/skills、~/.agents/skills、config（OMP がいま global の設定として読むファイル。
// config.yml が無ければ config.yaml）の skills.customDirectories と extensions のパッケージ（skills/ と agents/）。
// ours の下（適用した写しの生成したスキル・OMP 向けのディレクトリ・制御の拡張のファイル）は除く。disabledProviders では外さない
// （名前のぶつかりの検査を、止める向きに保つため）。
// スキルは、通常の omp で同じ名前がぶつかったときに裸の名前を取る順（normalOmpSkills の並びから、プロジェクトの置き場を除いたもの）に並べる:
// skills.customDirectories の配列の順 > <agentDir>/skills > extensions のパッケージの skills/（extensions の配列の順）> ~/.agent/skills > ~/.agents/skills
export function userPlaces(agentDir: string, home: string, config: OmpConfig, ours: string): UserPlaces {
  const { custom, native, packages, agents } = userSkillDirs(agentDir, home, config, ours);
  return {
    dirs: [join(agentDir, "agents"), ...custom, native, ...packages, ...agents],
    ...merge([agentsIn(join(agentDir, "agents")), ...custom.map(skillsIn), skillsIn(native), ...packages.map(packageDefinitions), ...agents.map(skillsIn)]),
  };
}

// 通常の omp のセッションのスキル。project は実行したディレクトリのプロジェクトの置き場のものか
export interface OmpSkill extends Definition {
  project: boolean;
}

// 通常の omp のセッションのスキルと、在るのに読めない SKILL.md（project はプロジェクトの置き場のものか）
export interface OmpSkills {
  skills: OmpSkill[];
  unreadable: { path: string; project: boolean }[];
}

// 通常の omp のセッションで読まれるスキル（利用者の置き場と、実行したディレクトリのプロジェクトの置き場）を、同じ名前がぶつかったときに
// 裸の名前を取る順に並べる（呼び出し側は最初のものを裸の名前のものとして使える）。プロジェクトの置き場は projectPlaces と同じ祖先を近い順に:
// 1. skills.customDirectories の配列の順（provider ではないので disabledProviders では外れない）
// 2. native（priority 100）: プロジェクトの .omp/skills、<agentDir>/skills
// 3. omp-plugins（90）: extensions のパッケージの skills/（extensions の配列の順）
// 4. claude（80）: プロジェクトの .claude/skills（~/.claude/skills は利用者の置き場に入れていないので含めない）
// 5. agents（70）: プロジェクトの各ディレクトリの .agent/skills・.agents/skills（同じディレクトリでは .agent が先）、~/.agent/skills、~/.agents/skills
// config（OMP がいま global の設定として読むファイル）の disabledProviders に入った provider の置き場は読まない（実行したディレクトリで解いた値。
// disabledProviders を参照）。プロジェクトの設定（.omp の settings など）の disabledProviders・skills.enabled・ignoredSkills などは見ない。
// 出典: OMP 19.1.0 の src/extensibility/skills.ts の resolveCollision（custom directory のスキルは provider のスキルより優先、それ以外は
// 先に admit されたもの）、skills.md の provider の priority、src/discovery の builtin.ts・claude.ts・agents.ts の loadSkills の読む順、
// src/capability/index.ts の filterProviders。
// 在るのに読めない SKILL.md は unreadable に入れる（project はプロジェクトの置き場のものか）
export function normalOmpSkills(
  agentDir: string,
  home: string,
  config: OmpConfig,
  ours: string,
  cwd: string,
): OmpSkills {
  const { custom, native, packages, agents } = userSkillDirs(agentDir, home, config, ours);
  const { dirs } = projectDirs(cwd, home);
  const disabled = disabledProviders(config, real(cwd), home);
  // スキルの置き場と、それを読む provider（custom directory は provider ではない）
  const places: { dir: string; project: boolean; provider?: string }[] = [
    ...custom.map((dir) => ({ dir, project: false })),
    ...dirs.map((dir) => ({ dir: join(dir, ".omp", "skills"), project: true, provider: "native" })),
    { dir: native, project: false, provider: "native" },
    ...packages.map((dir) => ({ dir: join(dir, "skills"), project: false, provider: "omp-plugins" })),
    ...dirs.map((dir) => ({ dir: join(dir, ".claude", "skills"), project: true, provider: "claude" })),
    ...dirs.flatMap((dir) => [".agent", ".agents"].map((name) => ({ dir: join(dir, name, "skills"), project: true, provider: "agents" }))),
    ...agents.map((dir) => ({ dir, project: false, provider: "agents" })),
  ];
  const groups = places.filter(({ provider }) => provider === undefined || !disabled.has(provider)).map(({ dir, project }) => ({ project, found: skillsIn(dir) }));
  return {
    skills: groups.flatMap(({ project, found }) => found.definitions.map((d) => ({ ...d, project }))),
    unreadable: groups.flatMap(({ project, found }) => found.unreadable.map((path) => ({ path, project }))),
  };
}

// 利用者の置き場のスキルの置き場: skills.customDirectories（custom）、<agentDir>/skills（native）、extensions のパッケージ（packages）、
// ~/.agent/skills と ~/.agents/skills（agents。OMP 19.1.0 の agents.ts の AGENT_DIR_CANDIDATES の順）。ours の下は除く
function userSkillDirs(agentDir: string, home: string, config: OmpConfig, ours: string): { custom: string[]; native: string; packages: string[]; agents: string[] } {
  return {
    custom: (stringList(config, "skills.customDirectories") ?? []).map((dir) => expand(dir, home)).filter((dir) => !within(dir, ours)),
    native: join(agentDir, "skills"),
    packages: (stringList(config, "extensions") ?? []).map((dir) => expand(dir, home)).filter((dir) => !within(dir, ours)),
    agents: [join(home, ".agent", "skills"), join(home, ".agents", "skills")],
  };
}

// config の disabledProviders を、実行したディレクトリ（cwd。実パス）で解いた provider の名前。OMP 19.1.0 の src/config/settings.ts の
// resolvePathScopedArray と同じく、文字列はそのまま、オブジェクトは path・paths・pathPrefix・pathPrefixes のどれかが cwd そのものかその祖先を
// 指せば、values・items・providers の文字列を足す（前置きの無いオブジェクトは足さない）。配列でなければ何も外さない
function disabledProviders(config: OmpConfig, cwd: string, home: string): Set<string> {
  const value = valueAt(config.data, "disabledProviders");
  if (!Array.isArray(value)) return new Set();
  const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((item): item is string => typeof item === "string") : []);
  const covers = (prefix: string): boolean => {
    const rel = relative(expand(prefix, home), cwd);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  return new Set(
    value.flatMap((entry: unknown) => {
      if (typeof entry === "string") return [entry];
      if (!isMapping(entry)) return [];
      const prefixes = [...strings(entry.path), ...strings(entry.paths), ...strings(entry.pathPrefix), ...strings(entry.pathPrefixes)];
      return prefixes.some(covers) ? [...strings(entry.values), ...strings(entry.items), ...strings(entry.providers)] : [];
    }),
  );
}

export interface ProjectPlaces extends Found {
  // プロジェクトの根（git の作業ツリーの根。git の外なら実行したディレクトリ）
  root: string;
}

// 実行したディレクトリのプロジェクトの置き場。
// - スキル: 実行したディレクトリから git の作業ツリーの根まで遡った各ディレクトリの .omp/skills・.agents/skills・.agent/skills・.claude/skills。
//   ホームは利用者の置き場なので含めない
// - エージェント定義: OMP 19.1.0 の task の探索（findAllNearestProjectConfigDirs）と同じく、実行したディレクトリからファイルシステムの根まで
//   遡って最初に在る .omp/agents（ディレクトリ）の1つだけ。git の根やホームで止まらない（ホームの ~/.omp/agents も、より近いものが無ければ入る）。
//   OMP はそれより遠い .omp/agents を読まないので、含めない
export function projectPlaces(cwd: string, home: string): ProjectPlaces {
  const start = real(cwd);
  const { root, dirs } = projectDirs(cwd, home);
  let agents: string | undefined;
  for (let dir = start; agents === undefined; dir = dirname(dir)) {
    if (isDirectory(join(dir, ".omp", "agents"))) agents = join(dir, ".omp", "agents");
    else if (dirname(dir) === dir) break;
  }
  return {
    root,
    ...merge([
      ...(agents === undefined ? [] : [agentsIn(agents)]),
      ...dirs.flatMap((dir) => [".omp", ".agents", ".agent", ".claude"].map((name) => skillsIn(join(dir, name, "skills")))),
    ]),
  };
}

// プロジェクトの根（git の作業ツリーの根。git の外なら実行したディレクトリ）と、実行したディレクトリから根まで遡った各ディレクトリ（近い順。
// ホームは利用者の置き場なので含めない。git の外なら実行したディレクトリだけ）
function projectDirs(cwd: string, home: string): { root: string; dirs: string[] } {
  const realHome = real(home);
  const start = real(cwd);
  const chain: string[] = [];
  for (let dir = start; dir !== realHome; dir = dirname(dir)) {
    chain.push(dir);
    if (existsSync(join(dir, ".git"))) return { root: dir, dirs: chain };
    if (dirname(dir) === dir) break;
  }
  return { root: start, dirs: chain.slice(0, 1) };
}

// 別名（/tmp と /private/tmp など）を解いた形。無ければ絶対パスにしただけの形
export function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// path が dir そのものか、その下か（別名を解いて比べる）
export function within(path: string, dir: string): boolean {
  const p = real(path);
  const d = real(dir);
  return p === d || p.startsWith(d + sep);
}

function expand(path: string, home: string): string {
  return path === "~" || path.startsWith("~/") ? join(home, path.slice(1)) : resolve(path);
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// 在る定義のファイル（path）を読んで名前を集める（名前の決め方は冒頭のとおり）。在るのに読めなければ unreadable に入れる
function collect(candidates: { kind: Definition["kind"]; path: string; fallback: string }[]): Found {
  const found: Found = { definitions: [], unreadable: [] };
  for (const { kind, path, fallback } of candidates) {
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      found.unreadable.push(path);
      continue;
    }
    const raw = frontmatterName(text);
    found.definitions.push({ kind, name: (kind === "skill" ? raw?.trim() : raw) || fallback, path });
  }
  return found;
}

function merge(list: Found[]): Found {
  return { definitions: list.flatMap((f) => f.definitions), unreadable: list.flatMap((f) => f.unreadable) };
}

// frontmatter（先頭の --- から --- まで）の name（文字列のときだけ。そのままの形）。無い・読めない frontmatter なら undefined
function frontmatterName(text: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (match === null) return undefined;
  try {
    const data = Bun.YAML.parse(match[1]!);
    if (typeof data === "object" && data !== null && "name" in data && typeof data.name === "string") return data.name;
  } catch {
    // 読めない frontmatter は名前が無いとみなす
  }
  return undefined;
}
