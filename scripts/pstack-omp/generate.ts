// 取得した上流から、OMP 向けのコピーをデータ置き場の下の pstack-omp/generated に生成する（nod のリポジトリの外）。
// 入れるのは pstack の全スキルと cursor-team-kit の CURSOR_TEAM_KIT_SKILLS だけ。上流のルートの配置（pstack/、cursor-team-kit/）を保つので、
// OMP の skills.customDirectories に generated/pstack/skills と generated/cursor-team-kit/skills を登録すれば、それぞれの */SKILL.md が読まれる。
// スキルの .md の相対リンクの先（スキルの外の文書や画像）も、上流と同じ相対位置に入れ、その先の .md のリンクも同じく辿る。
// 読み込まない cursor-team-kit のスキルはリンクの先でも入れない（スキルとして読まれてしまうため）。
// 本文は書き換えない。Cursor の用語（terms.ts）を使うスキルの SKILL.md だけ、最初の H1 の直後に案内の1行を入れる。リンクも書き換えない。
// 次のどれかがあれば、何も書かずに止める: 読み替え表に対応行のない用語、用語を使うのに H1 の無い SKILL.md、生成物の中で解決できない相対リンク。
// 書くときは同じ階層の一時ディレクトリに作り終えてから置き換える。失敗したら前回の生成物はそのまま残す
// （適用した OMP の設定が指している置き場なので、失敗で消すと、使えていたスキルが次のセッションから読まれなくなる）。
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { type Context, PstackOmpError } from "./context";
import { TERMS } from "./terms";

const ROOTS = ["pstack", "cursor-team-kit"] as const;
type Root = (typeof ROOTS)[number];
const CURSOR_TEAM_KIT_SKILLS = ["control-cli", "control-ui", "deslop"];
// 読み替え表のスキルの、OMP 向けのディレクトリの中の位置
export const TABLE_PATH = "skills/pstack-omp/SKILL.md";
const GUIDE_LINE =
  "In OMP, read the `pstack-omp` skill (`skill://pstack-omp`) once per session before you follow this skill. It maps the Cursor names in pstack skills to OMP.";
// Markdown の相対リンクとして扱う形（上流の道具と同じ）
const LINK = /\]\(([^)\s]+)\)/g;

interface Source {
  bytes: Buffer;
  executable: boolean;
}

export interface Generated {
  dir: string;
  skills: Record<Root, string[]>;
  // 案内の1行を入れたスキル
  guided: Record<Root, string[]>;
  // 用語の key → それを使うスキル（root/名前）。用語の一覧の順
  terms: Map<string, string[]>;
}

