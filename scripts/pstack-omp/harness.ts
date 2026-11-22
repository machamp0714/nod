// 利用者の OMP の設定への適用と解除。
// 適用は、OMP 向けのディレクトリの中身（content）・制御の拡張（control）・生成したスキル（generated/pstack/skills と
// generated/cursor-team-kit/skills）を、データ置き場の下の pstack-omp/omp に写し（nod のリポジトリや worktree、生成物が消えても動き、
// 読み込む中身を組で固定するように）、同じ写しの control/harness.json に組の記録（写しの全ファイルの sha256 を含む）を書き、
// 利用者の config.yml に3つの読み込みの設定を入れる: OMP 向けのディレクトリの登録（extensions に写しの制御の拡張のファイル control/index.ts と
// content）、スキルの読み込み先（skills.customDirectories の先頭に写しの中の生成したスキルの置き場）、一覧から外すスキルの指定
// （skills.manualSkills に読み込む全スキル）。既にある値は保ち、自分の項目が既にあれば重ねない。制御の拡張をディレクトリではなくファイルで
// 書くのは、OMP が設定に書いたファイルの拡張を disabledExtensions で外さないため（プロジェクトの設定で制御だけを外させない）。
// 制御の拡張は、組の記録と規則を検証してから、同じ値と禁止操作を止める規則（control/rules.json）の上書きを、セッションごとに
// 同じ処理で実行時の層にも入れる（omp/control/index.ts）。規則が不正なら、適用は何も変えずに止まる。
// 信頼境界は macOS のサンドボックス（Seatbelt）。適用は写しに、規則の守る集合（rules.ts の guarded）とどのプロジェクトでも書かせない
// パス（projectPaths）への書き込みを拒否するプロファイル（control/sandbox.sb）と、omp の実行ファイルをそのプロファイルで閉じ込めて
// 起動する入口（bin/omp）を置く。どちらも組の記録の sha256 に入る。入口から起動した OMP とその子孫は、規則・読み込み先・OMP の設定・
// omp の実行ファイル・プロジェクトの設定と同じプロセスで動くコードの置き場を書き換えられない（カーネルが拒否し、中から外せない）。
// 入口は omp に制御の拡張のファイルを -e でも渡す（OMP の extensions は層の間で配列を置き換えるので、適用より前から在るプロジェクトの
// 設定が extensions を置き換えても、制御の拡張は読まれる。同じ実ファイルは1度だけ読まれる）。
// 制御の拡張は、閉じ込められていなければ全ツールを遮断する。/usr/bin/sandbox-exec が無ければ、適用は何も変えずに止まる。
// 写しは読み取り専用にしない（同じ利用者の chmod で戻せるので守りにならない）。harness.json は適用の前の config.yml を持つので、利用者だけが読み書きできる。
// 写しは同じ階層の一時ディレクトリに作り終えてから置き換え、config.yml は一時ファイルから rename する。途中で失敗したら、
// config.yml と写しを適用の前のままにして止める。
// 解除は、適用の後に config.yml が変わっていなければ適用の前のバイトに戻す。変わっていれば自分が足したものだけを外し
// （適用の前から在った skills.manualSkills の名前は残す）、適用が作ったキーは空になれば消す。続けて写しを消す。
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  configPath,
  isMapping,
  type OmpConfig,
  parseConfig,
  type PreparedWrite,
  prepareWrite,
  readConfig,
  realAncestor,
  sha256,
  stringifyConfig,
  stringList,
  valueAt,
  withConfigLock,
} from "./config";
import { checkOmpVersion, type Context, ompRealPath, type Pin, PstackOmpError } from "./context";
import { type Definition, packageDefinitions, real, userPlaces, within } from "./places";
import { type Guard, guarded, type Guarded, parseRules, type Rules } from "../../omp/control/rules";

