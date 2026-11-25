// 状態の表示。読むだけで、OMP の設定の置き場にもデータ置き場にも何も書かない。OMP の版が違っても、生成物や設定が無くても・読めなくても、
// 例外で終わらずに表示する（OMP の設定の置き場を決められないとき（context.ts の userAgentDir）だけは、理由を出して止まる）。出すのは次のとおり。
// - 生成物（固定の生成先 <データ置き場>/pstack-omp/generated の manifest.json）の元にした pin が固定の記録と一致するかと、OMP の版。
// - OMP が global の設定として読むファイル（config.yml、無ければ config.yaml）に、利用者が一度だけ手で登録する3つの読み込みの設定が揃っているか:
//   extensions に OMP 向けのディレクトリ（既定は nod のリポジトリの omp/content）、skills.customDirectories に生成先の pstack/skills と
//   cursor-team-kit/skills、skills.manualSkills に読み込む全スキルの名前（生成物の manifest の、生成したスキルの名前だけ）。
//   パスは ~ を展開し別名を解いて比べ、名前は OMP 19.1.0 と同じく skills.manualSkills の各項目を Bun.Glob のパターンとして当てる。
//   欠けていれば、欠けているものと、一度だけ登録する値（そのまま貼れる YAML）を出す。
// - 通常の omp でどの tdd が使われるか（通常の omp が実行したディレクトリで実際に読むスキル（omp-skills.ts の normalOmpSkills: OMP 19.1.0 と
//   同じ provider の置き場・読み込みの条件・同じ名前の優先の順）から、裸の名前 tdd を取るものを選ぶ。それが生成先の pstack の tdd なら、
//   生成先と OMP 向けのディレクトリを除いて選んだ利用者・プロジェクトの tdd が名前空間つきになることも出す。
//   設定は OMP が読むファイルの値で決め、そのファイルを読めないか値の形が正しくなければ、OMP の既定の設定で選んだことを添える。
//   プロジェクトの設定の層は見ない。プラグインの登録などの中を調べない読み込み元が、選んだものより先に tdd を取りうるなら、そのことを添える）。
// - 実行したディレクトリのプロジェクトの置き場（スキルは通常の omp がプロジェクトの置き場として読むもの（omp-skills.ts。git の外ではホームの
//   手前までの祖先も読む）、エージェント定義は OMP と同じく実行したディレクトリから遡って最も近い .omp/agents（places.ts の projectAgents））
//   にある、OMP 向けのディレクトリのエージェント定義（poteto-agent）や生成したスキルと同じ名前のもの。置き場の定義やスキルのファイルが在るのに
//   読めなければ、名前を確かめられないことをそのファイルごとに出す。
import { resolve } from "node:path";
import { globalConfigPath, type OmpConfig, readConfig, stringList, yamlConfigPath } from "./config";
import { type Context, readOmpVersion, userAgentDir } from "./context";
import { generatedDir, readManifest, samePin, skillDirs } from "./generate";
import { bareSkill, findRepoRoot, normalOmpSkills, type OmpSkills } from "./omp-skills";
import { type Definition, expand, packageAgents, projectAgents, real, within } from "./places";

const SYNC = "bun scripts/pstack-omp/cli.ts sync";

// 利用者が一度だけ登録する3つの読み込みの設定の値
interface Loading {
  extensions: string[];
  customDirectories: string[];
  manualSkills: string[];
}

