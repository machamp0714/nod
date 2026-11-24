// 状態の表示。読むだけで何も書かない。OMP の版が違っても、写しや設定が壊れていても・読めなくても、例外で終わらずに表示する
// （OMP の設定の置き場を決められないとき（context.ts の userAgentDir）だけは、理由を出して止まる）。
// 出すのは、適用の状態（写しと組の記録の照合、制御の規則の版と sha256 とリポジトリの規則との一致、config.yml に以前の配置の
// 読み込みの設定が残っているか、生成物の pin、OMP の版）、どの tdd が使われるか（専用ランチャーと通常の omp。通常の omp で裸の名前 tdd を
// 取るものを、利用者の置き場と実行したディレクトリのプロジェクトの置き場から、OMP 19.1.0 の順（places.ts の normalOmpSkills の並び。
// resolveCollision と provider の priority）で選ぶ。利用者の置き場と disabledProviders（実行したディレクトリで解いた値。その provider の置き場は
// 数えない）は、OMP がいま global の設定として読むファイル（config.yml が無ければ config.yaml）の値で決める。プロジェクトの設定の
// disabledProviders・skills.enabled・ignoredSkills などは見ず、OMP が読まないスキル（description が無い、enabled: false）も見分けずに、
// 在る SKILL.md を候補にする）、
// 実行したディレクトリのプロジェクトの置き場
// （スキルは実行したディレクトリから git の作業ツリーの根まで、エージェント定義は OMP と同じく実行したディレクトリから遡って最も近い
// .omp/agents。places.ts の projectPlaces）にある、今回の定義やスキルと同じ名前のもの。置き場の定義やスキルのファイルが在るのに読めなければ、
// 名前を確かめられないことをそのファイルごとに出す（写しの中のファイルは、写しの照合が読めないファイルとして出す）。
// 「適用しています」は、写しの全ファイル（専用ランチャー bin/omp とサンドボックスのプロファイル control/sandbox.sb を含む）が組の記録の
// sha256 と一致し（記録に無いファイルも無い）、写しの中の生成したスキルの置き場が在り、組の記録の OMP の設定の置き場がいまの置き場と同じときだけ
// 出す（制御の拡張と専用ランチャーの組の検証と同じ照合。omp/control/verify.ts の copyProblems と置き場の比べ方）。pstack は専用ランチャーから
// 起動したセッションだけに読み込まれ、通常の omp には読み込まれないことと、ランチャーのパスを案内する。写しが違っていれば、何が違うかの行と、
// 適用が壊れていることを出す。組が別の置き場に適用したものなら、そのことと、この置き場には適用していないこと（その置き場での status と remove）を出す。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configPath, globalConfigPath, type OmpConfig, readConfig, realAncestor, sha256, stringList } from "./config";
import { type Context, readOmpVersion, userAgentDir } from "./context";
import { entryGuide, legacyItems, paths, readGenerated, readRecord, samePin } from "./harness";
import { type Definition, normalOmpSkills, type OmpSkills, packageDefinitions, projectPlaces, skillsIn } from "./places";
import { copyProblems, type Harness, parseHarness, readRules, RULES_FILE } from "../../omp/control/verify";