// 組の記録（写しの control/harness.json）。制御の拡張が読む部分の形は omp/control/index.ts と揃える
export interface Harness {
  version: 1;
  // 適用した時刻（ISO 8601）。これより前に始まったプロセスでは、制御の拡張は何もしない
  appliedAt: string;
  // 元にした固定の記録と、適用したときの OMP の版
  pin: Pin;
  ompVersion: string;
  // 写しの中の OMP 向けのディレクトリと制御の拡張
  content: string;
  control: string;
  // 適用した OMP の設定の置き場（規則の {agentDir}）
  agentDir: string;
  // 起動の入口がサンドボックスの中で起動する omp の実行ファイルの実パス（規則の {ompBin}）
  ompBin: string;
  // skills.customDirectories の先頭に入れるスキルの置き場（写しの中の生成した pstack と cursor-team-kit）
  skillDirectories: string[];
  // 一覧から外すスキル（生成した全スキルと、OMP 向けのディレクトリのスキル）
  manualSkills: string[];
  // 写しの根からの相対パス → sha256（harness.json を除く写しの全ファイル）
  files: Record<string, string>;
  // 解除で config.yml を戻すための記録
  config: ConfigRecord;
}

export interface ConfigRecord {
  path: string;
  // 適用の前のバイト（base64）。無かったら null
  before: string | null;
  // 適用の直後のバイトの sha256。解除のときに同じなら before に戻す
  after: string;
  // 適用の前に無く、適用が作ったキー（LOADING_KEYS のうち）。解除で自分の項目を外して空になれば消す
  addedKeys: string[];
  // 適用が skills.manualSkills に足した名前（適用の前から在った名前は、解除で残す）
  addedManualSkills: string[];
}

// 適用が config.yml に入れる読み込みの設定のキー（skills は2つの親）
const LOADING_KEYS = ["extensions", "skills", "skills.customDirectories", "skills.manualSkills"];

const HARNESS_FILE = "harness.json";
export const RULES_FILE = "rules.json";
// 写しの根からの、起動の入口とサンドボックスのプロファイルと、config.yml の extensions に書く（入口が -e で渡す）制御の拡張のファイル
export const LAUNCHER_FILE = "bin/omp";
export const PROFILE_FILE = "control/sandbox.sb";
export const CONTROL_ENTRY = "control/index.ts";
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

// 制御の拡張のディレクトリの規則。無い・読めない・不正なら理由
export function readRules(controlDir: string): Rules | string {
  try {
    return parseRules(JSON.parse(readFileSync(join(controlDir, RULES_FILE), "utf8")));
  } catch (e) {
    return `読めません: ${(e as Error).message}`;
  }
}

const GENERATED_ROOTS = ["pstack", "cursor-team-kit"] as const;

export interface Paths {
  // 写しの根（データ置き場の下の pstack-omp/omp）
  root: string;
  content: string;
  control: string;
  // config.yml の extensions に書き、起動の入口が -e で渡す制御の拡張のファイル
  controlEntry: string;
  harness: string;
  // 起動の入口
  launcher: string;
  // 写しの中の生成したスキルの置き場（GENERATED_ROOTS の順）
  skills: string[];
  // データ置き場の生成物（sync が作る。適用はここから写しへ写す）
  generated: string;
}

export function paths(ctx: Context): Paths {
  const workDir = real(ctx.workDir);
  const root = join(workDir, "omp");
  return {
    root,
    content: join(root, "content"),
    control: join(root, "control"),
    controlEntry: join(root, CONTROL_ENTRY),
    harness: join(root, "control", HARNESS_FILE),
    launcher: join(root, LAUNCHER_FILE),
    skills: GENERATED_ROOTS.map((name) => join(root, "generated", name, "skills")),
    generated: join(workDir, "generated"),
  };
}

export interface Generated {
  pin: Pin;
  names: string[];
  dirs: string[];
}

// 生成物の manifest。無い・読めなければ undefined
export function readGenerated(dir: string): Generated | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { pin: Pin; skills: Record<string, string[]> };
    return {
      pin: manifest.pin,
      names: GENERATED_ROOTS.flatMap((root) => manifest.skills[root] ?? []),
      dirs: GENERATED_ROOTS.map((root) => join(dir, root, "skills")),
    };
  } catch {
    return undefined;
  }
}

export function samePin(a: Pin, b: Pin): boolean {
  return a.repository === b.repository && a.commit === b.commit && a.pstackVersion === b.pstackVersion && a.ompVersion === b.ompVersion;
}

// 写しの組の記録。無い・読めなければ undefined
export function readHarness(path: string): Harness | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Harness;
  } catch {
    return undefined;
  }
}

// 写しの全ファイル（harness.json を除く）の、根からの相対パス → sha256
export function hashFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (rel: string): void => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const path = rel === "" ? name : `${rel}/${name}`;
      const stat = lstatSync(join(root, path));
      if (stat.isDirectory()) visit(path);
      else if (path !== `control/${HARNESS_FILE}`) files[path] = sha256(readFileSync(join(root, path)));
    }
  };
  visit("");
  return files;
}