export function status(ctx: Context, cwd: string): string[] {
  const agentDir = userAgentDir(ctx);
  const generated = generatedDir(ctx);
  const lines: string[] = ["生成物と OMP の版:"];

  const manifest = readManifest(generated);
  if (manifest === undefined) {
    lines.push(`  生成物 ${generated}: ありません（${SYNC} で作ります）`);
  } else if (!samePin(manifest.pin, ctx.pin)) {
    lines.push(`  生成物 ${generated}: 元にした pin（${manifest.pin.commit}）が固定の記録（${ctx.pin.commit}）と違います。${SYNC} をやり直してください`);
  } else {
    lines.push(`  生成物 ${generated}: 元にした pin は固定の記録と一致しています（${ctx.pin.commit}）`);
  }

  let version: string;
  try {
    version = readOmpVersion(ctx);
  } catch (e) {
    version = `確かめられません（${(e as Error).message}）`;
  }
  lines.push(`  OMP の版: ${version}（固定の記録 ${ctx.pin.ompVersion}）${version === ctx.pin.ompVersion ? "" : "。版が違います（sync は止まります）"}`);

  // 読み込む全スキルの名前は、生成したスキル（生成物の manifest）の名前だけ
  const generatedNames = manifest?.names ?? [];
  const loading: Loading = { extensions: [ctx.packageDir], customDirectories: skillDirs(generated), manualSkills: generatedNames };

  lines.push("読み込みの設定:");
  // OMP がいま global の設定として読むファイル
  const settingsPath = globalConfigPath(agentDir);
  if (settingsPath === yamlConfigPath(agentDir)) lines.push(`  OMP の設定 ${settingsPath}: config.yml が無いので、OMP はこのファイルを読みます`);
  let settings: OmpConfig | undefined;
  let gaps: string[] | undefined;
  try {
    settings = readConfig(settingsPath);
    gaps = loadingGaps(settings, loading, ctx.home);
  } catch (e) {
    settings = undefined;
    lines.push(`  OMP の設定 ${settingsPath}: 読めません（${(e as Error).message}）`);
  }
  const howTo =
    "一度だけ、次の3つを手で登録してください。既にある値は残し、skills.customDirectories の2つは先頭に置きます（pstack の tdd を優先するため）。status は設定を書き換えません" +
    (manifest === undefined ? `（生成物がまだ無いので、skills.manualSkills の生成したスキルの名前は ${SYNC} の後に出ます）` : "");
  if (gaps === undefined) {
    lines.push(`  → OMP の設定を読めないので、揃っているかを確かめられません。${howTo}`, ...registration(loading));
  } else if (gaps.length > 0) {
    lines.push(`  OMP の設定 ${settingsPath}: 読み込みの設定が欠けています（${gaps.join("、")}）`, `  → ${howTo}`, ...registration(loading));
  } else {
    lines.push(
      `  OMP の設定 ${settingsPath}: 3つの読み込みの設定が揃っています（extensions に ${ctx.packageDir}、skills.customDirectories に ` +
        `${loading.customDirectories.join(", ")}、skills.manualSkills に ${loading.manualSkills.length} 個のスキル）`,
      manifest === undefined
        ? `  → 読み込みの設定は揃っていますが、生成物が無いので、${SYNC} するまで pstack の生成したスキルは読み込まれません`
        : "  → 揃っています。通常の omp の新しく始めるセッションが pstack の生成したスキルと poteto-agent を読み込みます",
    );
  }

  // 通常の omp のセッションが実行したディレクトリで読むスキル（生成先と OMP 向けのディレクトリの項目も数えたものと、それらを除いたもの）。
  // OMP が読むファイルを読めないか値の形が正しくなければ、OMP の既定の設定で集め（読めないことは上の「OMP の設定」の行で報告している）、
  // tdd の行にそのことを添える
  let normal: OmpSkills;
  let user: OmpSkills;
  let assumed = "";
  try {
    if (settings === undefined) throw new Error("OMP の設定を読めません");
    normal = normalOmpSkills(agentDir, ctx.home, settings, [], cwd, process.env);
    user = normalOmpSkills(agentDir, ctx.home, settings, [generated, ctx.packageDir], cwd, process.env);
  } catch {
    normal = normalOmpSkills(agentDir, ctx.home, { path: settingsPath, data: {} }, [], cwd, process.env);
    user = normal;
    assumed = "（OMP の設定を読めないので、OMP の既定の設定で選びました）";
  }
  lines.push("どの tdd が使われるか:");
  const describe = (skill: { path: string; project: boolean }) => `${skill.project ? "プロジェクトの置き場" : "利用者の置き場"}の tdd（${skill.path}）`;
  // 通常の omp で裸の名前 tdd を取るもの
  const bare = bareSkill(normal, "tdd");
  // 中を調べない読み込み元が、選んだものより先に tdd を取りうるなら、そのことを添える
  const caveat =
    (bare.unexamined.length === 0 ? "" : `。ただし、OMP は ${bare.unexamined.join("、")} からもスキルを読み、その中は調べていないので、そこに tdd があればそちらが使われます`) +
    assumed;
  if (bare.skill !== undefined && within(bare.skill.path, generated)) {
    lines.push(`  通常の omp のセッション: pstack の tdd（${bare.skill.path}）が使われます（生成先のスキルの置き場が skills.customDirectories にあるため）${caveat}`);
    const shadowed = bareSkill(user, "tdd").skill;
    if (shadowed !== undefined) lines.push(`    ${describe(shadowed)}は、名前空間つきの <名前空間>/tdd の名前になります`);
  } else if (bare.skill !== undefined) {
    lines.push(`  通常の omp のセッション: ${describe(bare.skill)}が使われます${caveat}`);
  } else {
    lines.push(`  通常の omp のセッション: tdd は読み込まれません（${bare.reason ?? "通常の omp が読む置き場に tdd はありません"}）${caveat}`);
  }
  // 利用者の置き場の読めないファイル（生成先と OMP 向けのディレクトリの中は除く）。プロジェクトの置き場の読めないファイルは下のプロジェクトの節で出す
  for (const { path } of user.unreadable.filter((u) => !u.project)) lines.push(`  利用者の置き場の ${path} は読めないので、名前（tdd か）を確かめられません`);

  // プロジェクトの根（git の作業ツリーの根。git の外なら実行したディレクトリ）と、そのエージェント定義と、通常の omp がプロジェクトの置き場として読むスキル
  const root = real(findRepoRoot(resolve(cwd)) ?? cwd);
  const agents = projectAgents(cwd);
  const project: Definition[] = [...agents.definitions, ...user.skills.filter((s) => s.project).map((s): Definition => ({ kind: "skill", name: s.name, path: s.path }))];
  const unreadable = [...agents.unreadable, ...user.unreadable.filter((u) => u.project).map((u) => u.path)];
  const agentNames = new Set(packageAgents(ctx.packageDir).definitions.map((d) => d.name));
  const generatedSet = new Set(generatedNames);
  const clashes = project.filter((d) => (d.kind === "agent" ? agentNames : generatedSet).has(d.name));
  lines.push(
    `プロジェクト（${root}）の置き場（エージェント定義は、実行したディレクトリから遡って最も近い .omp/agents。根の外やホームにあっても OMP が読む）にある、` +
      "今回の定義やスキルと同じ名前のもの（通常の omp で効く）:",
  );
  if (clashes.length === 0 && unreadable.length === 0) lines.push("  ありません");
  for (const d of clashes) lines.push(`  ${d.path}: ${explain(d)}`);
  for (const path of unreadable) lines.push(`  ${path}: 読めないので、今回の定義やスキルと同じ名前かを確かめられません`);
  return lines;
}

