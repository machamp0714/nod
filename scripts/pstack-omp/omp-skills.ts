// 通常の omp（OMP 19.1.0）のセッションが実行したディレクトリで読むスキルを、OMP と同じ置き場・読み込みの条件・順で集める（状態の表示のため。
// 読むだけで何も書かない）。出典は @oh-my-pi/pi-coding-agent@19.1.0 の src/extensibility/skills.ts の loadSkills・resolveCollision、
// src/capability/index.ts の registerProvider・filterProviders・isUserSourceEnabled、src/discovery の各 provider の loadSkills
// （builtin.ts・omp-plugins.ts・omp-extension-roots.ts・claude.ts・agents.ts・codex.ts・opencode.ts・github.ts）と helpers.ts の
// scanSkillsFromDir・getProjectDiscoveryCeilings・isUserConfigRoot・isForeignUserConfigRoot、src/capability/fs.ts の findRepoRoot・readFile、
// src/config/settings.ts の resolvePathScopedArray、src/extensibility/settings.ts の skills.* の既定値、@oh-my-pi/pi-utils@19.1.0 の
// parseFrontmatter（原文は Document 1683・1730・1745 に写した）。ここがまねる範囲で、固定の記録の OMP の版 19.2.1 が 19.1.0 と違うのは
// disabledProviders・enabledProviders を path で範囲指定したときの範囲の判定（範囲の中の .. で始まる名前のディレクトリを範囲内とするか）
// だけで、そこは 19.2.1 に合わせた（pathScoped）。
//
// 設定は OMP がいま global の設定として読むファイル（config.yml、無ければ config.yaml）の値だけで決める。プロジェクトの設定
// （.omp/config.yml・.claude/settings.json など）の層は見ない。
//
// 中を調べない読み込み元: プラグインの登録や入れたパッケージから読むスキル（入れた npm・link のプラグイン <plugins>/node_modules、
// Claude Code・OMP・プロジェクトのプラグインの登録 installed_plugins.json、Agent Plugins の形のパッケージ（根に plugin.json）、
// skillshare の skills.lock.json）は、どのスキルを読むかがプラグインの登録・マニフェスト・有効・無効の記録で決まるので、ここでは読み込みを
// まねず、在れば unexamined に入れて呼び出し側に知らせる（その provider が裸の名前を取りうるときに、調べていないことを表示するため）。
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { OmpConfig } from "./config";
import { isMapping, stringList, valueAt } from "./config";
import { parseFrontmatter } from "./frontmatter";
import { expand, real, within } from "./places";

// OMP 19.1.0 のスキルの provider を、読み込む順（priority の高い順。同じなら登録の順: src/discovery/index.ts の import の順）に並べたもの。
// native 100、skillshare 95、omp-plugins 90、claude 80、agent-plugins 75、claude-plugins・agents・codex 70、opencode 55、github 30、
// omp-managed（auto-learn の managed skills）5
const PROVIDERS = ["native", "skillshare", "omp-plugins", "claude", "agent-plugins", "claude-plugins", "agents", "codex", "opencode", "github", "omp-managed"] as const;
export type Provider = (typeof PROVIDERS)[number];

// 利用者の置き場（~/...）を enabledProviders などで有効にしたときだけ読む provider（src/capability/index.ts の FOREIGN_USER_PROVIDERS）
const FOREIGN_USER: Record<string, true> = { cursor: true, codex: true, claude: true, "claude-plugins": true, gemini: true, opencode: true, windsurf: true, github: true };

// managed（auto-learn）のスキルとして読む名前（src/autolearn/managed-skills.ts の SKILL_NAME_PATTERN）
const MANAGED_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

// 通常の omp が読むスキル。source は読んだ provider か、skills.customDirectories（custom）。project はプロジェクトの置き場（level が project）のものか
export interface OmpSkill {
  name: string;
  path: string;
  source: Provider | "custom";
  project: boolean;
}

