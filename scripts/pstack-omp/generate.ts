// 取得した上流から、OMP 向けに変換したコピーを固定の生成先（データ置き場の下の pstack-omp/generated。nod のリポジトリの外）に生成する。
// 生成の対象は pstack の全スキルのディレクトリと cursor-team-kit の CURSOR_TEAM_KIT_SKILLS のディレクトリ、および rules.yml の include で
// 宣言した文書だけ。上流のルートの配置（pstack/、cursor-team-kit/）を保つので、利用者が OMP の skills.customDirectories に生成先の
// pstack/skills と cursor-team-kit/skills を一度だけ登録すれば、通常の omp がそれぞれの */SKILL.md を生成先から直接読む（登録する値は status が表示する）。
// スキルの外の文書をリンクから辿って取り込むことはしない。
// 変換（入力は transform.ts が読む）:
// 1. forks.yml で宣言したファイルを、上流のファイルの指紋を確かめて、宣言した本文に丸ごと差し替える（本文には規則を当てない）。
// 2. ほかの .md に rules.yml の規則を上から順に、前の規則の出力に対して全箇所を置換する。どの規則も1回以上一致しなければ失敗。
// 3. 生成物のすべての .md（差し替えた本文と include を含む）を denylist.yml の語で行ごとに検査し、当たれば失敗。
// 規則も差し替えも当たらないファイルは、上流と同じバイトと実行属性になる。
// 失敗の理由（読めない入力、include の誤り、指紋の違う・元の無い差し替え、一致しない規則、拒否リストの当たり）は全部集め、検査できなかった範囲と
// 一緒に報告して止める。そのときは生成先に何も書かない。成功したら同じ階層の一時ディレクトリに作り終えてから生成先を丸ごと置き換える
// （通常の omp が生成先を直接読み、status も読むので、失敗で消すと、やり直すまで pstack のスキルが読まれず status も生成物を見失う）。
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { type Context, type Pin, PstackOmpError } from "./context";
import { INPUT_FILES, readTransform, sha256 } from "./transform";

const ROOTS = ["pstack", "cursor-team-kit"] as const;
type Root = (typeof ROOTS)[number];
const CURSOR_TEAM_KIT_SKILLS = ["control-cli", "control-ui", "deslop"];

interface Source {
  bytes: Buffer;
  executable: boolean;
}

export interface RuleCount {
  id: string;
  matches: number;
}

export interface ForkRecord {
  path: string;
  upstreamSha256: string;
  body: string;
  bodySha256: string;
}

export interface Generated {
  dir: string;
  skills: Record<Root, string[]>;
  // 規則ごとの一致数（rules.yml の順）
  rules: RuleCount[];
  // 全文差し替え（forks.yml の順）
  forks: ForkRecord[];
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
  const skills = findSkills(upstreamDir);
  const transform = readTransform(ctx.transformDir);
  const limits = [...transform.limits];

  // 生成するスキルのディレクトリの中のファイル（全文差し替えの対象になれるのはここだけ）
  const files = new Map<string, Source>();
  for (const root of ROOTS) {
    for (const skill of skills[root]) for (const path of walk(upstreamDir, `${root}/skills/${skill}`)) files.set(path, read(upstreamDir, path));
  }
  const inSkills = new Set(files.keys());

  const includeProblems: string[] = [];
  for (const { from, to } of transform.include) {
    const path = join(upstreamDir, from);
    const stat = existsSync(path) ? lstatSync(path) : undefined;
    if (stat === undefined || !stat.isFile()) {
      includeProblems.push(`${from} → ${to}: 上流に ${from} が${stat === undefined ? "ありません" : "ファイルとしてありません"}`);
    } else if (files.has(to) || to === "manifest.json") {
      includeProblems.push(`${from} → ${to}: 生成物の ${to} が既にあります`);
    } else {
      files.set(to, read(upstreamDir, from));
    }
  }
  if (includeProblems.length > 0) limits.push("入れられなかった include の文書には、規則と拒否リストを当てていません");