export function generate(ctx: Context, upstreamDir: string): Generated {
  const tablePath = join(ctx.packageDir, TABLE_PATH);
  let table: string;
  try {
    table = readFileSync(tablePath, "utf8");
  } catch (e) {
    throw new PstackOmpError(`読み替え表 ${tablePath} を読めません: ${(e as Error).message}`);
  }
  const skills = findSkills(upstreamDir);

  const files = new Map<string, Source>();
  const terms = new Map<string, string[]>();
  const guided: Record<Root, string[]> = { pstack: [], "cursor-team-kit": [] };
  const noH1: string[] = [];
  for (const root of ROOTS) {
    for (const skill of skills[root]) {
      const dir = `${root}/skills/${skill}`;
      const used = new Set<string>();
      for (const path of walk(upstreamDir, dir)) {
        const source = read(upstreamDir, path);
        files.set(path, source);
        if (!path.endsWith(".md")) continue;
        const text = source.bytes.toString("utf8");
        for (const term of TERMS) if (term.re.test(text)) used.add(term.key);
      }
      if (used.size === 0) continue;
      for (const key of used) terms.set(key, [...(terms.get(key) ?? []), `${root}/${skill}`]);
      const skillMd = files.get(`${dir}/SKILL.md`)!;
      const withGuide = insertGuide(skillMd.bytes.toString("utf8"));
      if (withGuide === undefined) noH1.push(`${dir}/SKILL.md（使う用語: ${[...used].join(", ")}）`);
      else skillMd.bytes = Buffer.from(withGuide);
      guided[root].push(skill);
    }
  }
  const dangling = addLinkedFiles(upstreamDir, files);

  const rows = firstCells(table);
  const missing = TERMS.filter(({ key }) => terms.has(key) && !rows.some((cell) => cell.includes(key))).map(
    ({ key }) => `${key}（使うスキル: ${terms.get(key)!.join(", ")}）`,
  );
  const problems = [
    [`読み替え表 ${tablePath} に対応行のない用語があります（表の行の最初のセルに用語をそのまま書いてください）`, missing],
    ["用語を使うのに SKILL.md に H1 が無く、案内の1行を入れられないスキルがあります", noH1],
    ["生成物の中で解決できない相対リンクがあります", dangling],
  ] as const;
  if (problems.some(([, list]) => list.length > 0)) {
    const report = problems.filter(([, list]) => list.length > 0).flatMap(([title, list]) => [`${title}:`, ...list.map((item) => `  ${item}`)]);
    throw new PstackOmpError(["OMP 向けのコピーを生成できません。", ...report].join("\n"));
  }

  // skills と guided のキーは ROOTS の順に作ってあるので、manifest の順序は入力によらず同じ
  const manifest = { pin: ctx.pin, skills, guided };
  files.set("manifest.json", { bytes: Buffer.from(JSON.stringify(manifest, null, 2) + "\n"), executable: false });
  const dir = join(ctx.workDir, "generated");
  replaceDir(ctx.workDir, dir, files);
  return { dir, skills, guided, terms: new Map(TERMS.filter(({ key }) => terms.has(key)).map(({ key }) => [key, terms.get(key)!])) };
}

// pstack のスキル（pstack/skills/*/SKILL.md のあるディレクトリ）と、cursor-team-kit の読み込む3つ。名前の順
function findSkills(upstreamDir: string): Record<Root, string[]> {
  const pstackSkills = join(upstreamDir, "pstack", "skills");
  const pstack = existsSync(pstackSkills)
    ? readdirSync(pstackSkills)
        .filter((name) => existsSync(join(pstackSkills, name, "SKILL.md")))
        .sort()
    : [];
  if (pstack.length === 0) throw new PstackOmpError(`上流に pstack のスキル（pstack/skills/*/SKILL.md）がありません: ${upstreamDir}`);
  const absent = CURSOR_TEAM_KIT_SKILLS.filter((name) => !existsSync(join(upstreamDir, "cursor-team-kit", "skills", name, "SKILL.md")));
  if (absent.length > 0) throw new PstackOmpError(`上流に cursor-team-kit のスキル ${absent.join(", ")} がありません: ${upstreamDir}`);
  return { pstack, "cursor-team-kit": CURSOR_TEAM_KIT_SKILLS };
}

// 上流の rel（ファイルかディレクトリ）の下の全ファイルの、上流のルートからの相対パス。パスの順
function walk(upstreamDir: string, rel: string): string[] {
  const stat = lstatSync(join(upstreamDir, rel));
  if (stat.isSymbolicLink()) throw new PstackOmpError(`上流の ${rel} はシンボリックリンクです。生成の道具はシンボリックリンクを扱いません`);
  if (!stat.isDirectory()) return [rel];
  return readdirSync(join(upstreamDir, rel))
    .filter((name) => name !== ".git")
    .sort()
    .flatMap((name) => walk(upstreamDir, posix.join(rel, name)));
}

function read(upstreamDir: string, rel: string): Source {
  const path = join(upstreamDir, rel);
  return { bytes: readFileSync(path), executable: (lstatSync(path).mode & 0o111) !== 0 };
}

// 最初の H1（フロントマターとコードブロックの中を除く）の直後に案内の1行を入れる。H1 の後の空行は1つにまとめる（上流の道具と同じ）。
// H1 が無ければ undefined
function insertGuide(text: string): string | undefined {
  const lines = text.split("\n");
  const frontmatterEnd = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  const code = codeLines(lines);
  const h1 = lines.findIndex((line, i) => i > frontmatterEnd && !code[i] && line.startsWith("# "));
  if (h1 < 0) return undefined;
  let rest = h1 + 1;
  while (lines[rest] === "") rest++;
  return `${lines.slice(0, h1 + 1).join("\n")}\n\n${GUIDE_LINE}\n\n${lines.slice(rest).join("\n")}`;
}