// 設定の項目 entry（~ を含みうる）が dir と同じディレクトリか（別名を解いて比べる）
function sameDir(dir: string, entry: string, home: string): boolean {
  return real(expand(entry, home)) === real(dir);
}

// OMP が読む設定ファイルに欠けている読み込みの設定（揃っていれば空）。値の形が正しくなければ例外（呼び出し側が読めないと報告する）
function loadingGaps(settings: OmpConfig, loading: Loading, home: string): string[] {
  const extensions = stringList(settings, "extensions") ?? [];
  const custom = stringList(settings, "skills.customDirectories") ?? [];
  const manual = (stringList(settings, "skills.manualSkills") ?? []).map((pattern) => new Bun.Glob(pattern));
  const names = loading.manualSkills.filter((name) => !manual.some((glob) => glob.match(name)));
  return [
    ...loading.extensions.filter((dir) => !extensions.some((entry) => sameDir(dir, entry, home))).map((dir) => `extensions に ${dir} がありません`),
    ...loading.customDirectories.filter((dir) => !custom.some((entry) => sameDir(dir, entry, home))).map((dir) => `skills.customDirectories に ${dir} がありません`),
    ...(names.length === 0 ? [] : [`skills.manualSkills に ${names.join(", ")} がありません`]),
  ];
}

// 一度だけ登録する値の、そのまま貼れる YAML の行（字下げしない。マッピングの見出しの行末の空白を除く）
function registration(loading: Loading): string[] {
  const yaml = Bun.YAML.stringify({ extensions: loading.extensions, skills: { customDirectories: loading.customDirectories, manualSkills: loading.manualSkills } }, null, 2);
  return yaml.replace(/: +$/gm, ":").replace(/\n$/, "").split("\n");
}

function explain(d: Definition): string {
  if (d.kind === "agent") return `エージェント ${d.name}。プロジェクトの定義が優先されるので、このプロジェクトでは今回の定義が使われません`;
  return `スキル ${d.name}。生成したスキル（skills.customDirectories）が優先され、このスキルは <名前空間>/${d.name} の名前になります`;
}
