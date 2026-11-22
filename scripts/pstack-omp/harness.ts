// 利用者の OMP の設定への適用と解除。
// 適用は、OMP 向けのディレクトリの中身（content）と制御の拡張（control）を、データ置き場の下の pstack-omp/omp に写し
// （nod のリポジトリや worktree が消えても動くように。書き込み権限は外す）、同じ写しの control/harness.json に組の記録を書き、
// 利用者の config.yml の extensions に写しの control を1項目だけ足す。スキルの読み込み先・OMP 向けのディレクトリの登録・
// 一覧から外すスキルの指定は、制御の拡張が組の記録を読んで、セッションごとに実行時の層に入れる（omp/control/index.ts）。
// 写しは同じ階層の一時ディレクトリに作り終えてから置き換え、config.yml は一時ファイルから rename する。途中で失敗したら、
// config.yml と写しを適用の前のままにして止める。
// 解除は config.yml から自分の項目を外し（適用の後に config.yml が変わっていなければ、適用の前のバイトに戻す）、写しを消す。
import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { configPath, type OmpConfig, type PreparedWrite, prepareWrite, readConfig, sha256, stringifyConfig, stringList, withConfigLock } from "./config";
import { checkOmpVersion, type Context, type Pin, PstackOmpError } from "./context";
import { type Definition, packageDefinitions, real, userPlaces } from "./places";

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
  // skills.customDirectories の先頭に足すスキルの置き場（生成した pstack と cursor-team-kit）
  skillDirectories: string[];
  // 一覧から外すスキル（生成した全スキルと、OMP 向けのディレクトリのスキル）
  manualSkills: string[];
  // 写しの根からの相対パス → sha256（harness.json を除く写しの全ファイル）
  files: Record<string, string>;
  // 解除で config.yml を戻すための記録
  config: {
    path: string;
    // 適用の前のバイト（base64）。無かったら null
    before: string | null;
    // 適用の直後のバイトの sha256。解除のときに同じなら before に戻す
    after: string;
    // 適用の前に extensions のキーが無かったか（あれば、解除で自分の項目を外したときに空の配列を残す）
    addedExtensionsKey: boolean;
  };
}

const HARNESS_FILE = "harness.json";
const GENERATED_ROOTS = ["pstack", "cursor-team-kit"] as const;

export interface Paths {
  // 写しの根（データ置き場の下の pstack-omp/omp）
  root: string;
  content: string;
  control: string;
  harness: string;
  generated: string;
}

export function paths(ctx: Context): Paths {
  const workDir = real(ctx.workDir);
  const root = join(workDir, "omp");
  return { root, content: join(root, "content"), control: join(root, "control"), harness: join(root, "control", HARNESS_FILE), generated: join(workDir, "generated") };
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
  control: string;
  configPath: string;
  // config.yml を書き換えたか（既に登録してあれば書き換えない）
  configChanged: boolean;
  manualSkills: number;
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

  const path = configPath(ctx.agentDir);
  return withConfigLock(path, () => {
    const config = readConfig(path);
    const extensions = stringList(config, "extensions");
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

    const registered = (extensions ?? []).some((entry) => real(entry) === p.control);
    const next = registered ? config.bytes! : Buffer.from(stringifyConfig({ ...config.data, extensions: [...(extensions ?? []), p.control] }));
    const harness: Harness = {
      version: 1,
      appliedAt: new Date().toISOString(),
      pin: ctx.pin,
      ompVersion,
      content: p.content,
      control: p.control,
      skillDirectories: generated.dirs,
      manualSkills: [...generated.names, ...contentSkills.filter((name) => !generated.names.includes(name))],
      files: {},
      config: { path, ...configBefore(config, readHarness(p.harness), p.control), after: sha256(next) },
    };
    try {
      replaceCopy(ctx, p, harness, registered ? undefined : next);
    } catch (e) {
      if (e instanceof PstackOmpError) throw e;
      throw new PstackOmpError(`適用の途中で失敗しました（設定と写しは適用の前のままです）: ${(e as Error).message}`);
    }
    return { root: p.root, control: p.control, configPath: path, configChanged: !registered, manualSkills: harness.manualSkills.length };
  });
}

// 今回置く定義（OMP 向けのディレクトリのエージェント定義とスキル）と同じ名前のものが、利用者の置き場にあるか。
// 写し（再適用のときの今回置いたもの）は除く。生成したスキル（tdd など）は止めない（custom ディレクトリの側が優先される）
function findCollisions(ctx: Context, config: OmpConfig, root: string, content: Definition[]): Definition[] {
  const names = new Set(content.map((d) => `${d.kind}:${d.name}`));
  return userPlaces(ctx.agentDir, ctx.home, config, root).definitions.filter((d) => names.has(`${d.kind}:${d.name}`));
}

