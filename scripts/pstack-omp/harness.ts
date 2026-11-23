// 適用と解除。
// 適用は、OMP 向けのディレクトリの中身（content）・制御の拡張（control）・生成物（generated。manifest.json とスキルの外のリンク先の文書を含む）を、
// データ置き場の下の pstack-omp/omp に写し（nod のリポジトリや worktree、生成物が消えても動き、読み込む中身を組で固定するように）、
// サンドボックスのプロファイル（control/sandbox.sb）と専用ランチャー（bin/omp）を置き、同じ写しの control/harness.json に組の記録
// （写しの全ファイルの sha256 を含む。形は omp/control/verify.ts）を書く。利用者の OMP の設定（config.yml）には読み込みの設定を書かない。
// pstack（生成したスキル・読み替え表・poteto-agent）と禁止操作の制御は、専用ランチャーから起動したセッションだけに入る:
// ランチャーは omp を起動する前に、同じプロファイルのサンドボックスの中で組を確かめ（control/preflight.ts を、適用したときの bun で実行する）、
// 通らなければ理由を出して omp を起動しない。通れば omp をそのプロファイルで閉じ込め、制御の拡張のファイルを -e で渡して起動する。
// 制御の拡張は、組をもう一度確かめてから、利用者の設定の実効値を土台に、3つの読み込みの設定と規則の上書きを実行時の層に書く
// （omp/control/index.ts）。通常の omp のセッションは制御の拡張も読み込みの設定も読まないので、pstack は入らない。
// 信頼境界は macOS のサンドボックス（Seatbelt）。プロファイルは、規則の守る集合（rules.ts の guarded）とどのプロジェクトでも書かせない
// パス（projectPaths）への書き込みを拒否する。ランチャーから起動した OMP とその子孫は、規則・読み込み先・OMP の設定・omp と bun の
// 実行ファイル・プロジェクトの設定と同じプロセスで動くコードの置き場を書き換えられない（カーネルが拒否し、中から外せない）。
// 規則が不正なとき、/usr/bin/sandbox-exec が無いときは、適用は何も変えずに止まる。
// 写しは読み取り専用にしない（同じ利用者の chmod で戻せるので守りにならない）。写しは同じ階層の一時ディレクトリに作り終えてから置き換える。
// 以前の配置（config.yml に読み込みの設定を入れた適用）の項目が config.yml に残っていれば、適用と解除はそれだけを取り除く（cleanLegacy）。
// config.yml は一時ファイルから rename し、途中で失敗したら、config.yml と写しを前のままにして止める。
// 写しが別の OMP の設定の置き場に適用したものなら、適用と解除は何も変えずに止まる（ほかの設定が使っている写しを消さない）。
// 解除は、写し（専用ランチャー・制御の拡張・生成物の写し）を消す。
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { configPath, isMapping, type OmpConfig, type PreparedWrite, prepareWrite, readConfig, realAncestor, sha256, stringifyConfig, stringList, withConfigLock } from "./config";
import { checkOmpVersion, type Context, ompRealPath, type Pin, PstackOmpError, userAgentDir } from "./context";
import { type Definition, packageDefinitions, real, userPlaces, within } from "./places";
import { guarded, isRecord, type Rules, sandboxProfile } from "../../omp/control/rules";
import { CONTROL_ENTRY, HARNESS_FILE, type Harness, hashFiles, LAUNCHER_FILE, PREFLIGHT_ENTRY, PROFILE_FILE, readRules, RULES_FILE } from "../../omp/control/verify";