export interface ApplyResult {
  root: string;
  // config.yml の extensions に入れた制御の拡張のファイル
  controlEntry: string;
  content: string;
  launcher: string;
  configPath: string;
  // config.yml を書き換えたか（3つの読み込みの設定が既にそのとおりなら書き換えない）
  configChanged: boolean;
  manualSkills: number;
}

// 起動の入口の案内（適用と状態の表示で同じ文面）
export function entryGuide(launcher: string): string[] {
  return [
    `起動の入口: ${launcher} から起動してください（omp をサンドボックスで閉じ込め、組の規則・読み込み先・OMP の設定・omp の実行ファイルを書き換えられないようにします）`,
    "  サンドボックスの外で起動したセッション（omp を直接起動したもの）では、制御の拡張が全ツールを遮断し、子も起動させません",
    "  適用中のセッションからは config.yml を保存できません（OMP の設定の変更・apply・remove は、サンドボックスの外の端末で行ってください）",
  ];
}

export function apply(ctx: Context): ApplyResult {
  const ompVersion = checkOmpVersion(ctx);
  const p = paths(ctx);
  const generated = readGenerated(p.generated);
  if (generated === undefined) {
    throw new PstackOmpError(`生成物 ${p.generated} がありません（または manifest.json を読めません）。先に bun scripts/pstack-omp/cli.ts sync を実行してください`);
  }
  if (!samePin(generated.pin, ctx.pin)) {
    throw new PstackOmpError(
      `生成物 ${p.generated} の元にした固定の記録（${generated.pin.commit}）が、いまの固定の記録（${ctx.pin.commit}）と違います。先に bun scripts/pstack-omp/cli.ts sync を実行してください`,
    );
  }
  const missingDirs = generated.dirs.filter((dir) => !existsSync(dir));
  if (missingDirs.length > 0) throw new PstackOmpError(`生成物にスキルの置き場 ${missingDirs.join(", ")} がありません。bun scripts/pstack-omp/cli.ts sync をやり直してください`);
  const content = packageDefinitions(ctx.packageDir);
  const contentSkills = content.filter((d) => d.kind === "skill").map((d) => d.name);
  if (contentSkills.length === 0) throw new PstackOmpError(`OMP 向けのディレクトリ ${ctx.packageDir} にスキルがありません`);
  if (!existsSync(join(ctx.controlDir, "index.ts"))) throw new PstackOmpError(`制御の拡張 ${join(ctx.controlDir, "index.ts")} がありません`);
  const rules = readRules(ctx.controlDir);
  if (typeof rules === "string") throw new PstackOmpError(`制御の規則 ${join(ctx.controlDir, RULES_FILE)} が正しくありません（${rules}）。何も変えずに止めます`);
  if (!existsSync(SANDBOX_EXEC)) throw new PstackOmpError(`${SANDBOX_EXEC} がありません（macOS のサンドボックスで閉じ込められない）。何も変えずに止めます`);
  const ompBin = ompRealPath(ctx);

  const path = configPath(ctx.agentDir);
  return withConfigLock(path, () => {
    const config = readConfig(path);
    checkLoadingSettings(config);
    const collisions = findCollisions(ctx, config, p.root, content);
    if (collisions.length > 0) {
      throw new PstackOmpError(
        [
          "利用者の置き場に、今回置く定義やスキルと同じ名前のものがあります。上書きしないので、適用を止めます（何も変えていません）。",
          ...collisions.map((d) => `  ${d.kind === "agent" ? "エージェント" : "スキル"} ${d.name}: ${d.path}`),
          "名前を変えるか退かしてから、もう一度適用してください。",
        ].join("\n"),
      );
    }

    const manualSkills = [...generated.names, ...contentSkills.filter((name) => !generated.names.includes(name))];
    const loading = { content: p.content, control: p.control, skillDirectories: p.skills, manualSkills };
    const before = configBefore(config, readHarness(p.harness), p.root);
    const beforeManual = stringList({ path, data: before.data }, "skills.manualSkills") ?? [];
    const nextData = withEntries({ path, data: before.data }, loading);
    const changed = !Bun.deepEquals(nextData, config.data, true);
    const next = changed ? Buffer.from(stringifyConfig(nextData)) : config.bytes!;
    const harness: Harness = {
      version: 1,
      appliedAt: new Date().toISOString(),
      pin: ctx.pin,
      ompVersion,
      ...loading,
      agentDir: realAncestor(ctx.agentDir),
      ompBin,
      files: {},
      config: {
        path,
        before: before.bytes,
        after: sha256(next),
        addedKeys: LOADING_KEYS.filter((id) => valueAt(before.data, id) === undefined || valueAt(before.data, id) === null),
        addedManualSkills: manualSkills.filter((name) => !beforeManual.includes(name)),
      },
    };
    try {
      replaceCopy(ctx, p, generated.dirs, harness, rules, changed ? next : undefined);
    } catch (e) {
      if (e instanceof PstackOmpError) throw e;
      throw new PstackOmpError(`適用の途中で失敗しました（設定と写しは適用の前のままです）: ${(e as Error).message}`);
    }
    return { root: p.root, controlEntry: p.controlEntry, content: p.content, launcher: p.launcher, configPath: path, configChanged: changed, manualSkills: manualSkills.length };
  });
}