export interface OmpSkills {
  // skills.enabled（false ならスキルを1つも読まない）
  enabled: boolean;
  // skills.includeSkills（空でなければ、合う名前のスキルだけが一覧に残る）
  includeSkills: string[];
  // disabledExtensions の skill:<名前> の名前（その名前のスキルは読まない。bareSkill が理由として返すので、skills には残す）
  disabledSkills: string[];
  // 読むスキル（skills.ignoredSkills に合うものを除く）を、同じ名前がぶつかったときに裸の名前を取る順に並べたもの
  // （custom の配列の順、provider の順、omp-managed は最後）
  skills: OmpSkill[];
  // 読む置き場に在るのに読めない SKILL.md（OMP は読み飛ばす。名前を確かめられない）
  unreadable: { path: string; project: boolean }[];
  // 中を調べない読み込み元（冒頭のとおり）と、それを読む provider のうち最も先に読むもの
  unexamined: { path: string; provider: Provider }[];
}

// 通常の omp のセッションが cwd（実行したディレクトリ）で読むスキル。config は OMP がいま global の設定として読むファイル。ours（生成先と
// OMP 向けのディレクトリ）を渡せば、その下の skills.customDirectories・extensions は数えない（それらを除いた利用者の置き場を選ぶとき。
// 空なら、それらの項目も OMP と同じく数える）。
// env は OMP と同じ環境変数（CLAUDE_CONFIG_DIR）。値の形が正しくない skills.customDirectories・extensions は例外にする（呼び出し側が報告する）
export function normalOmpSkills(
  agentDir: string,
  home: string,
  config: OmpConfig,
  ours: string[],
  cwd: string,
  env: Record<string, string | undefined>,
): OmpSkills {
  const flag = (key: string, fallback: boolean): boolean => {
    const value = valueAt(config.data, `skills.${key}`);
    return typeof value === "boolean" ? value : fallback;
  };
  const mine = (dir: string) => !ours.some((our) => within(dir, our));
  const customDirectories = (stringList(config, "skills.customDirectories") ?? []).map((dir) => expand(dir, home)).filter(mine);
  const extensions = (stringList(config, "extensions") ?? []).map((dir) => expand(dir, home)).filter(mine);
  const result: OmpSkills = {
    enabled: flag("enabled", true),
    includeSkills: strings(valueAt(config.data, "skills.includeSkills")),
    disabledSkills: strings(valueAt(config.data, "disabledExtensions")).filter((id) => id.startsWith("skill:")).map((id) => id.slice(6)),
    skills: [],
    unreadable: [],
    unexamined: [],
  };
  if (!result.enabled) return result;

  // OMP の LoadContext: cwd は process.cwd()（呼び出し側の実行したディレクトリ）、home は os.homedir()、repoRoot は findRepoRoot(cwd)
  const dir = resolve(cwd);
  const repoRoot = findRepoRoot(dir);
  const disabled = new Set(pathScoped(config, "disabledProviders", dir, home));
  const enabledProviders = new Set(pathScoped(config, "enabledProviders", dir, home));
  const ignored = strings(valueAt(config.data, "skills.ignoredSkills"));
  // isUserSourceEnabled: disabledProviders に入っていれば読まない。外国の道具の利用者の置き場は enabledProviders（* と all を含む）で有効にしたときだけ
  const userSource = (id: string): boolean => {
    if (disabled.has(id)) return false;
    if (FOREIGN_USER[id] !== true) return true;
    if (enabledProviders.has(id) || enabledProviders.has("*") || enabledProviders.has("all")) return true;
    if (id === "claude-plugins" && enabledProviders.has("claude")) return true;
    return id === "claude" && Boolean(env.CLAUDE_CONFIG_DIR?.trim());
  };
  const claudeDir = env.CLAUDE_CONFIG_DIR?.trim() ? resolve(env.CLAUDE_CONFIG_DIR.trim()) : join(home, ".claude");
  const pluginsDir = join(home, ".omp", "plugins");
  const native = nativeProjectDirs(dir, repoRoot, home, agentDir);
  const walked = walkedProjectDirs(dir, repoRoot, home);

  // 読む置き場（provider の中では、その provider が読む順）。on は isSourceEnabled（skills.enable* の既定値は src/extensibility/settings.ts）。
  // OMP と同じく provider のスキル、custom directory、omp-managed の順に読み、同じファイル（リンクで別の置き場から見えるもの）は先に読んだものだけにする
  type Place = { dir: string; source: Provider | "custom"; project: boolean; requireDescription: boolean; on: boolean };
  const place = (source: Place["source"], project: boolean, requireDescription: boolean, on: boolean) => (d: string): Place => ({ dir: d, source, project, requireDescription, on });
  const packages = extensions.filter((d) => isDirectoryPath(d));
  const places: Place[] = [
    ...native.map((d) => join(d, ".omp", "skills")).map(place("native", true, true, flag("enablePiProject", true))),
    place("native", false, true, flag("enablePiUser", true))(join(agentDir, "skills")),
    // extensions のパッケージのうち、根に plugin.json の無いもの（在れば Agent Plugins の形の判定が要るので、下で中を調べない読み込み元にする）
    ...packages.filter((d) => !existsSync(join(d, "plugin.json"))).map((d) => join(d, "skills")).map(place("omp-plugins", false, true, userSource("omp-plugins"))),
    // claude は利用者の置き場（~/.claude/skills。CLAUDE_CONFIG_DIR で変わる）を先に、プロジェクトの各祖先の .claude/skills を後に読む
    ...(flag("enableClaudeUser", false) || userSource("claude") ? [place("claude", false, false, true)(join(claudeDir, "skills"))] : []),
    ...walked.map((d) => join(d, ".claude", "skills")).map(place("claude", true, false, flag("enableClaudeProject", true))),
    ...walked.flatMap((d) => [".agent", ".agents"].map((name) => join(d, name, "skills"))).map(place("agents", true, false, flag("enableAgentsProject", true))),
    ...[".agent", ".agents"].map((name) => join(home, name, "skills")).map(place("agents", false, false, flag("enableAgentsUser", true))),
    ...(flag("enableCodexUser", false) || userSource("codex") ? [place("codex", false, false, true)(join(home, ".codex", "skills"))] : []),
    place("codex", true, false, true)(join(dir, ".codex", "skills")),
    ...(userSource("opencode") ? [place("opencode", false, false, true)(join(home, ".config", "opencode", "skills"))] : []),
    place("opencode", true, false, true)(join(dir, ".opencode", "skills")),
    place("github", true, true, true)(join(dir, ".github", "skills")),
    ...customDirectories.map(place("custom", false, true, true)),
    place("omp-managed", false, true, true)(join(agentDir, "managed-skills")),
  ];
  const loaded = new Set<string>();
  const custom: OmpSkill[] = [];
  for (const p of places) {
    if (!p.on || (p.source !== "custom" && disabled.has(p.source))) continue;
    const scanned = scanSkills(p.dir, p.requireDescription);
    for (const path of scanned.unreadable) result.unreadable.push({ path, project: p.project });
    for (const { name, path } of scanned.skills) {
      if (ignored.some((pattern) => new Bun.Glob(pattern).match(name))) continue;
      if (p.source === "omp-managed" && !MANAGED_NAME.test(name)) continue;
      const key = real(path);
      if (loaded.has(key)) continue;
      loaded.add(key);
      (p.source === "custom" ? custom : result.skills).push({ name, path, source: p.source, project: p.project });
    }
  }
  // custom directory のスキルは provider のスキルより優先する（resolveCollision）ので先に並べる
  result.skills.unshift(...custom);

  // 中を調べない読み込み元。読む provider がすべて disabledProviders に入っていれば数えない
  const unexamined = (path: string, providers: Provider[]): void => {
    const provider = providers.find((id) => !disabled.has(id));
    if (provider !== undefined) result.unexamined.push({ path, provider });
  };
  for (const lock of [join(agentDir, "skills.lock.json"), ...native.map((d) => join(d, ".omp", "skills.lock.json"))]) {
    if (existsSync(lock)) unexamined(lock, ["skillshare"]);
  }
  for (const modules of [join(pluginsDir, "node_modules"), ...native.map((d) => join(d, ".omp", "plugins", "node_modules"))]) {
    let names: string[] = [];
    try {
      names = readdirSync(modules);
    } catch {
      // 無いか読めなければ、入れたプラグインは無いとみなす
    }
    if (names.length > 0) unexamined(modules, ["omp-plugins", "agent-plugins"]);
  }
  for (const d of packages.filter((d) => existsSync(join(d, "plugin.json")))) unexamined(d, ["agent-plugins"]);
  for (const registry of [join(claudeDir, "plugins", "installed_plugins.json"), join(pluginsDir, "installed_plugins.json"), ...native.map((d) => join(d, ".omp", "plugins", "installed_plugins.json"))]) {
    if (existsSync(registry)) unexamined(registry, ["agent-plugins", "claude-plugins"]);
  }
  return result;
}