  // 全文差し替え。上流の元が無くても、本文は拒否リストで検査する（checked に入れる）
  const forkProblems: string[] = [];
  const forked = new Set<string>();
  const forks: ForkRecord[] = [];
  const checked = new Map<string, string>();
  for (const fork of transform.forks ?? []) {
    forked.add(fork.path);
    const path = join(upstreamDir, fork.path);
    const stat = existsSync(path) ? lstatSync(path) : undefined;
    if (stat === undefined || !stat.isFile()) {
      forkProblems.push(`${fork.path}: 上流に元のファイルがありません。上流の変更を確かめて、全文差し替えの宣言と本文を更新してください`);
    } else if (!inSkills.has(fork.path)) {
      forkProblems.push(`${fork.path}: 生成するスキルのディレクトリの外のファイルは差し替えられません`);
    } else {
      const actual = sha256(readFileSync(path));
      if (fork.upstreamSha256 !== undefined && actual !== fork.upstreamSha256) {
        forkProblems.push(
          `${fork.path}: 上流のファイルの指紋 ${actual} が宣言の upstreamSha256 ${fork.upstreamSha256} と違います。上流の変更を確かめて、本文と指紋を更新してください`,
        );
      }
    }
    if (fork.body === undefined) continue;
    checked.set(files.has(fork.path) ? fork.path : `${fork.path}（全文差し替えの本文 ${fork.body.path}）`, fork.body.bytes.toString("utf8"));
    if (files.has(fork.path)) files.get(fork.path)!.bytes = fork.body.bytes;
    if (fork.upstreamSha256 !== undefined) forks.push({ path: fork.path, upstreamSha256: fork.upstreamSha256, body: fork.body.path, bodySha256: fork.body.sha256 });
  }

  // 規則（全文差し替えのファイルを除く .md に、上から順に）
  const targets = [...files.keys()].filter((path) => path.endsWith(".md") && !forked.has(path)).sort();
  const texts = new Map(targets.map((path) => [path, files.get(path)!.bytes.toString("utf8")]));
  const counts: RuleCount[] = [];
  for (const rule of transform.rules ?? []) {
    let matches = 0;
    for (const [path, text] of texts) {
      if (rule.files !== undefined && !rule.files.test(path)) continue;
      if (typeof rule.match === "string") {
        const parts = text.split(rule.match);
        matches += parts.length - 1;
        texts.set(path, parts.join(rule.replace));
      } else {
        matches += [...text.matchAll(rule.match)].length;
        texts.set(path, text.replace(rule.match, rule.replace));
      }
    }
    counts.push({ id: rule.id, matches });
  }
  for (const [path, text] of texts) {
    // 置換で変わらなかったファイルは上流のバイトのまま（UTF-8 として読み直したバイトにしない）
    if (text !== files.get(path)!.bytes.toString("utf8")) files.get(path)!.bytes = Buffer.from(text);
    // 規則を読めなければ、規則を当てる .md は検査しない（limits にある）
    if (transform.rules !== undefined) checked.set(path, text);
  }
  const unmatched = (transform.rules ?? []).filter((_, i) => counts[i]!.matches === 0).map((rule) => `${rule.id}（${rule.reason}）`);

  // 拒否リスト
  const hits: string[] = [];
  for (const path of [...checked.keys()].sort()) {
    checked
      .get(path)!
      .split("\n")
      .forEach((line, i) => {
        for (const term of transform.terms ?? []) {
          for (const [match] of line.matchAll(term.regex)) hits.push(`${path}:${i + 1}: ${term.term}（一致: ${match}）`);
        }
      });
  }

  const sections: [string, string[]][] = [
    [`変換の入力（${ctx.transformDir}）が正しくありません`, transform.problems],
    ["上流から入れる文書（rules.yml の include）に問題があります", includeProblems],
    ["全文差し替え（forks.yml）に問題があります", forkProblems],
    ["どこにも一致しない規則があります（上流の文が変わっていないか確かめ、規則を直してください）", unmatched],
    [`変換の後に拒否リストの語が残っています（${hits.length} か所。規則で書き換えてください）`, hits],
  ];
  if (sections.some(([, list]) => list.length > 0)) {
    const report = [...sections, ["検査できなかった範囲", limits] as [string, string[]]]
      .filter(([, list]) => list.length > 0)
      .flatMap(([title, list]) => [`${title}:`, ...list.map((item) => `  ${item}`)]);
    throw new PstackOmpError([`OMP 向けのコピーを生成できません。生成先 ${generatedDir(ctx)} と利用者の OMP の設定は変えていません。`, ...report].join("\n"));
  }

  // 入力で決まる値だけを、決まった順に書く（同じ入力から同じバイト）
  const manifest = {
    pin: ctx.pin,
    skills,
    transform: Object.fromEntries(INPUT_FILES.map((file) => [file, transform.sha256[file]])),
    rules: counts,
    forks,
  };
  files.set("manifest.json", { bytes: Buffer.from(JSON.stringify(manifest, null, 2) + "\n"), executable: false });
  const dir = generatedDir(ctx);
  replaceDir(ctx.workDir, dir, files);
  return { dir, skills, rules: counts, forks };
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
