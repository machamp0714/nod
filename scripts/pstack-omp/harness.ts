// 適用と解除。
// 適用は、OMP 向けのディレクトリの中身（content）と生成物（generated。manifest.json とスキルの外のリンク先の文書を含む）を、データ置き場の下の
// pstack-omp/omp に写し（nod のリポジトリや worktree、生成物が消えても動き、読み込む中身を組で固定するように）、写しの harness.json に組の記録
// （写しの全ファイルの sha256 と、設定ファイルを戻すための記録。適用の前の設定ファイルを持つので、利用者だけが読み書きできる）を書き、
// OMP が global の設定として読むファイル（config.yml、無ければ config.yaml。どちらも無ければ config.yml を作る）に3つの読み込みの設定を入れる:
// extensions の末尾に写しの content、skills.customDirectories の先頭に写しの中の生成したスキルの置き場（custom 同士は先が勝つので、pstack の
// tdd が利用者の置き場の tdd より優先される）、skills.manualSkills に読み込む全スキル（一覧から外す。名前で呼べば使える）。
// 既にある値とほかのキーは保ち、自分の項目（写しの中を指すもの）が既にあれば重ねず、設定がそのとおりなら書き換えない。
// pstack は、通常の omp の新しく始めるセッションに入る。pstack 専用の制限は置かない（何を制限するかは別に決める）。
// 写しは読み取り専用にしない。写しは同じ階層の一時ディレクトリに作り終えてから置き換え、設定ファイルは一時ファイルから rename する。
// 途中で失敗したら、写しと設定ファイルを前のままにして止める。
// 解除は、適用の後に設定ファイルが変わっていなければ適用の前のバイトに戻し、変わっていれば管理対象の項目（写しの中を指す extensions・
// skills.customDirectories の項目と、適用が skills.manualSkills に足した名前）だけを外して、適用が作ったキーは空になれば消す。続けて写しを消す。
// 適用と解除は、どちらも初めに config.yml と config.yaml の在るものから前の適用の項目を同じ戻し方で取り除く（tidy）。前の適用の記録は
// 写しの harness.json、無ければ旧管理配置の control/harness.json（version 1 は config.yml に制御の拡張と読み込みの設定を入れた配置で、
// 戻すための記録を持つ。version 2 は専用ランチャーの配置で持たない）。旧管理配置の専用ランチャー（bin/omp）と制御の置き場（control/。
// 制御の拡張・規則・サンドボックスのプロファイル）は、写しの置き換えか削除で消える。記録が無いのに写しの中を指す項目があれば、それは外し、
// skills.manualSkills の名前は外さずに残ったことを知らせる。
// 適用の名前のぶつかりの検査は、取り除いた後に OMP が読むファイルの値で行う。
// 写しが別の OMP の設定の置き場に適用したものなら、適用と解除は何も変えずに止まる（ほかの設定が使っている写しを消さない）。
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
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
  yamlConfigPath,
} from "./config";
import { checkOmpVersion, type Context, type Pin, PstackOmpError, userAgentDir } from "./context";
import { type Definition, packageDefinitions, real, userPlaces, within } from "./places";

// 組の記録（写しの harness.json）
export interface Harness {
  version: 3;
  // 適用した時刻（ISO 8601。表示だけに使う）
  appliedAt: string;
  // 元にした固定の記録と、適用したときの OMP の版
  pin: Pin;
  ompVersion: string;
  // 適用した OMP の設定の置き場（実パス）
  agentDir: string;
  // extensions に入れる写しの OMP 向けのディレクトリ
  content: string;
  // skills.customDirectories の先頭に入れるスキルの置き場（写しの中の生成した pstack と cursor-team-kit）
  skillDirectories: string[];
  // skills.manualSkills に入れるスキル（生成した全スキルと、OMP 向けのディレクトリのスキル）
  manualSkills: string[];
  // 写しの根からの相対パス → sha256（harness.json を除く写しの全ファイル）
  files: Record<string, string>;
  // 解除で設定ファイルを戻すための記録
  config: ConfigRecord;
}