// 通常の omp で裸の名前 name を取るスキル（OMP 19.1.0 の resolveCollision: custom directory のスキルは provider のスキルより優先、それ以外は
// 先に読んだもの。omp-managed は、ほかに同じ名前が無いときだけ）。裸の名前のスキルが無い理由が設定にあれば reason（skills.enabled、
// disabledExtensions、skills.includeSkills。includeSkills は最後の名前に当てるので、合わなければ裸の名前のスキルは一覧に残らない）。
// unexamined は、選んだものより先に裸の名前を取りうる、中を調べない読み込み元（skillshare は入れたスキルなので、書いたスキルには負ける）
export function bareSkill(skills: OmpSkills, name: string): { skill?: OmpSkill; reason?: string; unexamined: string[] } {
  if (!skills.enabled) return { reason: "OMP の設定の skills.enabled が false なので、通常の omp はスキルを読み込みません", unexamined: [] };
  if (skills.disabledSkills.includes(name)) return { reason: `OMP の設定の disabledExtensions に skill:${name} があるので、通常の omp は ${name} を読み込みません`, unexamined: [] };
  if (skills.includeSkills.length > 0 && !skills.includeSkills.some((pattern) => new Bun.Glob(pattern).match(name))) {
    return { reason: `OMP の設定の skills.includeSkills に ${name} が合わないので、通常の omp の一覧に ${name} は残りません`, unexamined: [] };
  }
  const skill = skills.skills.find((s) => s.name === name);
  const unexamined =
    skill?.source === "custom"
      ? []
      : skills.unexamined
          .filter(
            (u) =>
              skill === undefined ||
              skill.source === "omp-managed" ||
              (u.provider !== "skillshare" && PROVIDERS.indexOf(u.provider) < PROVIDERS.indexOf(skill.source as Provider)),
          )
          .map((u) => u.path);
  return { skill, unexamined };
}