// 今回置く定義（OMP 向けのディレクトリのエージェント定義とスキル）と同じ名前のものが、利用者の置き場にあるか。
// 写し（再適用のときの今回置いたもの）は除く。生成したスキル（tdd など）は止めない（custom ディレクトリの側が優先される）
function findCollisions(ctx: Context, config: OmpConfig, root: string, content: Definition[]): Definition[] {
  const names = new Set(content.map((d) => `${d.kind}:${d.name}`));
  return userPlaces(ctx.agentDir, ctx.home, config, root).definitions.filter((d) => names.has(`${d.kind}:${d.name}`));
}

// 読み込みの設定の形を確かめる（skills がマッピング、3つが文字列の配列）。正しくなければ止める
function checkLoadingSettings(config: OmpConfig): void {
  const skills = config.data.skills;
  if (skills !== undefined && skills !== null && !isMapping(skills)) {
    throw new PstackOmpError(`OMP の設定 ${config.path} の skills がマッピングではありません。直してから、もう一度実行してください`);
  }
  for (const id of ["extensions", "skills.customDirectories", "skills.manualSkills"]) stringList(config, id);
}

// config.yml に3つの読み込みの設定を入れた形。自分の項目（写しの中を指すもの、記録の名前）が既にあれば重ねない
function withEntries(config: Pick<OmpConfig, "path" | "data">, loading: Pick<Harness, "content" | "control" | "skillDirectories" | "manualSkills">): Record<string, unknown> {
  const root = join(loading.control, "..");
  const extensions = (stringList(config, "extensions") ?? []).filter((entry) => !within(entry, root));
  const customDirectories = (stringList(config, "skills.customDirectories") ?? []).filter((entry) => !within(entry, root));
  const manual = stringList(config, "skills.manualSkills") ?? [];
  return {
    ...config.data,
    // 末尾に写しの制御の拡張のファイルと content
    extensions: [...extensions, join(root, CONTROL_ENTRY), loading.content],
    skills: {
      ...(isMapping(config.data.skills) ? config.data.skills : {}),
      // 生成したスキルの置き場を先頭に置く（custom 同士は先が勝つので、pstack の tdd が利用者の置き場の tdd より優先される）
      customDirectories: [...loading.skillDirectories, ...customDirectories],
      // 読み込むスキルをすべて一覧から外す（名前で呼べば使える）
      manualSkills: [...manual, ...loading.manualSkills.filter((name) => !manual.includes(name))],
    },
  };
}

// config.yml から自分の項目を外した形: extensions と skills.customDirectories のうち写しの中を指す項目、skills.manualSkills のうち
// 適用が足した名前。適用が作ったキーは、外して空になれば消す
function withoutEntries(config: Pick<OmpConfig, "path" | "data">, root: string, record: Pick<ConfigRecord, "addedKeys" | "addedManualSkills">): Record<string, unknown> {
  const data = { ...config.data };
  const skills = isMapping(data.skills) ? { ...data.skills } : undefined;
  const set = (target: Record<string, unknown>, key: string, id: string, list: string[] | undefined): void => {
    if (list === undefined) return;
    if (list.length === 0 && record.addedKeys.includes(id)) delete target[key];
    else target[key] = list;
  };
  set(data, "extensions", "extensions", stringList(config, "extensions")?.filter((entry) => !within(entry, root)));
  if (skills !== undefined) {
    set(skills, "customDirectories", "skills.customDirectories", stringList(config, "skills.customDirectories")?.filter((entry) => !within(entry, root)));
    set(skills, "manualSkills", "skills.manualSkills", stringList(config, "skills.manualSkills")?.filter((name) => !record.addedManualSkills.includes(name)));
    if (Object.keys(skills).length === 0 && record.addedKeys.includes("skills")) delete data.skills;
    else data.skills = skills;
  }
  return data;
}

