// OMP がエージェント定義とスキルを読む置き場から、名前を集める（名前のぶつかりの検査と状態の表示のため）。
// エージェントの名前は <dir>/*.md の frontmatter の name（無ければファイル名）、スキルの名前は <dir>/*/SKILL.md の frontmatter の name
// （無ければディレクトリ名）。OMP と同じく非再帰で読む。置き場が無ければ何も無いとみなす。
// 定義のファイルが在るのに読めない（権限が無い、SKILL.md という名前のディレクトリなど）なら、名前を確かめられないので例外にせず、
// unreadable に入れて呼び出し側に返す（適用は止まり、状態の表示はそのファイルを表示する）。
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { OmpConfig } from "./config";
import { stringList } from "./config";

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

// 利用者の置き場: <agentDir>/agents、<agentDir>/skills、~/.agents/skills、config（OMP がいま global の設定として読むファイル。
// config.yml が無ければ config.yaml）の skills.customDirectories と extensions のパッケージ（skills/ と agents/）。
// ours の下（適用した写しの生成したスキル・OMP 向けのディレクトリ・制御の拡張のファイル）は除く。
// スキルは、通常の omp で同じ名前がぶつかったときに裸の名前を取る順に並べる（呼び出し側は最初のものを裸の名前のものとして使える）:
// skills.customDirectories の配列の順 > <agentDir>/skills（native、priority 100）> extensions のパッケージの skills/（omp-plugins、90。
// extensions の配列の順）> ~/.agents/skills（agents、70）。出典: OMP 19.1.0 の src/extensibility/skills.ts の resolveCollision
// （custom directory のスキルは provider のスキルより優先、それ以外は先に admit されたもの）と、skills.md の provider の priority
export function userPlaces(agentDir: string, home: string, config: OmpConfig, ours: string): UserPlaces {
  const custom = (stringList(config, "skills.customDirectories") ?? []).map((dir) => expand(dir, home)).filter((dir) => !within(dir, ours));
  const native = join(agentDir, "skills");
  const agents = join(home, ".agents", "skills");
  const packages = (stringList(config, "extensions") ?? []).map((dir) => expand(dir, home)).filter((dir) => !within(dir, ours));
  return {
    dirs: [join(agentDir, "agents"), ...custom, native, ...packages, agents],
    ...merge([agentsIn(join(agentDir, "agents")), ...custom.map(skillsIn), skillsIn(native), ...packages.map(packageDefinitions), skillsIn(agents)]),
  };
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
  const realHome = real(home);
  const start = real(cwd);
  const chain: string[] = [];
  let root: string | undefined;
  for (let dir = start; dir !== realHome; dir = dirname(dir)) {
    chain.push(dir);
    if (existsSync(join(dir, ".git"))) {
      root = dir;
      break;
    }
    if (dirname(dir) === dir) break;
  }
  const dirs = root === undefined ? chain.slice(0, 1) : chain;
  let agents: string | undefined;
  for (let dir = start; agents === undefined; dir = dirname(dir)) {
    if (isDirectory(join(dir, ".omp", "agents"))) agents = join(dir, ".omp", "agents");
    else if (dirname(dir) === dir) break;
  }
  return {
    root: root ?? start,
    ...merge([
      ...(agents === undefined ? [] : [agentsIn(agents)]),
      ...dirs.flatMap((dir) => [".omp", ".agents", ".agent", ".claude"].map((name) => skillsIn(join(dir, name, "skills")))),
    ]),
  };
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

// 在る定義のファイル（path）を読んで名前を集める。frontmatter の name が無ければ fallback。在るのに読めなければ unreadable に入れる
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
    found.definitions.push({ kind, name: frontmatterName(text) ?? fallback, path });
  }
  return found;
}

function merge(list: Found[]): Found {
  return { definitions: list.flatMap((f) => f.definitions), unreadable: list.flatMap((f) => f.unreadable) };
}

// frontmatter（先頭の --- から --- まで）の name。無い・読めない frontmatter なら undefined
function frontmatterName(text: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (match === null) return undefined;
  try {
    const data = Bun.YAML.parse(match[1]!);
    if (typeof data === "object" && data !== null && "name" in data && typeof data.name === "string" && data.name !== "") return data.name;
  } catch {
    // 読めない frontmatter は名前が無いとみなす
  }
  return undefined;
}