// OMP の findRepoRoot: dir から根まで遡って、最初に .git（ファイルでもディレクトリでも）が在るディレクトリ。無ければ undefined
export function findRepoRoot(dir: string): string | undefined {
  for (let current = dir; ; current = dirname(current)) {
    try {
      lstatSync(join(current, ".git"));
      return current;
    } catch {
      if (dirname(current) === current) return undefined;
    }
  }
}

// native（.omp/skills）と skillshare・プラグインの登録が読むプロジェクトの祖先（src/discovery/builtin.ts の getProjectAncestorDirs）:
// 実行したディレクトリから repoRoot（無ければホーム）まで、近い順。ホーム・os.tmpdir()・/tmp・/var/tmp（とそれより上）には入らない。
// ホームと利用者の設定の根（<dir>/.omp が ~/.omp）は飛ばす。repoRoot が無ければ、いまの設定の置き場でない <dir>/.omp/agent を持つ祖先も飛ばす。
// パスは別名を解いて比べる（normalizePathForComparison）
function nativeProjectDirs(dir: string, repoRoot: string | undefined, home: string, agentDir: string): string[] {
  const realHome = real(home);
  const ceilings = new Set([realHome, real(tmpdir()), real("/tmp"), real("/var/tmp")]);
  const stop = real(repoRoot ?? home);
  const dirs: string[] = [];
  for (let current = dir; ; current = dirname(current)) {
    const normalized = real(current);
    if (ceilings.has(normalized)) break;
    const userRoot = normalized === realHome || real(join(current, ".omp")) === real(join(home, ".omp"));
    const foreign = repoRoot === undefined && isDirectoryPath(join(current, ".omp", "agent")) && real(join(current, ".omp", "agent")) !== real(agentDir);
    if (!userRoot && !foreign) dirs.push(current);
    if (normalized === stop || dirname(current) === current) break;
  }
  return dirs;
}

