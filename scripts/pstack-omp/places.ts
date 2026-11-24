// OMP がエージェント定義とスキルを読む置き場から、名前を集める（名前のぶつかりの検査と状態の表示のため）。
// エージェントの名前は <dir>/*.md の frontmatter の name（無いか空ならファイル名）、スキルの名前は <dir>/*/SKILL.md の frontmatter の name の
// 前後の空白（改行を含む）を除いたもの（無いか、除いて空ならディレクトリ名。OMP 19.1.0 の scanSkillsFromDir と同じ。エージェントの名前は
// OMP も除かない）。OMP と同じく非再帰で読む。置き場が無ければ何も無いとみなす。
// OMP は description の無いスキルや enabled: false のスキルを読まないが、ここではそれを見分けず、在るスキルはすべて名前を集める（適用の
// 名前のぶつかりの検査を、止める向きに保つため）。通常の omp が実際に読むスキルは omp-skills.ts が OMP と同じ条件で集める（状態の表示）。
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

// 利用者の置き場: <agentDir>/agents、<agentDir>/skills、~/.agent/skills、~/.agents/skills、config（OMP がいま global の設定として読むファイル。
// config.yml が無ければ config.yaml）の skills.customDirectories と extensions のパッケージ（skills/ と agents/）。
// ours の下（適用した写しの生成したスキルの置き場と OMP 向けのディレクトリ）は除く。disabledProviders では外さない
// （名前のぶつかりの検査を、止める向きに保つため）。
// スキルは、通常の omp で同じ名前がぶつかったときに裸の名前を取る順（omp-skills.ts の並びのうち、これらの置き場のもの）に並べる:
// skills.customDirectories の配列の順 > <agentDir>/skills > extensions のパッケージの skills/（extensions の配列の順）> ~/.agent/skills > ~/.agents/skills
// （~/.agent/skills と ~/.agents/skills は OMP 19.1.0 の agents.ts の AGENT_DIR_CANDIDATES の順）
export function userPlaces(agentDir: string, home: string, config: OmpConfig, ours: string): UserPlaces {
  const custom = (stringList(config, "skills.customDirectories") ?? []).map((dir) => expand(dir, home)).filter((dir) => !within(dir, ours));
  const native = join(agentDir, "skills");
  const packages = (stringList(config, "extensions") ?? []).map((dir) => expand(dir, home)).filter((dir) => !within(dir, ours));
  const agents = [join(home, ".agent", "skills"), join(home, ".agents", "skills")];
  return {
    dirs: [join(agentDir, "agents"), ...custom, native, ...packages, ...agents],
    ...merge([agentsIn(join(agentDir, "agents")), ...custom.map(skillsIn), skillsIn(native), ...packages.map(packageDefinitions), ...agents.map(skillsIn)]),
  };
}

// 実行したディレクトリのプロジェクトのエージェント定義: OMP 19.1.0 の task の探索（findAllNearestProjectConfigDirs）と同じく、
// 実行したディレクトリからファイルシステムの根まで遡って最初に在る .omp/agents（ディレクトリ）の1つだけ。git の根やホームで止まらない
// （ホームの ~/.omp/agents も、より近いものが無ければ入る）。OMP はそれより遠い .omp/agents を読まないので、含めない。
// プロジェクトのスキルは omp-skills.ts の normalOmpSkills（project のもの）
export function projectAgents(cwd: string): Found {
  let agents: string | undefined;
  for (let dir = real(cwd); agents === undefined; dir = dirname(dir)) {
    if (isDirectory(join(dir, ".omp", "agents"))) agents = join(dir, ".omp", "agents");
    else if (dirname(dir) === dir) break;
  }
  return agents === undefined ? { definitions: [], unreadable: [] } : agentsIn(agents);
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

export function expand(path: string, home: string): string {
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
