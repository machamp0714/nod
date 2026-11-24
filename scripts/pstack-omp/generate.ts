// 取得した上流から、OMP 向けのコピーを固定の生成先（データ置き場の下の pstack-omp/generated。nod のリポジトリの外）に生成する。
// 入れるのは pstack の全スキルと cursor-team-kit の CURSOR_TEAM_KIT_SKILLS だけ。上流のルートの配置（pstack/、cursor-team-kit/）を保つので、
// 利用者が OMP の skills.customDirectories に生成先の pstack/skills と cursor-team-kit/skills を一度だけ登録すれば、通常の omp が
// それぞれの */SKILL.md を生成先から直接読む（登録する値は status が表示する）。
// スキルの .md の相対リンクの先（スキルの外の文書や画像）も、上流と同じ相対位置に入れ、その先の .md のリンクも同じく辿る。
// 読み込まない cursor-team-kit のスキルはリンクの先でも入れない（スキルとして読まれてしまうため）。
// 本文は書き換えない。Cursor の用語（terms.ts）を使うスキルの SKILL.md だけ、最初の H1 の後に案内の1行を入れる。リンクも書き換えない。
// スキルが用語を使うかは、スキルのディレクトリの中の .md と、そこから相対リンクで（リンク先の .md を経ても）辿れる .md で決める。
// 辿れる .md には、スキルの外の文書と、別の生成するスキルのディレクトリの中の SKILL.md 以外の文書（付属の参考の文書など）が入る。
// 別の生成するスキルの SKILL.md とディレクトリそのものへのリンクでは止まる（そのスキルの入口で、自分の範囲で決まる案内の1行を持つ）。
// 次のどれかがあれば、何も書かずに止める: 読み替え表に対応行のない用語、用語を使うのに H1 の無い SKILL.md、生成物の中で解決できない相対リンク、
// 読み替え表が示す生成先の中のパス（`<X>/generated/...`）が生成物に無いこと。
// 書くときは同じ階層の一時ディレクトリに作り終えてから置き換える。失敗したら前回の生成物はそのまま残す
// （通常の omp が生成先を直接読み、status も読むので、失敗で消すと、やり直すまで pstack のスキルが読まれず status も生成物を見失う）。
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { type Context, type Pin, PstackOmpError } from "./context";
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
// 読み替え表が示す生成先の中のパス（`<X>/<相対パス>`。<X> は生成先の親の <データ置き場>/pstack-omp で、<X>/generated/ が生成先）
const COPY_PATH = /<X>\/([^`\s）)、。]+)/g;

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

// 固定の生成先（<データ置き場>/pstack-omp/generated）
export function generatedDir(ctx: Pick<Context, "workDir">): string {
  return join(ctx.workDir, "generated");
}

// 生成先の中の、利用者が skills.customDirectories に登録するスキルの置き場（ROOTS の順）
export function skillDirs(dir: string): string[] {
  return ROOTS.map((root) => join(dir, root, "skills"));
}

// 生成物の manifest.json の、元にした固定の記録と生成したスキルの名前（ROOTS の順）
export interface Manifest {
  pin: Pin;
  names: string[];
}

// 生成先の manifest。無い・読めなければ undefined
export function readManifest(dir: string): Manifest | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { pin: Pin; skills: Record<string, string[]> };
    return { pin: manifest.pin, names: ROOTS.flatMap((root) => manifest.skills[root] ?? []) };
  } catch {
    return undefined;
  }
}

export function samePin(a: Pin, b: Pin): boolean {
  return a.repository === b.repository && a.commit === b.commit && a.pstackVersion === b.pstackVersion && a.ompVersion === b.ompVersion;
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

  // 生成するスキルのディレクトリ（root/skills/名前）と、その中のファイル。リンクの先が生成物に在るかを決めるため、先に全スキルを入れる
  const files = new Map<string, Source>();
  const skillDirs = new Map<string, string[]>();
  for (const root of ROOTS) {
    for (const skill of skills[root]) {
      const dir = `${root}/skills/${skill}`;
      const own = walk(upstreamDir, dir);
      for (const path of own) files.set(path, read(upstreamDir, path));
      skillDirs.set(dir, own);
    }
  }

  const terms = new Map<string, string[]>();
  const guided: Record<Root, string[]> = { pstack: [], "cursor-team-kit": [] };
  const noH1: string[] = [];
  const dangling = new Set<string>();
  for (const root of ROOTS) {
    for (const skill of skills[root]) {
      const dir = `${root}/skills/${skill}`;
      const own = skillDirs.get(dir)!;
      const linked = addLinkedFiles(upstreamDir, files, [...skillDirs.keys()], dir, own, dangling);
      const used = new Set<string>();
      for (const path of [...own, ...linked]) {
        if (!path.endsWith(".md")) continue;
        const text = files.get(path)!.bytes.toString("utf8");
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

  // skills と guided のキーは ROOTS の順に作ってあるので、manifest の順序は入力によらず同じ
  const manifest = { pin: ctx.pin, skills, guided };
  files.set("manifest.json", { bytes: Buffer.from(JSON.stringify(manifest, null, 2) + "\n"), executable: false });

  const rows = firstCells(table);
  const missing = TERMS.filter(({ key }) => terms.has(key) && !rows.some((cell) => cell.includes(key))).map(
    ({ key }) => `${key}（使うスキル: ${terms.get(key)!.join(", ")}）`,
  );
  const problems = [
    [`読み替え表 ${tablePath} に対応行のない用語があります（表の行の最初のセルに用語をそのまま書いてください）`, missing],
    ["用語を使うのに SKILL.md に H1 が無く、案内の1行を入れられないスキルがあります", noH1],
    ["生成物の中で解決できない相対リンクがあります", [...dangling]],
    [
      `読み替え表 ${tablePath} が示す生成先の中のパスが生成物にありません（生成先の親 <X> の generated/ の下の、生成物に在るパスを書いてください）`,
      missingCopyPaths(table, files),
    ],
  ] as const;
  if (problems.some(([, list]) => list.length > 0)) {
    const report = problems.filter(([, list]) => list.length > 0).flatMap(([title, list]) => [`${title}:`, ...list.map((item) => `  ${item}`)]);
    throw new PstackOmpError(["OMP 向けのコピーを生成できません。", ...report].join("\n"));
  }

  const dir = generatedDir(ctx);
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

// 最初の H1（フロントマターとコードブロックの中を除く）の後に、案内の1行を独立した段落として入れる。上流のバイトは削らない。
// H1 の後の空行が2行以上なら、1行目と2行目の空行の間に案内の1行だけを入れる。1行なら、その空行の後に案内の1行と空行を入れる。
// 0行なら、H1 の直後に空行・案内の1行・空行を入れる。案内の後の空行は、後に本文が続くときだけ足す。H1 が無ければ undefined
function insertGuide(text: string): string | undefined {
  const lines = text.split("\n");
  // 末尾の改行の後の空の要素は行に数えない
  const end = text.endsWith("\n") ? lines.length - 1 : lines.length;
  const frontmatterEnd = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  const code = codeLines(lines);
  const h1 = lines.findIndex((line, i) => i > frontmatterEnd && !code[i] && line.startsWith("# "));
  if (h1 < 0) return undefined;
  let blank = 0;
  while (h1 + 1 + blank < end && lines[h1 + 1 + blank] === "") blank++;
  const insert = blank === 0 ? ["", GUIDE_LINE] : [GUIDE_LINE];
  if (blank < 2 && h1 + 1 + blank < end) insert.push("");
  lines.splice(h1 + 1 + Math.min(blank, 1), 0, ...insert);
  return lines.join("\n");
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

// start（スキルのディレクトリ own の中のファイル）の .md の相対リンクの先を辿り、辿った先のファイル（own の外）を返す。辿った先の .md のリンクも辿る。
// 生成するスキルのディレクトリ（skillDirs）の外のファイルは、上流と同じ相対位置で files に足す。別の生成するスキルのディレクトリの中は、
// その中を指すリンクの先の、SKILL.md 以外のファイルだけを辿る（files に入っている。スキルの SKILL.md とディレクトリそのものへのリンクでは止まる）。
// 辿ったファイルは二度辿らないので、リンクが循環していても終わる。
// 生成物の中で解決できないリンク（上流には先があるのに入れられない、上流のルートの外を指す）は dangling に足す
function addLinkedFiles(upstreamDir: string, files: Map<string, Source>, skillDirs: string[], own: string, start: string[], dangling: Set<string>): string[] {
  const linked = new Set<string>();
  const queue = [...start];
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    if (!path.endsWith(".md")) continue;
    for (const [, href] of files.get(path)!.bytes.toString("utf8").matchAll(LINK)) {
      const target = href!.replace(/[#?].*/, "");
      if (target === "" || target.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const resolved = posix.normalize(posix.join(posix.dirname(path), target)).replace(/\/$/, "");
      if (resolved === "." || resolved === ".." || resolved.startsWith("../")) {
        dangling.add(`${path} → ${href}（上流のルートの外を指す）`);
        continue;
      }
      if (!existsSync(join(upstreamDir, resolved))) continue;
      for (const file of walk(upstreamDir, resolved)) {
        if (linked.has(file) || isOtherTeamKitSkill(file) || file.startsWith(`${own}/`)) continue;
        const skill = skillDirs.find((dir) => file.startsWith(`${dir}/`));
        if (skill !== undefined && (file === `${skill}/SKILL.md` || !resolved.startsWith(`${skill}/`))) continue;
        if (!files.has(file)) files.set(file, read(upstreamDir, file));
        linked.add(file);
        queue.push(file);
      }
      if (!inFiles(files, resolved)) dangling.add(`${path} → ${href}（読み込まない cursor-team-kit のスキルを指す）`);
    }
  }
  return [...linked];
}

// path が files のファイルか、files のファイルを含むディレクトリか
function inFiles(files: Map<string, Source>, path: string): boolean {
  return files.has(path) || [...files.keys()].some((file) => file.startsWith(`${path}/`));
}

// 読み替え表が示す生成先の中のパスのうち、生成物に無いもの（generated/ の外を指すものを含む）。表に出てくる順
function missingCopyPaths(table: string, files: Map<string, Source>): string[] {
  const paths = new Set([...table.matchAll(COPY_PATH)].map(([, rel]) => rel!.replace(/\/$/, "")));
  return [...paths]
    .filter((rel) => !rel.startsWith("generated/") || !inFiles(files, rel.slice("generated/".length)))
    .map((rel) => `<X>/${rel}`);
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