// claude（.claude/skills）と agents（.agent/skills・.agents/skills）が読むプロジェクトの祖先（src/discovery/claude.ts の loadSkills、
// agents.ts の getProjectPathCandidates）: 実行したディレクトリから repoRoot（無ければホーム）まで、近い順。ホームは飛ばす。
// OMP と同じく、パスは書いたままの形で比べる（別名を解かない）
function walkedProjectDirs(dir: string, repoRoot: string | undefined, home: string): string[] {
  const dirs: string[] = [];
  for (let current = dir; ; current = dirname(current)) {
    if (current !== home) dirs.push(current);
    if (current === (repoRoot ?? home) || dirname(current) === current) break;
  }
  return dirs;
}

// path で範囲を決められる配列の設定（disabledProviders・enabledProviders）を、実行したディレクトリ（cwd）で解いた値。OMP 19.1.0 の
// src/config/settings.ts の resolvePathScopedArray と同じく、文字列はそのまま、オブジェクトは path・paths・pathPrefix・pathPrefixes のどれかが
// cwd そのものかその祖先を指せば、values・items・providers の文字列を足す（前置きの無いオブジェクトは足さない）。配列でなければ何も無い。
// 範囲の判定は OMP 19.2.1 の pi-utils の relativePathWithinNormalizedRoot に合わせ、相対パスが .. そのものか .. と区切り文字で始まるか
// 絶対パスのときだけを範囲外とする（..work のような .. で始まる名前の子は範囲内）
function pathScoped(config: OmpConfig, id: string, cwd: string, home: string): string[] {
  const value = valueAt(config.data, id);
  if (!Array.isArray(value)) return [];
  const covers = (prefix: string): boolean => {
    const rel = relative(expand(prefix, home), cwd);
    return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
  };
  return value.flatMap((entry: unknown) => {
    if (typeof entry === "string") return [entry];
    if (!isMapping(entry)) return [];
    const prefixes = [...strings(entry.path), ...strings(entry.paths), ...strings(entry.pathPrefix), ...strings(entry.pathPrefixes)];
    return prefixes.some(covers) ? [...strings(entry.values), ...strings(entry.items), ...strings(entry.providers)] : [];
  });
}

// 文字列か文字列の配列の値（src/config/settings.ts の stringArrayFromUnknown）。それ以外なら空
function strings(value: unknown): string[] {
  return typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

// OMP の scanSkillsFromDir: dir の直下の、. で始まらないディレクトリ（かリンク）の SKILL.md。中身が空なら読まない。frontmatter の
// enabled が false なら読まない。requireDescription なら description の無いものも読まない。名前は frontmatter の name の前後の空白を除いたもの
// （空ならディレクトリ名）で、/ か \ を含めば読まない。名前（大文字小文字を区別しない順、同じなら区別する順）、パスの順に並べる。
// 在るのに読めない（通常のファイルでない、権限が無い）SKILL.md は unreadable に入れる（OMP は読み飛ばす）
function scanSkills(dir: string, requireDescription: boolean): { skills: { name: string; path: string }[]; unreadable: string[] } {
  const skills: { name: string; path: string }[] = [];
  const unreadable: string[] = [];
  let list: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[];
  try {
    list = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { skills, unreadable };
  }
  for (const entry of list) {
    if (entry.name.startsWith(".") || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
    const path = join(dir, entry.name, "SKILL.md");
    if (!existsSync(path)) continue;
    let text: string;
    try {
      // FIFO などを読んで止まらないように、通常のファイルだけを読む
      if (!statSync(path).isFile()) throw new Error("通常のファイルではありません");
      text = readFileSync(path, "utf8");
    } catch {
      unreadable.push(path);
      continue;
    }
    if (text === "") continue;
    const frontmatter = parseFrontmatter(text);
    if (frontmatter.enabled === false || (requireDescription && !frontmatter.description)) continue;
    const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() || basename(dirname(path)) : basename(dirname(path));
    if (/[\\/]/.test(name)) continue;
    skills.push({ name, path });
  }
  const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  skills.sort((a, b) => order(a.name.toLowerCase(), b.name.toLowerCase()) || order(a.name, b.name) || order(a.path, b.path));
  return { skills, unreadable };
}

function isDirectoryPath(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
