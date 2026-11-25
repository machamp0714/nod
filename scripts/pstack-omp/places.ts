// OMP がエージェント定義を読む置き場から、名前を集める（状態の表示の、プロジェクトの置き場の名前のぶつかりのため）。
// OMP 19.1.0 の loadAgentsFromDir・parseAgent・parseAgentFields と同じく、<dir>/*.md を非再帰で読み、frontmatter（前の HTML のコメントは除く）に
// 空でない文字列の name と description があり、name の前後の空白を除いて小文字にした形が main・sub でないものだけを定義とする。名前は name を
// そのままの形（前後の空白も除かない）で使い、ファイル名には頼らない。それ以外のファイルは OMP が読み飛ばすので定義に入れない。
// 置き場が無ければ何も無いとみなす。プロジェクトのスキルは omp-skills.ts が OMP と同じ条件で集める。
// 定義のファイルが在るのに読めない（権限が無いなど）なら、名前を確かめられないので例外にせず、
// unreadable に入れて呼び出し側に返す（状態の表示はそのファイルを表示する）。
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { parseFrontmatter } from "./frontmatter";

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

// <dir>/*.md のうち OMP が読むエージェント定義。在るのに読めなければ unreadable に入れる
function agentsIn(dir: string): Found {
  const found: Found = { definitions: [], unreadable: [] };
  for (const entry of entries(dir).filter((e) => e.endsWith(".md") && isFile(join(dir, e)))) {
    const path = join(dir, entry);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      found.unreadable.push(path);
      continue;
    }
    const frontmatter = parseFrontmatter(text);
    const name = typeof frontmatter.name === "string" ? frontmatter.name : "";
    const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
    if (name === "" || description === "" || ["main", "sub"].includes(name.trim().toLowerCase())) continue;
    found.definitions.push({ kind: "agent", name, path });
  }
  return found;
}

// OMP 向けのディレクトリ（拡張のパッケージ）の agents/
export function packageAgents(dir: string): Found {
  return agentsIn(join(dir, "agents"));
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
