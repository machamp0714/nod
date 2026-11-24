// 状態の表示。読むだけで何も書かない。OMP の版が違っても、写しや設定が壊れていても・読めなくても、例外で終わらずに表示する
// （OMP の設定の置き場を決められないとき（context.ts の userAgentDir）だけは、理由を出して止まる）。
// 出すのは、適用の状態（写しと組の記録の照合、OMP が global の設定として読むファイル（config.yml、無ければ config.yaml）の3つの読み込みの設定、
// 旧管理配置の残り、生成物の pin、OMP の版）、通常の omp でどの tdd が使われるか（通常の omp が実行したディレクトリで実際に読むスキル
// （omp-skills.ts の normalOmpSkills: OMP 19.1.0 と同じ provider の置き場・読み込みの条件・同じ名前の優先の順。写しの項目も数える）から、
// 裸の名前 tdd を取るものを選ぶ。それが写しの中の pstack の tdd なら、写しを除いて選んだ利用者・プロジェクトの tdd が名前空間つきになることも出す。
// 設定は OMP が読むファイルの値で決め、そのファイルを読めないか値の形が正しくなければ、OMP の既定の設定で選んだことを添える。
// プロジェクトの設定の層は見ない。プラグインの登録などの中を調べない読み込み元が、選んだものより先に tdd を取りうるなら、そのことを添える）、
// 実行したディレクトリのプロジェクトの置き場
// （スキルは通常の omp がプロジェクトの置き場として読むもの（omp-skills.ts。git の外ではホームの手前までの祖先も読む）、エージェント定義は
// OMP と同じく実行したディレクトリから遡って最も近い .omp/agents（places.ts の projectAgents））にある、今回の定義やスキルと同じ名前のもの。
// 置き場の定義やスキルのファイルが在るのに読めなければ、
// 名前を確かめられないことをそのファイルごとに出す（写しの中のファイルは、写しの照合が読めないファイルとして出す）。
// 「適用しています」は、組の記録の形が正しく、写しの全ファイルが組の記録の sha256 と一致し（記録に無いファイルも無い）、組の記録の OMP の設定の
// 置き場がいまの置き場と同じで、OMP が読む設定ファイルに3つの読み込みの設定（extensions に写しの content、skills.customDirectories に写しの中の
// 生成したスキルの置き場、skills.manualSkills に記録の全スキル）が揃い、旧管理配置が残っていないときだけ出す。揃わなければ、何が欠けているか・
// 違うかの行と、適用が壊れていることを出す。組が別の置き場に適用したものなら、そのことと、この置き場には適用していないことを出す。
// 旧管理配置（旧の組の記録 control/harness.json、写しの専用ランチャー bin/omp と制御の置き場 control/、設定ファイルの写しの中を指す
// いまの配置のものでない項目）が残っていれば、それを出して apply か remove を案内する。
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { globalConfigPath, type OmpConfig, readConfig, realAncestor, stringList, yamlConfigPath } from "./config";
import { type Context, readOmpVersion, userAgentDir } from "./context";
import { copyProblems, entriesWithin, type Harness, parseHarness, paths, readGenerated, readRecord, samePin } from "./harness";
import { bareSkill, findRepoRoot, normalOmpSkills, type OmpSkills } from "./omp-skills";
import { type Definition, expand, packageDefinitions, projectAgents, real, skillsIn, within } from "./places";