// 各行がコードブロック（開きと閉じの行を含む）の中かどうか
function codeLines(lines: string[]): boolean[] {
  let fence: string | undefined;
  return lines.map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === undefined) {
      fence = marker;
      return marker !== undefined;
    }
    if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(`+|~+)\s*$/.test(line)) fence = undefined;
    return true;
  });
}

// 読み替え表の Markdown の表の行（| で始まる行。見出し行の区切りとコードブロックの中を除く）の最初のセル
function firstCells(table: string): string[] {
  const lines = table.split("\n");
  const code = codeLines(lines);
  return lines.flatMap((line, i) => {
    if (code[i] || !/^ {0,3}\|/.test(line)) return [];
    const row = line.trim().slice(1).split(/(?<!\\)\|/);
    const separator = row.every((cell) => /^\s*:?-*:?\s*$/.test(cell)) && row.some((cell) => cell.includes("-"));
    return separator ? [] : [row[0]!];
  });
}

// files の .md の相対リンクの先を、上流と同じ相対位置に足す（足した .md のリンクも辿る）。
// 生成物の中で解決できないリンク（上流には先があるのに入れられない、上流のルートの外を指す）を返す
function addLinkedFiles(upstreamDir: string, files: Map<string, Source>): string[] {
  const dangling: string[] = [];
  const queue = [...files.keys()];
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    if (!path.endsWith(".md")) continue;
    for (const [, href] of files.get(path)!.bytes.toString("utf8").matchAll(LINK)) {
      const target = href!.replace(/[#?].*/, "");
      if (target === "" || target.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const resolved = posix.normalize(posix.join(posix.dirname(path), target)).replace(/\/$/, "");
      if (resolved === "." || resolved === ".." || resolved.startsWith("../")) {
        dangling.push(`${path} → ${href}（上流のルートの外を指す）`);
        continue;
      }
      if (!existsSync(join(upstreamDir, resolved))) continue;
      for (const file of walk(upstreamDir, resolved)) {
        if (files.has(file) || isOtherTeamKitSkill(file)) continue;
        files.set(file, read(upstreamDir, file));
        queue.push(file);
      }
      if (!files.has(resolved) && ![...files.keys()].some((file) => file.startsWith(`${resolved}/`))) {
        dangling.push(`${path} → ${href}（読み込まない cursor-team-kit のスキルを指す）`);
      }
    }
  }
  return dangling;
}

function isOtherTeamKitSkill(path: string): boolean {
  const [root, skills, skill, ...rest] = path.split("/");
  return root === "cursor-team-kit" && skills === "skills" && rest.length > 0 && !CURSOR_TEAM_KIT_SKILLS.includes(skill!);
}

// files を一時ディレクトリに書き終えてから dir と置き換える。途中で失敗したら一時ディレクトリを消し、dir は元のまま
function replaceDir(workDir: string, dir: string, files: Map<string, Source>): void {
  mkdirSync(workDir, { recursive: true });
  const staging = mkdtempSync(join(workDir, ".generated-"));
  try {
    chmodSync(staging, 0o755);
    for (const path of [...files.keys()].sort()) {
      const { bytes, executable } = files.get(path)!;
      mkdirSync(join(staging, path, ".."), { recursive: true });
      writeFileSync(join(staging, path), bytes);
      chmodSync(join(staging, path), executable ? 0o755 : 0o644);
    }
    if (!existsSync(dir)) {
      renameSync(staging, dir);
      return;
    }
    const old = mkdtempSync(join(workDir, ".generated-old-"));
    renameSync(dir, join(old, "generated"));
    try {
      renameSync(staging, dir);
    } catch (e) {
      renameSync(join(old, "generated"), dir);
      throw e;
    }
    rmSync(old, { recursive: true, force: true });
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}