// 組の記録のうち、path の config.yml を戻すためのもの。無い・形が違えば undefined
function configRecord(harness: Harness | undefined, path: string): ConfigRecord | undefined {
  const record = harness?.config;
  if (record?.path !== path || !Array.isArray(record.addedKeys) || !Array.isArray(record.addedManualSkills)) return undefined;
  return record;
}

// 解除で戻す config.yml の、適用の前の形（バイトと値）。前の適用の記録があり、その後 config.yml が変わっていなければ、前の記録を
// 引き継ぐ（最初の適用の前に戻す）。変わっていて自分の項目が残っていれば、自分の項目を外した形を適用の前とみなす
function configBefore(config: OmpConfig, previous: Harness | undefined, root: string): { bytes: string | null; data: Record<string, unknown> } {
  const record = configRecord(previous, config.path);
  const current = config.bytes === undefined ? undefined : sha256(config.bytes);
  if (record !== undefined && record.after === current) {
    return { bytes: record.before, data: record.before === null ? {} : parseConfig(config.path, Buffer.from(record.before, "base64")) };
  }
  if (["extensions", "skills.customDirectories"].some((id) => (stringList(config, id) ?? []).some((entry) => within(entry, root)))) {
    // 前の適用の後に利用者が config.yml を変え、自分の項目（写しの中を指すもの）が残っている
    const data = withoutEntries(config, root, record ?? { addedKeys: [], addedManualSkills: [] });
    return { bytes: Buffer.from(stringifyConfig(data)).toString("base64"), data };
  }
  return { bytes: config.bytes === undefined ? null : config.bytes.toString("base64"), data: config.data };
}

// 写しを一時ディレクトリに作り終えてから置き換え、続けて config.yml を置き換える（nextConfig が undefined なら変えない）。
// skillSources はデータ置き場の生成したスキルの置き場（p.skills と同じ順）。どこで失敗しても、写しと config.yml を前のままにする
function replaceCopy(ctx: Context, p: Paths, skillSources: string[], harness: Harness, rules: Rules, nextConfig: Buffer | undefined): void {
  const workDir = join(p.root, "..");
  const staging = mkdtempSync(join(workDir, ".omp-"));
  let config: PreparedWrite | undefined;
  let aside: string | undefined;
  let swapped = false;
  try {
    cpSync(ctx.packageDir, join(staging, "content"), { recursive: true, dereference: false });
    cpSync(ctx.controlDir, join(staging, "control"), { recursive: true, dereference: false, filter: (src) => relative(ctx.controlDir, src) !== HARNESS_FILE });
    skillSources.forEach((dir, i) => cpSync(dir, join(staging, relative(p.root, p.skills[i]!)), { recursive: true, dereference: false }));
    // 守る集合は置き換えた後の写しの置き場で解決する（写しの根は {workDir} の下）
    const guard = guarded(rules, { agentDir: harness.agentDir, workDir, ompBin: harness.ompBin, home: ctx.home });
    writeFileSync(join(staging, PROFILE_FILE), profile(guard));
    mkdirSync(join(staging, dirname(LAUNCHER_FILE)));
    writeFileSync(join(staging, LAUNCHER_FILE), launcher(join(p.root, PROFILE_FILE), harness.ompBin, p.controlEntry), { mode: 0o755 });
    harness.files = hashFiles(staging);
    // 適用の前の config.yml を持つので、利用者だけが読み書きできる
    writeFileSync(join(staging, "control", HARNESS_FILE), JSON.stringify(harness, null, 2) + "\n", { mode: 0o600 });
    if (nextConfig !== undefined) config = prepareWrite(harness.config.path, nextConfig);
    if (existsSync(p.root)) {
      // 退かせてから記録する（退かせられなければ、戻すものは無い）
      const old = join(workDir, `.omp-old-${randomBytes(6).toString("hex")}`);
      renameSync(p.root, old);
      aside = old;
    }
    renameSync(staging, p.root);
    swapped = true;
    config?.commit();
  } catch (e) {
    config?.discard();
    rmSync(swapped ? p.root : staging, { recursive: true, force: true });
    if (aside !== undefined) renameSync(aside, p.root);
    throw e;
  }
  if (aside !== undefined) rmSync(aside, { recursive: true, force: true });
}