export interface ConfigRecord {
  // 読み込みの設定を書いた設定ファイル（config.yml か config.yaml。リンクなら先）
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

// 適用が設定ファイルに入れる読み込みの設定のキー（skills は2つの親）
const LOADING_KEYS = ["extensions", "skills", "skills.customDirectories", "skills.manualSkills"];
const HARNESS_FILE = "harness.json";
// 旧管理配置の組の記録と、写しの中の専用ランチャーと制御の置き場
const LEGACY_HARNESS = "control/harness.json";
const LEGACY_ENTRIES = ["bin", "control"];
const GENERATED_ROOTS = ["pstack", "cursor-team-kit"] as const;

export interface Paths {
  // 写しの根（データ置き場の下の pstack-omp/omp）
  root: string;
  content: string;
  harness: string;
  // 旧管理配置の組の記録
  legacyHarness: string;
  // 旧管理配置の専用ランチャーと制御の置き場
  legacyEntries: string[];
  // 写しの中の生成したスキルの置き場（GENERATED_ROOTS の順）
  skills: string[];
  // データ置き場の生成物（sync が作る。適用はここを丸ごと写しの generated へ写す）
  generated: string;
}

export function paths(ctx: Context): Paths {
  const workDir = real(ctx.workDir);
  const root = join(workDir, "omp");
  return {
    root,
    content: join(root, "content"),
    harness: join(root, HARNESS_FILE),
    legacyHarness: join(root, LEGACY_HARNESS),
    legacyEntries: LEGACY_ENTRIES.map((name) => join(root, name)),
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

// 組の記録（形は確かめない。旧管理配置の記録も読む）。無い・読めなければ undefined
export function readRecord(path: string): Record<string, unknown> | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isMapping(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

// 形が正しければ記録を、正しくなければ理由を返す
export function parseHarness(raw: unknown): Harness | string {
  if (!isMapping(raw)) return "オブジェクトではありません";
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x !== "");
  if (raw.version !== 3) return `version が 3 ではありません: ${String(raw.version)}`;
  if (typeof raw.appliedAt !== "string" || Number.isNaN(Date.parse(raw.appliedAt))) return "appliedAt が時刻ではありません";
  const pin = raw.pin;
  if (!isMapping(pin) || !["repository", "commit", "pstackVersion", "ompVersion"].every((key) => typeof pin[key] === "string")) return "pin がありません";
  if (typeof raw.ompVersion !== "string") return "ompVersion がありません";
  for (const key of ["content", "agentDir"] as const) {
    const value = raw[key];
    if (typeof value !== "string" || !isAbsolute(value)) return `${key} が絶対パスではありません`;
  }
  if (!strings(raw.skillDirectories) || raw.skillDirectories.length === 0 || !raw.skillDirectories.every((dir) => isAbsolute(dir))) {
    return "skillDirectories が絶対パスの配列ではありません";
  }
  if (!strings(raw.manualSkills) || raw.manualSkills.length === 0) return "manualSkills が名前の配列ではありません";
  const files = raw.files;
  if (!isMapping(files) || Object.keys(files).length === 0) return "files がありません";
  for (const [rel, sha] of Object.entries(files)) {
    if (isAbsolute(rel) || normalize(rel).startsWith("..") || typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) {
      return `files の項目 ${rel} が写しの中の相対パスと sha256 ではありません`;
    }
  }
  if (configRecord(raw, undefined) === undefined) return "config が設定ファイルを戻すための記録ではありません";
  return raw as unknown as Harness;
}

// 写しが組の記録と違うところ（一致すれば空）。読めないファイルやディレクトリも違うところとして返す（例外にしない）
export function copyProblems(root: string, harness: Harness): string[] {
  const problems: string[] = [];
  const realRoot = real(root);
  for (const dir of [harness.content, ...harness.skillDirectories]) {
    // 読み込む中身は写しの中だけ（各ファイルを files の sha256 で確かめる）
    if (!within(dir, realRoot)) problems.push(`組の記録が指すディレクトリ ${dir} が写し（${root}）の外です`);
    else if (!isDirectory(dir)) problems.push(`組の記録が指すディレクトリ ${dir} がありません`);
  }
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

// 写しの全ファイル（harness.json を除く）の、根からの相対パス → sha256。tolerant なら、読めないファイルとディレクトリを null にする
// （tolerant でなければ例外。適用が組の記録を作るとき）
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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// 前の適用の項目を設定ファイルから取り除いた結果
export interface Cleanup {
  // 旧管理配置（旧の記録か、記録の無い写し）からの取り除きか
  legacy: boolean;
  // 書き換えた設定ファイルと書き換え方: restored は記録どおりに前の適用の前のバイトに戻した、recorded は記録の管理対象の項目だけを外した、
  // unrecorded は記録が無いので写しの中を指す項目だけを外した
  changed: { path: string; how: Tidied["how"] }[];
  // 記録が無いので外さず、skills.manualSkills に残した名前（設定ファイルごと）
  kept: { path: string; names: string[] }[];
  // 写しに旧管理配置の専用ランチャーか制御の置き場があったか（写しの置き換えか削除で消える）
  legacyCopy: boolean;
}

export interface ApplyResult {
  root: string;
  // 読み込みの設定を書いた設定ファイル
  configPath: string;
  content: string;
  skillDirectories: string[];
  // 設定ファイルを書き換えたか（3つの読み込みの設定が既にそのとおりなら書き換えない）
  configChanged: boolean;
  cleanup: Cleanup;
  manualSkills: number;
  // 利用者の置き場の tdd（pstack の tdd が優先される）
  userTdd: string[];
}

export function apply(ctx: Context): ApplyResult {
  const agentDir = userAgentDir(ctx);
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
  const content = packageDefinitions(ctx.packageDir).definitions;
  const contentSkills = content.filter((d) => d.kind === "skill").map((d) => d.name);
  if (contentSkills.length === 0) throw new PstackOmpError(`OMP 向けのディレクトリ ${ctx.packageDir} にスキルがありません`);
  const prior = priorRecord(p);
  checkSamePlace(prior.record, agentDir, p);
  const manualSkills = [...generated.names, ...contentSkills.filter((name) => !generated.names.includes(name))];
  const yml = configPath(agentDir);
  const yaml = yamlConfigPath(agentDir);

  // config.yml は、どちらも無ければ作るのでロックを取る
  return withConfigLock(
    yml,
    () =>
      withConfigLock(yaml, () => {
        const tidied = [yml, yaml].map((path) => tidy(readConfig(path), configRecord(prior.record, path), p.root, manualSkills));
        // 書く対象: 取り除いた後に OMP が global の設定として読むファイル（config.yml が在ればそれ、無くて config.yaml が在ればそれ、どちらも無ければ config.yml）
        const target = tidied.find((t) => t.bytes !== undefined) ?? tidied[0]!;
        const settings: OmpConfig = { path: target.config.path, bytes: target.bytes, data: target.data };
        checkLoadingSettings(settings);
        const collisions = findCollisions(ctx, agentDir, settings, p.root, content, generated.names);
        const blocking = collisions.filter((d) => !(d.kind === "skill" && d.name === "tdd"));
        if (blocking.length > 0) {
          throw new PstackOmpError(
            [
              "利用者の置き場に、今回置く定義やスキル（生成したスキルを含む）と同じ名前のものがあります。上書きしないので、適用を止めます（何も変えていません）。",
              ...blocking.map((d) => `  ${d.kind === "agent" ? "エージェント" : "スキル"} ${d.name}: ${d.path}`),
              "名前を変えるか退かしてから、もう一度適用してください。",
            ].join("\n"),
          );
        }

        const loading = { content: p.content, skillDirectories: p.skills, manualSkills };
        const nextData = withEntries(settings, p.root, loading);
        const configChanged = target.config.bytes === undefined || !Bun.deepEquals(nextData, target.config.data, true);
        const next = configChanged ? Buffer.from(stringifyConfig(nextData)) : target.config.bytes!;
        const beforeManual = stringList(settings, "skills.manualSkills") ?? [];
        const harness: Harness = {
          version: 3,
          appliedAt: new Date().toISOString(),
          pin: ctx.pin,
          ompVersion,
          agentDir,
          ...loading,
          files: {},
          config: {
            path: target.config.path,
            before: target.bytes === undefined ? null : target.bytes.toString("base64"),
            after: sha256(next),
            addedKeys: LOADING_KEYS.filter((id) => valueAt(settings.data, id) === undefined || valueAt(settings.data, id) === null),
            addedManualSkills: manualSkills.filter((name) => !beforeManual.includes(name)),
          },
        };
        // 書く対象のほかに取り除きで変わる設定ファイルと、書く対象（変わるときだけ）
        const writes = [
          ...tidied.filter((t) => t !== target && t.changed).map((t) => ({ path: t.config.path, bytes: t.bytes })),
          ...(configChanged ? [{ path: target.config.path, bytes: next }] : []),
        ];
        const legacyCopy = prior.legacy && p.legacyEntries.some((path) => existsSync(path));
        try {
          replaceCopy(ctx, p, harness, writes);
        } catch (e) {
          if (e instanceof PstackOmpError) throw e;
          throw new PstackOmpError(`適用の途中で失敗しました（設定と写しは適用の前のままです）: ${(e as Error).message}`);
        }
        const cleanup = cleanupOf(tidied, prior.legacy, legacyCopy);
        return {
          root: p.root,
          configPath: target.config.path,
          content: p.content,
          skillDirectories: p.skills,
          configChanged,
          // 前の適用（いまの配置）の項目の取り除きは再適用の一部なので、旧管理配置からのときだけ書き換えたことを知らせる
          cleanup: prior.legacy ? cleanup : { ...cleanup, changed: [] },
          manualSkills: manualSkills.length,
          userTdd: collisions.filter((d) => d.kind === "skill" && d.name === "tdd").map((d) => d.path),
        };
      }),
    !existsSync(yaml),
  );
}

// 前の適用の組の記録: 写しの harness.json、無ければ旧管理配置の control/harness.json。legacy は、いまの配置の記録が無いこと（旧の記録も無いときを含む）
function priorRecord(p: Paths): { record: Record<string, unknown> | undefined; legacy: boolean } {
  const current = readRecord(p.harness);
  if (current !== undefined) return { record: current, legacy: false };
  return { record: readRecord(p.legacyHarness), legacy: true };
}

// 既に在る写しの組の記録が、別の OMP の設定の置き場に適用したものなら止める（ほかの設定が使っている写しを消さない）。agentDir はいまの置き場（実パス）
function checkSamePlace(previous: Record<string, unknown> | undefined, agentDir: string, p: Paths): void {
  if (typeof previous?.agentDir !== "string") return;
  const recorded = realAncestor(previous.agentDir);
  if (recorded === agentDir) return;
  throw new PstackOmpError(
    `写し ${p.root} は、別の OMP の設定の置き場 ${recorded} に適用したものです（いまの置き場は ${agentDir}）。写しを消さずに、何も変えずに止めます。` +
      `その置き場を PI_CODING_AGENT_DIR に指定して remove してから、もう一度実行してください`,
  );
}

// 今回置く定義（OMP 向けのディレクトリのエージェント定義とスキル）と生成したスキルの、どれかと同じ名前のものが利用者の置き場にあるか。
// 写し（再適用のときの今回置いたもの）は除く。tdd も返す（呼び出し側が、止めずに報告する）。
// 在るのに読めない定義やスキルのファイルがあれば、同じ名前かを確かめられないので止める
function findCollisions(ctx: Context, agentDir: string, config: OmpConfig, root: string, content: Definition[], generated: string[]): Definition[] {
  const names = new Set([...content.map((d) => `${d.kind}:${d.name}`), ...generated.map((name) => `skill:${name}`)]);
  const places = userPlaces(agentDir, ctx.home, config, root);
  if (places.unreadable.length > 0) {
    throw new PstackOmpError(
      [
        "利用者の置き場に、読めない定義やスキルのファイルがあり、今回置く定義やスキルと同じ名前かを確かめられません。適用を止めます（何も変えていません）。",
        ...places.unreadable.map((path) => `  ${path}`),
        "読めるようにするか退かしてから、もう一度適用してください。",
      ].join("\n"),
    );
  }
  return places.definitions.filter((d) => names.has(`${d.kind}:${d.name}`));
}

// 読み込みの設定の形を確かめる（skills がマッピング、3つが文字列の配列）。正しくなければ止める
function checkLoadingSettings(config: OmpConfig): void {
  const skills = config.data.skills;
  if (skills !== undefined && skills !== null && !isMapping(skills)) {
    throw new PstackOmpError(`OMP の設定 ${config.path} の skills がマッピングではありません。直してから、もう一度実行してください`);
  }
  for (const id of ["extensions", "skills.customDirectories", "skills.manualSkills"]) stringList(config, id);
}

// 組の記録のうち、path の設定ファイルを戻すためのもの（path が undefined なら、どの設定ファイルのものでも）。無い・形が違えば undefined
function configRecord(harness: Record<string, unknown> | undefined, path: string | undefined): ConfigRecord | undefined {
  const record = harness?.config;
  const names = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
  if (
    !isMapping(record) ||
    typeof record.path !== "string" ||
    (path !== undefined && record.path !== path) ||
    (record.before !== null && typeof record.before !== "string") ||
    typeof record.after !== "string" ||
    !names(record.addedKeys) ||
    !names(record.addedManualSkills)
  ) {
    return undefined;
  }
  return record as unknown as ConfigRecord;
}

// 写しの中を指す extensions・skills.customDirectories の項目（形が正しくなければ例外）
export function entriesWithin(config: Pick<OmpConfig, "path" | "data">, root: string): { id: string; entry: string }[] {
  return ["extensions", "skills.customDirectories"].flatMap((id) =>
    (stringList(config, id) ?? []).filter((entry) => within(entry, root)).map((entry) => ({ id, entry })),
  );
}

// 前の適用の項目を取り除いた設定ファイル。bytes と data は取り除いた後（bytes が undefined ならファイルが無い）。how は Cleanup の changed のとおり
interface Tidied {
  config: OmpConfig;
  bytes: Buffer | undefined;
  data: Record<string, unknown>;
  changed: boolean;
  how: "restored" | "recorded" | "unrecorded";
  kept: string[];
}

// 前の適用の項目を設定ファイルから取り除く（ここでは書かない）。記録があり、設定ファイルがその直後のままなら、前の適用の前のバイトに戻す。
// そうでなければ、管理対象の項目（写しの中を指す extensions・skills.customDirectories の項目、記録の足した名前）だけを外し、ほかの値は保つ
// （記録が作ったキーは、外して空になれば消す）。記録が無いのに写しの中を指す項目があれば、skills.manualSkills のうち names（適用が足す名前）は
// 外さず kept で返す
function tidy(config: OmpConfig, record: ConfigRecord | undefined, root: string, names: string[]): Tidied {
  const how = record === undefined ? "unrecorded" : "recorded";
  if (config.bytes === undefined) return { config, bytes: undefined, data: {}, changed: false, how, kept: [] };
  if (record !== undefined && sha256(config.bytes) === record.after) {
    const bytes = record.before === null ? undefined : Buffer.from(record.before, "base64");
    const data = bytes === undefined ? {} : parseConfig(config.path, bytes);
    return { config, bytes, data, changed: bytes === undefined || !bytes.equals(config.bytes), how: "restored", kept: [] };
  }
  const entries = entriesWithin(config, root).length > 0;
  const data = withoutEntries(config, root, record ?? { addedKeys: [], addedManualSkills: [] });
  const changed = !Bun.deepEquals(data, config.data, true);
  const kept = record === undefined && entries ? (stringList(config, "skills.manualSkills") ?? []).filter((name) => names.includes(name)) : [];
  return { config, bytes: changed ? Buffer.from(stringifyConfig(data)) : config.bytes, data, changed, how, kept };
}

function cleanupOf(tidied: Tidied[], legacy: boolean, legacyCopy: boolean): Cleanup {
  return {
    legacy,
    changed: tidied.filter((t) => t.changed).map((t) => ({ path: t.config.path, how: t.how })),
    kept: tidied.filter((t) => t.kept.length > 0).map((t) => ({ path: t.config.path, names: t.kept })),
    legacyCopy,
  };
}

// 設定ファイルに3つの読み込みの設定を入れた形。自分の項目（写しの中を指すもの、足りている名前）が既にあれば重ねない
function withEntries(config: Pick<OmpConfig, "path" | "data">, root: string, loading: Pick<Harness, "content" | "skillDirectories" | "manualSkills">): Record<string, unknown> {
  const extensions = (stringList(config, "extensions") ?? []).filter((entry) => !within(entry, root));
  const customDirectories = (stringList(config, "skills.customDirectories") ?? []).filter((entry) => !within(entry, root));
  const manual = stringList(config, "skills.manualSkills") ?? [];
  return {
    ...config.data,
    // 末尾に写しの OMP 向けのディレクトリ
    extensions: [...extensions, loading.content],
    skills: {
      ...(isMapping(config.data.skills) ? config.data.skills : {}),
      // 生成したスキルの置き場を先頭に置く（custom 同士は先が勝つので、pstack の tdd が利用者の置き場の tdd より優先される）
      customDirectories: [...loading.skillDirectories, ...customDirectories],
      // 読み込むスキルをすべて一覧から外す（名前で呼べば使える）
      manualSkills: [...manual, ...loading.manualSkills.filter((name) => !manual.includes(name))],
    },
  };
}

// 設定ファイルから管理対象の項目を外した形: extensions と skills.customDirectories のうち写しの中を指す項目、skills.manualSkills のうち
// 記録の足した名前。記録が作ったキーは、外して空になれば消す
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

// 設定ファイルの書き換えをすべて準備する（一時ファイルまで）。途中で失敗したら、準備したものを捨てて例外を投げ直す
function prepareAll(writes: { path: string; bytes: Buffer | undefined }[]): PreparedWrite[] {
  const prepared: PreparedWrite[] = [];
  try {
    for (const { path, bytes } of writes) prepared.push(prepareWrite(path, bytes));
  } catch (e) {
    for (const write of prepared) write.discard();
    throw e;
  }
  return prepared;
}

// 写しを一時ディレクトリに作り終えてから置き換え、続けて設定ファイルを置き換える。どこで失敗しても、写しと設定ファイルを前のままにする
function replaceCopy(ctx: Context, p: Paths, harness: Harness, writes: { path: string; bytes: Buffer | undefined }[]): void {
  const workDir = join(p.root, "..");
  const staging = mkdtempSync(join(workDir, ".omp-"));
  let prepared: PreparedWrite[] = [];
  let aside: string | undefined;
  let swapped = false;
  try {
    cpSync(ctx.packageDir, join(staging, "content"), { recursive: true, dereference: false });
    // 生成物を丸ごと（manifest.json とスキルの外のリンク先の文書も）写す。読み替え表が示す <写しの根>/generated/... が写しの中で解決する
    cpSync(p.generated, join(staging, "generated"), { recursive: true, dereference: false });
    harness.files = scan(staging, false) as Record<string, string>;
    // 適用の前の設定ファイルを持つので、利用者だけが読み書きできる
    writeFileSync(join(staging, HARNESS_FILE), JSON.stringify(harness, null, 2) + "\n", { mode: 0o600 });
    prepared = prepareAll(writes);
    if (existsSync(p.root)) {
      // 退かせてから記録する（退かせられなければ、戻すものは無い）
      const old = join(workDir, `.omp-old-${randomBytes(6).toString("hex")}`);
      renameSync(p.root, old);
      aside = old;
    }
    renameSync(staging, p.root);
    swapped = true;
    for (const write of prepared) write.commit();
  } catch (e) {
    for (const write of prepared) write.discard();
    rmSync(swapped ? p.root : staging, { recursive: true, force: true });
    if (aside !== undefined) renameSync(aside, p.root);
    throw e;
  }
  if (aside !== undefined) rmSync(aside, { recursive: true, force: true });
}

export interface RemoveResult {
  root: string;
  cleanup: Cleanup;
  removedCopy: boolean;
}

// 解除。OMP の版は確かめない（版が違っても外せるように）
export function remove(ctx: Context): RemoveResult {
  const agentDir = userAgentDir(ctx);
  const p = paths(ctx);
  const prior = priorRecord(p);
  checkSamePlace(prior.record, agentDir, p);
  // 記録が無いときに skills.manualSkills に残る名前を知らせるための、適用が足す名前
  const names = [
    ...(Array.isArray(prior.record?.manualSkills) ? prior.record.manualSkills.filter((name): name is string => typeof name === "string") : []),
    ...(readGenerated(p.generated)?.names ?? []),
    ...packageDefinitions(ctx.packageDir)
      .definitions.filter((d) => d.kind === "skill")
      .map((d) => d.name),
  ];
  const yml = configPath(agentDir);
  const yaml = yamlConfigPath(agentDir);
  return withConfigLock(yml, () =>
    withConfigLock(yaml, () => {
      const tidied = [yml, yaml].map((path) => tidy(readConfig(path), configRecord(prior.record, path), p.root, names));
      const removedCopy = existsSync(p.root);
      const legacyCopy = prior.legacy && p.legacyEntries.some((path) => existsSync(path));
      let writes: PreparedWrite[] = [];
      let aside: string | undefined;
      try {
        writes = prepareAll(tidied.filter((t) => t.changed).map((t) => ({ path: t.config.path, bytes: t.bytes })));
        if (removedCopy) {
          // 退かせてから記録する（退かせられなければ、戻すものは無い）
          const old = join(p.root, "..", `.omp-old-${randomBytes(6).toString("hex")}`);
          renameSync(p.root, old);
          aside = old;
        }
        for (const write of writes) write.commit();
      } catch (e) {
        for (const write of writes) write.discard();
        if (aside !== undefined) renameSync(aside, p.root);
        throw new PstackOmpError(`解除の途中で失敗しました（設定と写しは解除の前のままです）: ${(e as Error).message}`);
      }
      if (aside !== undefined) rmSync(aside, { recursive: true, force: true });
      return { root: p.root, cleanup: cleanupOf(tidied, prior.legacy, legacyCopy), removedCopy };
    }),
  );
}
