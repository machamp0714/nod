// 状態の表示。読むだけで何も書かない。OMP の版が違っても、写しや設定が壊れていても・読めなくても、例外で終わらずに表示する。
// 出すのは、適用の状態（写しと組の記録の照合、制御の規則の版と sha256 とリポジトリの規則との一致、config.yml に以前の配置の
// 読み込みの設定が残っているか、生成物の pin、OMP の版）、どの tdd が使われるか（専用ランチャーと通常の omp）、実行したディレクトリの
// プロジェクトの置き場にある、今回の定義やスキルと同じ名前のもの。
// 「適用しています」は、写しの全ファイル（専用ランチャー bin/omp とサンドボックスのプロファイル control/sandbox.sb を含む）が組の記録の
// sha256 と一致し（記録に無いファイルも無い）、写しの中の生成したスキルの置き場が在るときだけ出す（制御の拡張と専用ランチャーの
// 組の検証と同じ照合。omp/control/verify.ts の copyProblems）。pstack は専用ランチャーから起動したセッションだけに読み込まれ、
// 通常の omp には読み込まれないことと、ランチャーのパスを案内する。違っていれば、何が違うかの行と、適用が壊れていることを出す。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configPath, type OmpConfig, readConfig, sha256 } from "./config";
import { type Context, readOmpVersion } from "./context";
import { entryGuide, legacyItems, paths, readGenerated, readRecord, samePin } from "./harness";
import { type Definition, packageDefinitions, projectPlaces, skillsIn, userPlaces } from "./places";
import { copyProblems, type Harness, parseHarness, readRules, RULES_FILE } from "../../omp/control/verify";

export function status(ctx: Context, cwd: string): string[] {
  const p = paths(ctx);
  const path = configPath(ctx.agentDir);
  const lines: string[] = ["適用の状態:"];

  const record = readRecord(p.harness);
  let harness: Harness | undefined;
  let applied = false;
  if (!existsSync(p.root)) {
    lines.push(`  写し ${p.root}: ありません`);
  } else {
    const parsed = record === undefined ? "無いか、読めません" : parseHarness(record);
    if (typeof parsed === "string") {
      lines.push(`  写し ${p.root}: 組の記録（${p.harness}）が正しくありません（${parsed}）`);
    } else {
      harness = parsed;
      const problems = copyProblems(p.root, harness);
      applied = problems.length === 0;
      lines.push(`  写し ${p.root}: 適用 ${harness.appliedAt}、pin ${harness.pin.commit}`);
      if (applied) lines.push("    組のファイルは記録の sha256 と一致しています");
      for (const problem of problems) lines.push(`    ${problem}`);
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
  } else if (existsSync(p.root)) {
    lines.push("  → 適用が壊れています（欠けているもの・違うものは上の行のとおり）。専用ランチャーは omp を起動しません。apply し直すか remove してください");
  } else if (legacy.length > 0) {
    lines.push("  → 以前の配置の読み込みの設定だけが残っています。apply か remove で取り除いてください");
  } else {
    lines.push("  → 適用していません");
  }

  let userDefinitions: Definition[] = [];
  try {
    if (config !== undefined) userDefinitions = userPlaces(ctx.agentDir, ctx.home, config, p.root).definitions;
  } catch {
    // 設定の値の形が正しくなければ、利用者の置き場は上の「OMP の設定」の行で報告している
  }
  lines.push("どの tdd が使われるか:");
  // 写しの中の pstack の tdd（専用ランチャーのセッションで skills.customDirectories の先頭に入る置き場）
  const pstackTdd = join(p.skills[0]!, "tdd", "SKILL.md");
  const userTdd = userDefinitions.find((d) => d.kind === "skill" && d.name === "tdd");
  if (applied && existsSync(pstackTdd)) {
    lines.push(`  専用ランチャーから起動したセッション: pstack の tdd（${pstackTdd}）が使われます（写しの中の生成したスキルの置き場が skills.customDirectories の先頭に入るため）`);
    if (userTdd !== undefined) lines.push(`    利用者の置き場の tdd（${userTdd.path}）は、名前空間つきの <名前空間>/tdd の名前になります`);
    lines.push(
      userTdd === undefined
        ? "  通常の omp のセッション: pstack の tdd は読み込まれません（利用者の置き場にも tdd はありません）"
        : `  通常の omp のセッション: 利用者の置き場の tdd（${userTdd.path}）が使われます`,
    );
  } else if (userTdd !== undefined) {
    lines.push(`  適用していないので、利用者の置き場の tdd（${userTdd.path}）が使われます`);
  } else {
    lines.push("  適用していないので、pstack の tdd は使われません（利用者の置き場にも tdd はありません）");
  }

  const project = projectPlaces(cwd, ctx.home);
  const content = packageDefinitions(ctx.packageDir);
  const contentNames = new Set(content.map((d) => `${d.kind}:${d.name}`));
  // 生成したスキルの名前（データ置き場の生成物と、写しの中の生成したスキル）
  const generatedNames = new Set([...(generated?.names ?? []), ...p.skills.flatMap(skillsIn).map((d) => d.name)]);
  const clashes = project.definitions.filter((d) => contentNames.has(`${d.kind}:${d.name}`) || (d.kind === "skill" && generatedNames.has(d.name)));
  lines.push(`プロジェクト（${project.root}）の置き場にある、今回の定義やスキルと同じ名前のもの（専用ランチャーから起動したセッションで効く）:`);
  if (clashes.length === 0) lines.push("  ありません");
  for (const d of clashes) lines.push(`  ${d.path}: ${explain(d, generatedNames)}`);
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