// 解除で戻す config.yml の記録。前の適用の記録があり、その後 config.yml が変わっていなければ、前の記録を引き継ぐ（最初の適用の前に戻す）
function configBefore(config: OmpConfig, previous: Harness | undefined, control: string): Omit<Harness["config"], "path" | "after"> {
  const current = config.bytes === undefined ? undefined : sha256(config.bytes);
  if (previous?.config.path === config.path && previous.config.after === current) {
    return { before: previous.config.before, addedExtensionsKey: previous.config.addedExtensionsKey };
  }
  const extensions = stringList(config, "extensions");
  if (extensions?.some((entry) => real(entry) === control)) {
    // 前の適用の後に利用者が config.yml を変えた。自分の項目を外した形を、適用の前とみなす
    const addedExtensionsKey = previous?.config.addedExtensionsKey ?? false;
    return { before: Buffer.from(withoutEntry(config, control, addedExtensionsKey)).toString("base64"), addedExtensionsKey };
  }
  return { before: config.bytes === undefined ? null : config.bytes.toString("base64"), addedExtensionsKey: extensions === undefined };
}

// config.yml から自分の項目を外した形
function withoutEntry(config: OmpConfig, control: string, addedExtensionsKey: boolean): string {
  const extensions = (stringList(config, "extensions") ?? []).filter((entry) => real(entry) !== control);
  if (extensions.length > 0 || !addedExtensionsKey) return stringifyConfig({ ...config.data, extensions });
  const rest = { ...config.data };
  delete rest.extensions;
  return stringifyConfig(rest);
}

// 写しを一時ディレクトリに作り終えてから置き換え、続けて config.yml を置き換える（nextConfig が undefined なら変えない）。
// どこで失敗しても、写しと config.yml を前のままにする
function replaceCopy(ctx: Context, p: Paths, harness: Harness, nextConfig: Buffer | undefined): void {
  const workDir = join(p.root, "..");
  const staging = mkdtempSync(join(workDir, ".omp-"));
  let config: PreparedWrite | undefined;
  let aside: string | undefined;
  let swapped = false;
  try {
    cpSync(ctx.packageDir, join(staging, "content"), { recursive: true, dereference: false });
    cpSync(ctx.controlDir, join(staging, "control"), { recursive: true, dereference: false, filter: (src) => relative(ctx.controlDir, src) !== HARNESS_FILE });
    harness.files = hashFiles(staging);
    writeFileSync(join(staging, "control", HARNESS_FILE), JSON.stringify(harness, null, 2) + "\n");
    readOnly(staging);
    chmodSync(staging, 0o755);
    if (nextConfig !== undefined) config = prepareWrite(harness.config.path, nextConfig);
    if (existsSync(p.root)) {
      aside = join(workDir, `.omp-old-${randomBytes(6).toString("hex")}`);
      chmodSync(p.root, 0o755);
      renameSync(p.root, aside);
    }
    renameSync(staging, p.root);
    swapped = true;
    config?.commit();
    chmodSync(p.root, 0o555);
  } catch (e) {
    config?.discard();
    if (swapped) {
      removeTree(p.root);
    } else {
      removeTree(staging);
    }
    if (aside !== undefined) {
      renameSync(aside, p.root);
      chmodSync(p.root, 0o555);
    }
    throw e;
  }
  if (aside !== undefined) removeTree(aside);
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
    const harness = readHarness(p.harness);
    const record = harness?.config.path === path ? harness.config : undefined;
    let next: Buffer | string | undefined = bytes;
    let restoredBytes = false;
    if (record !== undefined && bytes !== undefined && sha256(bytes) === record.after) {
      next = record.before === null ? undefined : Buffer.from(record.before, "base64");
      restoredBytes = true;
    } else if (bytes !== undefined) {
      const config = readConfig(path);
      if ((stringList(config, "extensions") ?? []).some((entry) => real(entry) === p.control)) {
        next = withoutEntry(config, p.control, record?.addedExtensionsKey ?? false);
      }
    }
    const configChanged = next !== bytes;
    const write = configChanged ? prepareWrite(path, next) : undefined;
    const removedCopy = existsSync(p.root);
    let aside: string | undefined;
    try {
      if (removedCopy) {
        aside = join(p.root, "..", `.omp-old-${randomBytes(6).toString("hex")}`);
        chmodSync(p.root, 0o755);
        renameSync(p.root, aside);
      }
      write?.commit();
    } catch (e) {
      write?.discard();
      if (aside !== undefined) {
        renameSync(aside, p.root);
        chmodSync(p.root, 0o555);
      }
      throw new PstackOmpError(`解除の途中で失敗しました（設定と写しは解除の前のままです）: ${(e as Error).message}`);
    }
    if (aside !== undefined) removeTree(aside);
    return { configPath: path, configChanged, restoredBytes, removedCopy };
  });
}

// 写しの全ファイルとディレクトリから書き込み権限を外す。harness.json は利用者だけが読める（適用の前の config.yml を持つため）
function readOnly(dir: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (lstatSync(path).isDirectory()) readOnly(path);
    else chmodSync(path, name === HARNESS_FILE ? 0o400 : statSync(path).mode & 0o555);
  }
  chmodSync(dir, 0o555);
}

// 書き込み権限を戻してから消す
function removeTree(dir: string): void {
  if (!existsSync(dir)) return;
  const writable = (path: string): void => {
    if (!lstatSync(path).isDirectory()) return;
    chmodSync(path, 0o755);
    for (const name of readdirSync(path)) writable(join(path, name));
  };
  writable(dir);
  rmSync(dir, { recursive: true, force: true });
}