// サンドボックスのプロファイル: 既定は許し、どのプロジェクトでも書かせないパスへの書き込みを拒否し、その照合から外す置き場を許し、
// 守る集合への書き込み（作成・書き換え・削除・rename・chmod など）を拒否する（Seatbelt は後の規則が勝つ）。
// どのプロジェクトでも書かせないパスは、どのディレクトリの下でも当たる正規表現（ディレクトリならその下も）。
// 守る置き場は規則の種類で（ディレクトリならその下も）、祖先はそのパスだけを拒否する
function profile({ paths, ancestors, projects, allows }: Guarded): string {
  const quote = (path: string) => `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  const filter = ({ path, directory }: Guard) => `(${directory ? "subpath" : "literal"} ${quote(path)})`;
  const regex = ({ path, directory }: Guard) => `(regex #"/${path.replace(/[\\^$.|?*+()[\]{}]/gu, "\\$&")}${directory ? "(/|$)" : "$"}")`;
  return [
    "(version 1)",
    "(allow default)",
    ...projects.map((project) => `(deny file-write* ${regex(project)})`),
    ...allows.map((allow) => `(allow file-write* ${filter(allow)})`),
    ...paths.map((path) => `(deny file-write* ${filter(path)})`),
    ...ancestors.map((path) => `(deny file-write* (literal ${quote(path)}))`),
  ]
    .map((line) => `${line}\n`)
    .join("");
}

// 起動の入口: omp の実行ファイルを、写しのプロファイルで閉じ込めて起動する。制御の拡張のファイルを -e で渡し、続けて引数をそのまま渡す。
// 環境変数は変えない
function launcher(profilePath: string, ompBin: string, controlEntry: string): string {
  const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
  return `#!/bin/sh\n# pstack-omp の起動の入口（bun scripts/pstack-omp/cli.ts apply が書く）\nexec ${SANDBOX_EXEC} -f ${quote(profilePath)} ${quote(ompBin)} -e ${quote(controlEntry)} "$@"\n`;
}

export interface RemoveResult {
  configPath: string;
  configChanged: boolean;
  // config.yml を適用の前のバイトに戻したか（false なら自分の項目だけを外した）
  restoredBytes: boolean;
  removedCopy: boolean;
}

// 解除。OMP の版は確かめない（版が違っても外せるように）
export function remove(ctx: Context): RemoveResult {
  const p = paths(ctx);
  const path = configPath(ctx.agentDir);
  return withConfigLock(path, () => {
    const bytes = existsSync(path) ? readFileSync(path) : undefined;
    const record = configRecord(readHarness(p.harness), path);
    let next: Buffer | string | undefined = bytes;
    let restoredBytes = false;
    if (record !== undefined && bytes !== undefined && sha256(bytes) === record.after) {
      next = record.before === null ? undefined : Buffer.from(record.before, "base64");
      restoredBytes = true;
    } else if (bytes !== undefined) {
      const config = readConfig(path);
      // 記録が無ければ、適用が足した名前は分からないので skills.manualSkills は変えない
      const data = withoutEntries(config, p.root, record ?? { addedKeys: [], addedManualSkills: [] });
      if (!Bun.deepEquals(data, config.data, true)) next = stringifyConfig(data);
    }
    const configChanged = next !== bytes;
    const write = configChanged ? prepareWrite(path, next) : undefined;
    const removedCopy = existsSync(p.root);
    let aside: string | undefined;
    try {
      if (removedCopy) {
        // 退かせてから記録する（退かせられなければ、戻すものは無い）
        const old = join(p.root, "..", `.omp-old-${randomBytes(6).toString("hex")}`);
        renameSync(p.root, old);
        aside = old;
      }
      write?.commit();
    } catch (e) {
      write?.discard();
      if (aside !== undefined) renameSync(aside, p.root);
      throw new PstackOmpError(`解除の途中で失敗しました（設定と写しは解除の前のままです）: ${(e as Error).message}`);
    }
    if (aside !== undefined) rmSync(aside, { recursive: true, force: true });
    return { configPath: path, configChanged, restoredBytes, removedCopy };
  });
}