export function status(ctx: Context, cwd: string): string[] {
  const agentDir = userAgentDir(ctx);
  const p = paths(ctx);
  const lines: string[] = ["適用の状態:"];

  let harness: Harness | undefined;
  let copyOk = false;
  // 組を適用した OMP の設定の置き場が、いまの置き場と違えばその置き場（実パス。harness.ts の checkSamePlace と同じ比べ方）
  let otherPlace: string | undefined;
  if (!existsSync(p.root)) {
    lines.push(`  写し ${p.root}: ありません`);
  } else {
    const record = readRecord(p.harness);
    const parsed = record === undefined ? "無いか、読めません" : parseHarness(record);
    if (typeof parsed === "string") {
      lines.push(`  写し ${p.root}: 組の記録（${p.harness}）が正しくありません（${parsed}）`);
    } else {
      harness = parsed;
      const problems = copyProblems(p.root, harness);
      const recorded = realAncestor(harness.agentDir);
      if (recorded !== agentDir) otherPlace = recorded;
      copyOk = problems.length === 0;
      lines.push(`  写し ${p.root}: 適用 ${harness.appliedAt}、pin ${harness.pin.commit}`);
      if (problems.length === 0) lines.push("    組のファイルは記録の sha256 と一致しています");
      for (const problem of problems) lines.push(`    ${problem}`);
      if (otherPlace !== undefined) lines.push(`    組は別の OMP の設定の置き場 ${otherPlace} に適用したもので、いまの置き場 ${agentDir} と違います`);
    }
  }

  // OMP がいま global の設定として読むファイル
  const settingsPath = globalConfigPath(agentDir);
  let settings: OmpConfig | undefined;
  // 写しの中を指す項目（いまの配置のもの: 写しの content と生成したスキルの置き場）と、旧管理配置の残り
  const current = [p.content, ...p.skills];
  const legacy: string[] = [];
  let configOk = false;
  let entries: { id: string; entry: string }[] = [];
  try {
    settings = readConfig(settingsPath);
    entries = entriesWithin(settings, p.root);
    if (settingsPath === yamlConfigPath(agentDir)) lines.push(`  OMP の設定 ${settingsPath}: config.yml が無いので、OMP はこのファイルを読みます`);
    legacy.push(...entries.filter(({ entry }) => !current.some((dir) => sameDir(dir, entry, ctx.home))).map(({ id, entry }) => `OMP の設定の ${id} の ${entry}`));
    if (harness !== undefined) {
      const missing = loadingGaps(settings, harness, ctx.home);
      configOk = missing.length === 0;
      lines.push(
        configOk
          ? `  OMP の設定 ${settingsPath}: 3つの読み込みの設定が揃っています（extensions に ${harness.content}、skills.customDirectories に ${harness.skillDirectories.join(", ")}、skills.manualSkills に ${harness.manualSkills.length} 個のスキル）`
          : `  OMP の設定 ${settingsPath}: 読み込みの設定が欠けています（${missing.join("、")}）`,
      );
    } else if (entries.length > 0) {
      lines.push(`  OMP の設定 ${settingsPath}: 写しの中を指す項目があります（${entries.map(({ id, entry }) => `${id} の ${entry}`).join("、")}）`);
    } else {
      lines.push(`  OMP の設定 ${settingsPath}: 読み込みの設定はありません`);
    }
  } catch (e) {
    settings = undefined;
    lines.push(`  OMP の設定 ${settingsPath}: 読めません（${(e as Error).message}）`);
  }
  if (existsSync(p.legacyHarness)) legacy.unshift(`旧管理配置の組の記録 ${p.legacyHarness}`);
  for (const path of p.legacyEntries.filter((path) => existsSync(path))) legacy.unshift(`写しの ${path}（専用ランチャーか制御の置き場）`);
  if (legacy.length > 0) lines.push(`  旧管理配置が残っています（${legacy.join("、")}）。bun scripts/pstack-omp/cli.ts apply で切り替えるか、remove で取り除いてください`);

  const generated = readGenerated(p.generated);
  if (generated === undefined) {
    lines.push(`  生成物 ${p.generated}: ありません（bun scripts/pstack-omp/cli.ts sync で作ります）`);
  } else if (!samePin(generated.pin, ctx.pin)) {
    lines.push(`  生成物 ${p.generated}: 元にした pin（${generated.pin.commit}）が固定の記録（${ctx.pin.commit}）と違います。sync と apply をやり直してください`);
  } else if (harness !== undefined && harness.pin.commit !== generated.pin.commit) {
    lines.push(`  生成物 ${p.generated}: 元にした pin（${generated.pin.commit}）が、適用したときの pin（${harness.pin.commit}）と違います。apply をやり直してください`);
  } else {
    lines.push(`  生成物 ${p.generated}: 元にした pin は固定の記録と一致しています（${ctx.pin.commit}）`);
  }

  let version: string;
  try {
    version = readOmpVersion(ctx);
  } catch (e) {
    version = `確かめられません（${(e as Error).message}）`;
  }
  const recorded = harness === undefined ? "" : `、適用したときの記録 ${harness.ompVersion}`;
  const versionOk = version === ctx.pin.ompVersion && (harness === undefined || harness.ompVersion === version);
  lines.push(`  OMP の版: ${version}（固定の記録 ${ctx.pin.ompVersion}${recorded}）${versionOk ? "" : "。版が違います（apply と sync は止まります。remove と status は行えます）"}`);

  if (harness !== undefined && copyOk && otherPlace === undefined && configOk && legacy.length === 0) {
    lines.push("  → 適用しています。通常の omp の新しく始めるセッションが、pstack の生成したスキル・読み替え表・poteto-agent を読み込みます");
  } else if (otherPlace !== undefined) {
    lines.push(
      `  → この置き場（${agentDir}）には適用していません（写しは別の置き場 ${otherPlace} に適用したものです）。その置き場を PI_CODING_AGENT_DIR に指定して ` +
        "status か remove を実行してください。この置き場で使うなら、その置き場を指定して remove してから、この置き場で apply し直してください",
    );
  } else if (legacy.length > 0 && harness === undefined) {
    lines.push("  → 旧管理配置が残っています（上の行のとおり）。bun scripts/pstack-omp/cli.ts apply で切り替えるか、remove で取り除いてください");
  } else if (existsSync(p.root) || entries.length > 0) {
    lines.push("  → 適用が壊れています（欠けているもの・違うものは上の行のとおり）。bun scripts/pstack-omp/cli.ts apply し直すか、remove してください");
  } else {
    lines.push("  → 適用していません");
  }

  // 通常の omp のセッションが実行したディレクトリで読むスキル（写しの項目も数えたものと、写しを除いたもの）。OMP が読むファイルを読めないか
  // 値の形が正しくなければ、OMP の既定の設定で集め（読めないことは上の「OMP の設定」の行で報告している）、tdd の行にそのことを添える
  let normal: OmpSkills;
  let user: OmpSkills;
  let assumed = "";
  try {
    if (settings === undefined) throw new Error("OMP の設定を読めません");
    normal = normalOmpSkills(agentDir, ctx.home, settings, undefined, cwd, process.env);
    user = normalOmpSkills(agentDir, ctx.home, settings, p.root, cwd, process.env);
  } catch {
    const defaults = { path: settingsPath, bytes: undefined, data: {} };
    normal = normalOmpSkills(agentDir, ctx.home, defaults, undefined, cwd, process.env);
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
  if (bare.skill !== undefined && within(bare.skill.path, p.root)) {
    lines.push(`  通常の omp のセッション: pstack の tdd（${bare.skill.path}）が使われます（写しの中の生成したスキルの置き場が skills.customDirectories にあるため）${caveat}`);
    const shadowed = bareSkill(user, "tdd").skill;
    if (shadowed !== undefined) lines.push(`    ${describe(shadowed)}は、名前空間つきの <名前空間>/tdd の名前になります`);
  } else if (bare.skill !== undefined) {
    lines.push(`  通常の omp のセッション: ${describe(bare.skill)}が使われます${caveat}`);
  } else {
    lines.push(`  通常の omp のセッション: tdd は読み込まれません（${bare.reason ?? "通常の omp が読む置き場に tdd はありません"}）${caveat}`);
  }
  // 写しの中の読めないファイルは上の写しの照合で、プロジェクトの置き場の読めないファイルは下のプロジェクトの節で出す
  for (const { path } of user.unreadable.filter((u) => !u.project)) lines.push(`  利用者の置き場の ${path} は読めないので、名前（tdd か）を確かめられません`);

  // プロジェクトの根（git の作業ツリーの根。git の外なら実行したディレクトリ）と、そのエージェント定義と、通常の omp がプロジェクトの置き場として読むスキル
  const root = real(findRepoRoot(resolve(cwd)) ?? cwd);
  const agents = projectAgents(cwd);
  const project: Definition[] = [...agents.definitions, ...user.skills.filter((s) => s.project).map((s): Definition => ({ kind: "skill", name: s.name, path: s.path }))];
  const unreadable = [...agents.unreadable, ...user.unreadable.filter((u) => u.project).map((u) => u.path)];
  const content = packageDefinitions(ctx.packageDir).definitions;
  const contentNames = new Set(content.map((d) => `${d.kind}:${d.name}`));
  // 生成したスキルの名前（データ置き場の生成物と、写しの中の生成したスキル）
  const generatedNames = new Set([...(generated?.names ?? []), ...p.skills.flatMap((dir) => skillsIn(dir).definitions).map((d) => d.name)]);
  const clashes = project.filter((d) => contentNames.has(`${d.kind}:${d.name}`) || (d.kind === "skill" && generatedNames.has(d.name)));
  lines.push(
    `プロジェクト（${root}）の置き場（エージェント定義は、実行したディレクトリから遡って最も近い .omp/agents。根の外やホームにあっても OMP が読む）にある、` +
      "今回の定義やスキルと同じ名前のもの（通常の omp で効く）:",
  );
  if (clashes.length === 0 && unreadable.length === 0) lines.push("  ありません");
  for (const d of clashes) lines.push(`  ${d.path}: ${explain(d, generatedNames)}`);
  for (const path of unreadable) lines.push(`  ${path}: 読めないので、今回の定義やスキルと同じ名前かを確かめられません`);
  return lines;
}

// 設定の項目 entry（~ を含みうる）が dir と同じディレクトリか（別名を解いて比べる）
function sameDir(dir: string, entry: string, home: string): boolean {
  return real(expand(entry, home)) === real(dir);
}

// OMP が読む設定ファイルに欠けている読み込みの設定（揃っていれば空）
function loadingGaps(settings: OmpConfig, harness: Harness, home: string): string[] {
  const extensions = stringList(settings, "extensions") ?? [];
  const custom = stringList(settings, "skills.customDirectories") ?? [];
  const manual = stringList(settings, "skills.manualSkills") ?? [];
  return [
    ...(extensions.some((entry) => sameDir(harness.content, entry, home)) ? [] : [`extensions に ${harness.content} がありません`]),
    ...harness.skillDirectories.filter((dir) => !custom.some((entry) => sameDir(dir, entry, home))).map((dir) => `skills.customDirectories に ${dir} がありません`),
    ...(harness.manualSkills.every((name) => manual.includes(name))
      ? []
      : [`skills.manualSkills に ${harness.manualSkills.filter((name) => !manual.includes(name)).join(", ")} がありません`]),
  ];
}

function explain(d: Definition, generatedNames: Set<string>): string {
  if (d.kind === "agent") return `エージェント ${d.name}。プロジェクトの定義が優先されるので、このプロジェクトでは今回の定義が使われません`;
  if (generatedNames.has(d.name)) return `スキル ${d.name}。生成したスキル（skills.customDirectories）が優先され、このスキルは <名前空間>/${d.name} の名前になります`;
  return `スキル ${d.name}。今回の読み替え表のスキルと同じ名前なので、どちらかが <名前空間>/${d.name} の名前になり、skill://${d.name} で今回の表を読めないことがあります`;
}
