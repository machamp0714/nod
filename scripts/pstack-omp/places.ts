// OMP がエージェント定義とスキルを読む置き場から、名前を集める（名前のぶつかりの検査と状態の表示のため）。
// エージェントの名前は <dir>/*.md の frontmatter の name（無ければファイル名）、スキルの名前は <dir>/*/SKILL.md の frontmatter の name
// （無ければディレクトリ名）。OMP と同じく非再帰で読む。置き場が無ければ何も無いとみなす。
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

export function skillsIn(dir: string): Definition[] {
  return entries(dir).flatMap((entry) => {
    const path = join(dir, entry, "SKILL.md");
    return existsSync(path) ? [{ kind: "skill" as const, name: frontmatterName(path) ?? entry, path }] : [];
  });
}

export function agentsIn(dir: string): Definition[] {
  return entries(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return entry.endsWith(".md") && isFile(path) ? [{ kind: "agent" as const, name: frontmatterName(path) ?? basename(entry, ".md"), path }] : [];
  });
}

// OMP 向けのディレクトリ（拡張のパッケージ）の skills/ と agents/
export function packageDefinitions(dir: string): Definition[] {
  return [...skillsIn(join(dir, "skills")), ...agentsIn(join(dir, "agents"))];
}

export interface UserPlaces {
  // 検査した置き場（報告のため）
  dirs: string[];
  definitions: Definition[];
}

// 利用者の置き場: <agentDir>/agents、<agentDir>/skills、~/.agents/skills、config.yml の skills.customDirectories と
// extensions のパッケージ（skills/ と agents/）。ours の下（適用した写し）は除く
export function userPlaces(agentDir: string, home: string, config: OmpConfig, ours: string): UserPlaces {
  const skillDirs = [join(agentDir, "skills"), join(home, ".agents", "skills"), ...(stringList(config, "skills.customDirectories") ?? []).map((dir) => expand(dir, home))];
  const packages = (stringList(config, "extensions") ?? []).map((dir) => expand(dir, home)).filter((dir) => !within(dir, ours));
  return {
    dirs: [join(agentDir, "agents"), ...skillDirs, ...packages],
    definitions: [...agentsIn(join(agentDir, "agents")), ...skillDirs.flatMap(skillsIn), ...packages.flatMap(packageDefinitions)],
  };
}

export interface ProjectPlaces {
  // プロジェクトの根（git の作業ツリーの根。git の外なら実行したディレクトリ）
  root: string;
  definitions: Definition[];
}

// 実行したディレクトリのプロジェクトの置き場: 実行したディレクトリから git の作業ツリーの根まで遡った各ディレクトリの
// .omp/agents と、.omp/skills・.agents/skills・.agent/skills・.claude/skills。ホームは利用者の置き場なので含めない
export function projectPlaces(cwd: string, home: string): ProjectPlaces {
  const realHome = real(home);
  const chain: string[] = [];
  let root: string | undefined;
  for (let dir = real(cwd); dir !== realHome; dir = dirname(dir)) {
    chain.push(dir);
    if (existsSync(join(dir, ".git"))) {
      root = dir;
      break;
    }
    if (dirname(dir) === dir) break;
  }
  const dirs = root === undefined ? chain.slice(0, 1) : chain;
  return {
    root: root ?? real(cwd),
    definitions: dirs.flatMap((dir) => [
      ...agentsIn(join(dir, ".omp", "agents")),
      ...[".omp", ".agents", ".agent", ".claude"].flatMap((name) => skillsIn(join(dir, name, "skills"))),
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

// frontmatter（先頭の --- から --- まで）の name。読めなければ undefined
function frontmatterName(path: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(readFileSync(path, "utf8"));
  if (match === null) return undefined;
  try {
    const data = Bun.YAML.parse(match[1]!);
    if (typeof data === "object" && data !== null && "name" in data && typeof data.name === "string" && data.name !== "") return data.name;
  } catch {
    // 読めない frontmatter は名前が無いとみなす
  }
  return undefined;
}