// 以前の配置の組の記録（control/harness.json の config）。config.yml に読み込みの設定を入れた適用が、解除で戻すために書いたもの
interface LegacyRecord {
  path: string;
  // 適用の前のバイト（base64）。無かったら null
  before: string | null;
  // 適用の直後のバイトの sha256
  after: string;
  // 適用の前に無く、適用が作ったキー。自分の項目を外して空になれば消す
  addedKeys: string[];
  // 適用が skills.manualSkills に足した名前
  addedManualSkills: string[];
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
// 専用ランチャーが、在れば（空でも）組の検証（preflight.ts）に渡す、OMP が設定の置き場を決める環境変数
const PREFLIGHT_ENV = ["PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "OMP_PROFILE", "PI_PROFILE"];
const GENERATED_ROOTS = ["pstack", "cursor-team-kit"] as const;

export interface Paths {
  // 写しの根（データ置き場の下の pstack-omp/omp）
  root: string;
  content: string;
  control: string;
  harness: string;
  // 専用ランチャー
  launcher: string;
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
    control: join(root, "control"),
    harness: join(root, HARNESS_FILE),
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

// 写しの組の記録（形は確かめない。以前の配置の記録も読む）。無い・読めなければ undefined
export function readRecord(path: string): Record<string, unknown> | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

// 以前の配置から取り除いた結果
export interface Cleanup {
  // config.yml を書き換えたか（以前の配置の項目が残っていたときだけ）
  changed: boolean;
  // 以前の配置の記録どおりに、以前の適用の前のバイトに戻したか（false なら管理対象の項目だけを外した）
  restoredBytes: boolean;
  // 以前の配置の記録が無いので外さず、skills.manualSkills に残した名前
  kept: string[];
}

export interface ApplyResult {
  root: string;
  launcher: string;
  configPath: string;
  legacy: Cleanup;
  manualSkills: number;
  // 利用者の置き場の tdd（専用ランチャーから起動したセッションでは pstack の tdd が優先される）
  userTdd: string[];
}

// 専用ランチャーの案内（適用と状態の表示で同じ文面）
export function entryGuide(launcher: string): string[] {
  return [
    `専用ランチャー: ${launcher} から起動してください（pstack の生成したスキル・読み替え表・poteto-agent と禁止操作の制御は、このランチャーから起動したセッションだけに読み込まれます。通常の omp には読み込まれません）`,
    "  ランチャーは omp を起動する前に組を確かめ、壊れていれば理由を出して起動しません。起動した omp はサンドボックスに閉じ込め、組の規則・読み込み先・OMP の設定・omp の実行ファイルを書き換えられないようにします",
    "  ランチャーから起動したセッションからは config.yml を保存できません（OMP の設定の変更・apply・remove は、ランチャーの外の端末で行ってください）",
  ];
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
  for (const rel of [CONTROL_ENTRY, PREFLIGHT_ENTRY]) {
    const file = join(ctx.controlDir, relative("control", rel));
    if (!existsSync(file)) throw new PstackOmpError(`制御の拡張の ${file} がありません`);
  }
  const rulesPath = join(ctx.controlDir, relative("control", RULES_FILE));
  const rules = readRules(rulesPath);
  if (typeof rules === "string") throw new PstackOmpError(`制御の規則 ${rulesPath} が正しくありません（${rules}）。何も変えずに止めます`);
  if (!existsSync(SANDBOX_EXEC)) throw new PstackOmpError(`${SANDBOX_EXEC} がありません（macOS のサンドボックスで閉じ込められない）。何も変えずに止めます`);
  const ompBin = ompRealPath(ctx);
  const previous = readRecord(p.harness);
  checkSamePlace(previous, agentDir, p);

  const path = configPath(agentDir);
  return withConfigLock(path, () => {
    const config = readConfig(path);
    checkLoadingSettings(config);
    const collisions = findCollisions(ctx, agentDir, config, p.root, content, generated.names);
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

    const manualSkills = [...generated.names, ...contentSkills.filter((name) => !generated.names.includes(name))];
    const cleanup = cleanLegacy(config, legacyRecord(previous, path), p.root, manualSkills);
    const harness: Harness = {
      version: 2,
      appliedAt: new Date().toISOString(),
      pin: ctx.pin,
      ompVersion,
      content: p.content,
      control: p.control,
      agentDir,
      ompBin,
      bunBin: realpathSync(process.execPath),
      skillDirectories: p.skills,
      manualSkills,
      files: {},
    };
    try {
      replaceCopy(ctx, p, harness, rules, cleanup.write);
    } catch (e) {
      if (e instanceof PstackOmpError) throw e;
      throw new PstackOmpError(`適用の途中で失敗しました（設定と写しは適用の前のままです）: ${(e as Error).message}`);
    }
    return {
      root: p.root,
      launcher: p.launcher,
      configPath: path,
      legacy: cleanup.result,
      manualSkills: manualSkills.length,
      userTdd: collisions.filter((d) => d.kind === "skill" && d.name === "tdd").map((d) => d.path),
    };
  });
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

// 以前の配置の組の記録のうち、path の config.yml を戻すためのもの。無い・形が違えば undefined
function legacyRecord(harness: Record<string, unknown> | undefined, path: string): LegacyRecord | undefined {
  const record = harness?.config;
  if (!isRecord(record) || record.path !== path || typeof record.after !== "string" || !Array.isArray(record.addedKeys) || !Array.isArray(record.addedManualSkills)) {
    return undefined;
  }
  return record as unknown as LegacyRecord;
}

// config.yml に残る以前の配置の項目（表示のため）: extensions と skills.customDirectories のうち写しの中を指すもの、
// 以前の配置の記録が skills.manualSkills に足した名前
export function legacyItems(config: OmpConfig, harness: Record<string, unknown> | undefined, root: string): string[] {
  const record = legacyRecord(harness, config.path);
  return [
    ...["extensions", "skills.customDirectories"].flatMap((id) => (stringList(config, id) ?? []).filter((entry) => within(entry, root)).map((entry) => `${id} の ${entry}`)),
    ...(stringList(config, "skills.manualSkills") ?? []).filter((name) => record?.addedManualSkills.includes(name)).map((name) => `skills.manualSkills の ${name}`),
  ];
}

// 以前の配置の項目を config.yml から取り除く。以前の配置の記録があり、config.yml がその直後のままなら、以前の適用の前のバイトに戻す。
// そうでなければ、管理対象の項目（extensions と skills.customDirectories のうち写しの中を指すもの、記録の名前）だけを外し、ほかの値は保つ
// （記録が作ったキーは、外して空になれば消す）。記録が無ければ、skills.manualSkills のうち names（適用が足す名前）は外さず kept で返す。
// write は書き換える後のバイト（undefined なら config.yml を消す）。取り除くものが無ければ write は undefined
function cleanLegacy(config: OmpConfig, record: LegacyRecord | undefined, root: string, names: string[]): { result: Cleanup; write: { path: string; bytes: Buffer | undefined } | undefined } {
  if (record !== undefined && config.bytes !== undefined && sha256(config.bytes) === record.after) {
    const before = record.before === null ? undefined : Buffer.from(record.before, "base64");
    return { result: { changed: true, restoredBytes: true, kept: [] }, write: { path: config.path, bytes: before } };
  }
  const entries = ["extensions", "skills.customDirectories"].some((id) => (stringList(config, id) ?? []).some((entry) => within(entry, root)));
  const data = withoutEntries(config, root, record ?? { addedKeys: [], addedManualSkills: [] });
  const changed = !Bun.deepEquals(data, config.data, true);
  const kept = record === undefined && entries ? (stringList(config, "skills.manualSkills") ?? []).filter((name) => names.includes(name)) : [];
  return { result: { changed, restoredBytes: false, kept }, write: changed ? { path: config.path, bytes: Buffer.from(stringifyConfig(data)) } : undefined };
}

// config.yml から管理対象の項目を外した形: extensions と skills.customDirectories のうち写しの中を指す項目、skills.manualSkills のうち
// 以前の配置の記録が足した名前。記録が作ったキーは、外して空になれば消す
function withoutEntries(config: Pick<OmpConfig, "path" | "data">, root: string, record: Pick<LegacyRecord, "addedKeys" | "addedManualSkills">): Record<string, unknown> {
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

// 写しを一時ディレクトリに作り終えてから置き換え、続けて config.yml を置き換える（config が undefined なら変えない）。
// どこで失敗しても、写しと config.yml を前のままにする
function replaceCopy(ctx: Context, p: Paths, harness: Harness, rules: Rules, config: { path: string; bytes: Buffer | undefined } | undefined): void {
  const workDir = join(p.root, "..");
  const staging = mkdtempSync(join(workDir, ".omp-"));
  let write: PreparedWrite | undefined;
  let aside: string | undefined;
  let swapped = false;
  try {
    cpSync(ctx.packageDir, join(staging, "content"), { recursive: true, dereference: false });
    cpSync(ctx.controlDir, join(staging, "control"), { recursive: true, dereference: false, filter: (src) => join("control", relative(ctx.controlDir, src)) !== HARNESS_FILE });
    // 生成物を丸ごと（manifest.json とスキルの外のリンク先の文書も）写す。読み替え表が示す <写しの根>/generated/... が写しの中で解決する
    cpSync(p.generated, join(staging, "generated"), { recursive: true, dereference: false });
    // 守る集合は置き換えた後の写しの置き場で解決する（写しの根は {workDir} の下）
    const guard = guarded(rules, { agentDir: harness.agentDir, workDir, ompBin: harness.ompBin, bunBin: harness.bunBin, home: ctx.home });
    writeFileSync(join(staging, PROFILE_FILE), sandboxProfile(guard));
    mkdirSync(join(staging, dirname(LAUNCHER_FILE)));
    writeFileSync(join(staging, LAUNCHER_FILE), launcher(p.root, harness), { mode: 0o755 });
    harness.files = hashFiles(staging);
    writeFileSync(join(staging, HARNESS_FILE), JSON.stringify(harness, null, 2) + "\n");
    if (config !== undefined) write = prepareWrite(config.path, config.bytes);
    if (existsSync(p.root)) {
      // 退かせてから記録する（退かせられなければ、戻すものは無い）
      const old = join(workDir, `.omp-old-${randomBytes(6).toString("hex")}`);
      renameSync(p.root, old);
      aside = old;
    }
    renameSync(staging, p.root);
    swapped = true;
    write?.commit();
  } catch (e) {
    write?.discard();
    rmSync(swapped ? p.root : staging, { recursive: true, force: true });
    if (aside !== undefined) renameSync(aside, p.root);
    throw e;
  }
  if (aside !== undefined) rmSync(aside, { recursive: true, force: true });
}

// 専用ランチャー: まず同じプロファイルのサンドボックスの中で、適用したときの bun で組を確かめる（control/preflight.ts）。
// bun の動きを変えるもの（BUN_OPTIONS の --preload など）を検証に持ち込ませないため、preflight は利用者の環境変数を引き継がず、
// HOME・TMPDIR・PATH と、在れば（空でも）PI_CODING_AGENT_DIR・PI_CONFIG_DIR・OMP_PROFILE・PI_PROFILE（OMP が設定の置き場を決める環境変数）
// だけを渡して起動する（XDG_CONFIG_HOME も渡さないので、bun の全体の設定は規則で守る {home}/.bunfig.toml だけになる）。
// 作業中のプロジェクトの .env と bunfig.toml を読ませないため、写しの control を作業ディレクトリにし、.env の自動の読み込みを止め、
// 呼んだディレクトリと、続けて omp に渡す引数をそのまま渡す（preflight は、引数の --profile と環境変数で OMP の設定の置き場を決め、
// 呼んだディレクトリと引数の --cwd の全部の値を作業ディレクトリとして試す）。プロファイル・bun・preflight.ts の
// どれかが無い、または組が正しくなければ、理由を出して非0で終わり、omp を起動しない。通れば、omp の実行ファイルをそのプロファイルで
// 閉じ込め、制御の拡張のファイルを -e で渡し、続けて引数をそのまま渡して起動する。omp の起動の環境変数は変えない
function launcher(root: string, harness: Harness): string {
  const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
  const profilePath = quote(join(root, PROFILE_FILE));
  return [
    "#!/bin/sh",
    "# pstack-omp の専用ランチャー（bun scripts/pstack-omp/cli.ts apply が書く）",
    'cwd=$(pwd) || exit 1',
    `if ! (cd ${quote(join(root, "control"))} && exec /usr/bin/env -i HOME="$HOME" TMPDIR="\${TMPDIR:-/tmp}" PATH="$PATH" ${PREFLIGHT_ENV.map((name) => `\${${name}+"${name}=$${name}"}`).join(" ")} ${SANDBOX_EXEC} -f ${profilePath} ${quote(harness.bunBin)} --no-env-file ${quote(join(root, PREFLIGHT_ENTRY))} "$cwd" "$@"); then`,
    `  echo ${quote(`pstack-omp: 組を確かめられないので、omp を起動しません（${join(root, LAUNCHER_FILE)}。bun scripts/pstack-omp/cli.ts status で確かめてください）`)} >&2`,
    "  exit 1",
    "fi",
    `exec ${SANDBOX_EXEC} -f ${profilePath} ${quote(harness.ompBin)} -e ${quote(join(root, CONTROL_ENTRY))} "$@"`,
    "",
  ].join("\n");
}

export interface RemoveResult {
  configPath: string;
  legacy: Cleanup;
  removedCopy: boolean;
}

// 解除。OMP の版は確かめない（版が違っても外せるように）
export function remove(ctx: Context): RemoveResult {
  const agentDir = userAgentDir(ctx);
  const p = paths(ctx);
  const previous = readRecord(p.harness);
  checkSamePlace(previous, agentDir, p);
  const path = configPath(agentDir);
  return withConfigLock(path, () => {
    const config = readConfig(path);
    // 記録が無いときに skills.manualSkills に残る名前を知らせるための、適用が足す名前
    const names = [
      ...(Array.isArray(previous?.manualSkills) ? previous.manualSkills.filter((name): name is string => typeof name === "string") : []),
      ...(readGenerated(p.generated)?.names ?? []),
      ...packageDefinitions(ctx.packageDir)
        .definitions.filter((d) => d.kind === "skill")
        .map((d) => d.name),
    ];
    const cleanup = cleanLegacy(config, legacyRecord(previous, path), p.root, names);
    const write = cleanup.write === undefined ? undefined : prepareWrite(cleanup.write.path, cleanup.write.bytes);
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
    return { configPath: path, legacy: cleanup.result, removedCopy };
  });
}