export function status(ctx: Context, cwd: string): string[] {
  const agentDir = userAgentDir(ctx);
  const p = paths(ctx);
  const path = configPath(agentDir);
  const lines: string[] = ["適用の状態:"];

  const record = readRecord(p.harness);
  let harness: Harness | undefined;
  let applied = false;
  // 組を適用した OMP の設定の置き場が、いまの置き場と違えばその置き場（実パス。harness.ts の checkSamePlace と組の検証と同じ比べ方）
  let otherPlace: string | undefined;
  if (!existsSync(p.root)) {
    lines.push(`  写し ${p.root}: ありません`);
  } else {
    const parsed = record === undefined ? "無いか、読めません" : parseHarness(record);
    if (typeof parsed === "string") {
      lines.push(`  写し ${p.root}: 組の記録（${p.harness}）が正しくありません（${parsed}）`);
    } else {
      harness = parsed;
      const problems = copyProblems(p.root, harness);
      const recorded = realAncestor(harness.agentDir);
      if (recorded !== agentDir) otherPlace = recorded;
      applied = problems.length === 0 && otherPlace === undefined;
      lines.push(`  写し ${p.root}: 適用 ${harness.appliedAt}、pin ${harness.pin.commit}`);
      if (problems.length === 0) lines.push("    組のファイルは記録の sha256 と一致しています");
      for (const problem of problems) lines.push(`    ${problem}`);
      if (otherPlace !== undefined) {
        lines.push(`    組は別の OMP の設定の置き場 ${otherPlace} に適用したもので、いまの置き場 ${agentDir} と違います。このままでは専用ランチャーは omp を起動しません`);
      }
    }
  }

  const rulesPath = join(p.root, RULES_FILE);
  const repoRules = join(ctx.controlDir, "rules.json");
  if (existsSync(rulesPath)) {
    const rules = readRules(rulesPath);
    const sha = fileSha(rulesPath);
    if (typeof rules === "string") {
      lines.push(`  制御の規則 ${rulesPath}: 正しくありません（${rules}）`);
    } else {
      lines.push(
        `  制御の規則 ${rulesPath}: 版 ${rules.version}、sha256 ${sha}（拒否するツール ${Object.keys(rules.toolApproval).join(", ")}、` +
          `bash の拒否のパターン ${rules.bashDeny.length} 個、github の拒否 ${rules.github.denyOps.join(", ")}、子と孫が起動できるエージェント ${rules.task.subAgents.join(", ")}、` +
          `書き込めない置き場 ${rules.protectedPaths.join(", ")}、どのプロジェクトでも書き込めないパス ${rules.projectPaths.join(", ")}（${rules.allowPaths.join(", ")} の下を除く））`,
      );
    }
    const repoSha = fileSha(repoRules);
    lines.push(
      sha !== undefined && repoSha === sha
        ? `    リポジトリの規則と一致しています（${repoRules}）`
        : `    リポジトリの規則と違います（${repoRules}）。apply し直すとリポジトリの規則に入れ替わります`,
    );
  } else if (existsSync(p.root)) {
    lines.push(`  制御の規則 ${rulesPath}: ありません（専用ランチャーは omp を起動しません）`);
  }

  let config: OmpConfig | undefined;
  let legacy: string[] = [];
  try {
    config = readConfig(path);
    legacy = legacyItems(config, record, p.root);
    lines.push(
      legacy.length === 0
        ? `  OMP の設定 ${path}: 読み込みの設定はありません（pstack は専用ランチャーだけが読み込みます）`
        : `  OMP の設定 ${path}: 以前の配置の読み込みの設定が残っています（${legacy.join("、")}）。bun scripts/pstack-omp/cli.ts apply か remove で取り除いてください`,
    );
  } catch (e) {
    lines.push(`  OMP の設定 ${path}: 読めません（${(e as Error).message}）`);
  }
  // OMP がいま global の設定として読むファイル。config.yml が在ればそれ自身（形は legacyItems が上で確かめている）
  const settingsPath = globalConfigPath(agentDir);
  let settings = config;
  if (settingsPath !== path) {
    try {
      settings = readConfig(settingsPath);
      for (const id of ["extensions", "skills.customDirectories"]) stringList(settings, id);
      lines.push(`  OMP の設定 ${settingsPath}: config.yml が無いので、OMP はこのファイルを読みます（利用者の置き場はこのファイルの値で決めます）`);
    } catch (e) {
      settings = undefined;
      lines.push(`  OMP の設定 ${settingsPath}: 読めません（${(e as Error).message}）`);
    }
  }

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

  if (applied) {
    lines.push(`  → 適用しています。pstack は専用ランチャー ${p.launcher} から起動したセッションだけに読み込まれます（通常の omp には読み込まれません）`);
    for (const line of entryGuide(p.launcher)) lines.push(`  ${line}`);
  } else if (otherPlace !== undefined) {
    lines.push(
      `  → この置き場（${agentDir}）には適用していません（写しは別の置き場 ${otherPlace} に適用したものです）。その置き場を PI_CODING_AGENT_DIR に指定して ` +
        "status か remove を実行してください。この置き場で使うなら、その置き場を指定して remove してから、この置き場で apply し直してください",
    );
  } else if (existsSync(p.root)) {
    lines.push("  → 適用が壊れています（欠けているもの・違うものは上の行のとおり）。専用ランチャーは omp を起動しません。apply し直すか remove してください");
  } else if (legacy.length > 0) {
    lines.push("  → 以前の配置の読み込みの設定だけが残っています。apply か remove で取り除いてください");
  } else {
    lines.push("  → 適用していません");
  }

  let normal: OmpSkills = { skills: [], unreadable: [] };
  try {
    if (settings !== undefined) normal = normalOmpSkills(agentDir, ctx.home, settings, p.root, cwd);
  } catch {
    // 設定の値の形が正しくなければ、利用者の置き場は上の「OMP の設定」の行で報告している
  }
  lines.push("どの tdd が使われるか:");
  // 写しの中の pstack の tdd（専用ランチャーのセッションで skills.customDirectories の先頭に入る置き場）
  const pstackTdd = join(p.skills[0]!, "tdd", "SKILL.md");
  // 利用者の置き場と実行したディレクトリのプロジェクトの置き場の tdd のうち、通常の omp で裸の名前 tdd を取るもの
  // （normalOmpSkills はスキルを OMP の優先の順に並べる）
  const normalTdd = normal.skills.find((d) => d.name === "tdd");
  const used = normalTdd === undefined ? undefined : `${normalTdd.project ? "プロジェクトの置き場" : "利用者の置き場"}の tdd（${normalTdd.path}）`;
  const none = "利用者の置き場にも、実行したディレクトリのプロジェクトの置き場にも tdd はありません";
  if (applied && existsSync(pstackTdd)) {
    lines.push(`  専用ランチャーから起動したセッション: pstack の tdd（${pstackTdd}）が使われます（写しの中の生成したスキルの置き場が skills.customDirectories の先頭に入るため）`);
    if (used !== undefined) lines.push(`    ${used}は、名前空間つきの <名前空間>/tdd の名前になります`);
    lines.push(used === undefined ? `  通常の omp のセッション: pstack の tdd は読み込まれません（${none}）` : `  通常の omp のセッション: ${used}が使われます`);
  } else if (used !== undefined) {
    lines.push(`  適用していないので、${used}が使われます`);
  } else {
    lines.push(`  適用していないので、pstack の tdd は使われません（${none}）`);
  }
  // プロジェクトの置き場の読めないファイルは、下のプロジェクトの節で出す
  for (const { path } of normal.unreadable.filter((u) => !u.project)) lines.push(`  利用者の置き場の ${path} は読めないので、名前（tdd か）を確かめられません`);

  const project = projectPlaces(cwd, ctx.home);
  const content = packageDefinitions(ctx.packageDir).definitions;
  const contentNames = new Set(content.map((d) => `${d.kind}:${d.name}`));
  // 生成したスキルの名前（データ置き場の生成物と、写しの中の生成したスキル）
  const generatedNames = new Set([...(generated?.names ?? []), ...p.skills.flatMap((dir) => skillsIn(dir).definitions).map((d) => d.name)]);
  const clashes = project.definitions.filter((d) => contentNames.has(`${d.kind}:${d.name}`) || (d.kind === "skill" && generatedNames.has(d.name)));
  lines.push(
    `プロジェクト（${project.root}）の置き場（エージェント定義は、実行したディレクトリから遡って最も近い .omp/agents。根の外やホームにあっても OMP が読む）にある、` +
      "今回の定義やスキルと同じ名前のもの（専用ランチャーから起動したセッションで効く）:",
  );
  if (clashes.length === 0 && project.unreadable.length === 0) lines.push("  ありません");
  for (const d of clashes) lines.push(`  ${d.path}: ${explain(d, generatedNames)}`);
  for (const path of project.unreadable) lines.push(`  ${path}: 読めないので、今回の定義やスキルと同じ名前かを確かめられません`);
  return lines;
}

function explain(d: Definition, generatedNames: Set<string>): string {
  if (d.kind === "agent") return `エージェント ${d.name}。プロジェクトの定義が優先されるので、このプロジェクトでは今回の定義が使われません`;
  if (generatedNames.has(d.name)) return `スキル ${d.name}。生成したスキル（skills.customDirectories）が優先され、このスキルは <名前空間>/${d.name} の名前になります`;
  return `スキル ${d.name}。今回の読み替え表のスキルと同じ名前なので、どちらかが <名前空間>/${d.name} の名前になり、skill://${d.name} で今回の表を読めないことがあります`;
}

// ファイルの sha256。無い・読めなければ undefined
function fileSha(path: string): string | undefined {
  try {
    return sha256(readFileSync(path));
  } catch {
    return undefined;
  }
}
