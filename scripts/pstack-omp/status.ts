// 状態の表示。読むだけで何も書かない。OMP の版が違っても、写しや設定が壊れていても表示する。
// 出すのは、適用の状態（config.yml の3つの読み込みの設定の登録、写しと組の記録の sha256、写しの中の生成したスキルの置き場、制御の規則の版と
// sha256 とリポジトリの規則との一致、生成物の pin、OMP の版）、どの tdd が使われるか、実行したディレクトリのプロジェクトの置き場にある、
// 今回の定義やスキルと同じ名前のもの。「適用しています」は、config.yml に4つ（extensions の control と content、skills.customDirectories の
// 生成したスキルの置き場、skills.manualSkills の読み込む全スキル）が揃い、写しの全ファイルが記録の sha256 と一致し、写しの中の生成したスキルの
// 置き場が在るときだけ出す。欠けていれば、何が欠けたかの行と、適用が壊れていることを出す。
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { configPath, type OmpConfig, readConfig, sha256, stringList } from "./config";
import { type Context, readOmpVersion } from "./context";
import { hashFiles, paths, readGenerated, readHarness, readRules, RULES_FILE, samePin } from "./harness";
import { type Definition, packageDefinitions, projectPlaces, real, skillsIn, userPlaces } from "./places";

export function status(ctx: Context, cwd: string): string[] {
  const p = paths(ctx);
  const path = configPath(ctx.agentDir);
  const harness = readHarness(p.harness);
  const lines: string[] = ["適用の状態:"];

  let config: OmpConfig | undefined;
  // 何かを登録しているか（一部でも）と、4つが揃っているか
  let registered = false;
  let complete = false;
  try {
    const loaded = readConfig(path);
    config = loaded;
    const has = (id: string, dir: string) => (stringList(loaded, id) ?? []).some((entry) => real(entry) === dir);
    const manual = stringList(loaded, "skills.manualSkills") ?? [];
    const names = Array.isArray(harness?.manualSkills) ? harness.manualSkills : undefined;
    const items = [
      ...[p.control, p.content].map((dir) => ({ label: `extensions の ${dir}`, ok: has("extensions", dir) })),
      ...p.skills.map((dir) => ({ label: `skills.customDirectories の ${dir}`, ok: has("skills.customDirectories", dir) })),
      ...(names ?? []).map((name) => ({ label: `skills.manualSkills の ${name}`, ok: manual.includes(name) })),
    ];
    registered = items.some((item) => item.ok);
    const missing = items.filter((item) => !item.ok).map((item) => item.label);
    if (registered && names === undefined) missing.push("skills.manualSkills の読み込む全スキル（組の記録が無いか読めないので確かめられません）");
    complete = registered && missing.length === 0;
    if (complete) {
      lines.push(
        `  OMP の設定 ${path}: 3つの読み込みの設定を登録しています（extensions に ${p.control} と ${p.content}、` +
          `skills.customDirectories の先頭に写しの中の生成したスキルの置き場、skills.manualSkills に読み込む ${names!.length} 個のスキル）`,
      );
    } else if (registered) {
      lines.push(`  OMP の設定 ${path}: 読み込みの設定が欠けています: ${missing.join("、")}`);
    } else {
      lines.push(`  OMP の設定 ${path}: 写しの読み込みの設定（extensions・skills.customDirectories・skills.manualSkills）を登録していません`);
    }
  } catch (e) {
    lines.push(`  OMP の設定 ${path}: 読めません（${(e as Error).message}）`);
  }

  let copyOk = false;
  if (harness === undefined) {
    lines.push(`  写し ${p.root}: ${registered ? "組の記録（control/harness.json）が無いか読めません" : "ありません"}`);
  } else {
    const actual = hashFiles(p.root);
    const recorded = harness.files ?? {};
    const problems = [
      ...Object.keys(recorded)
        .filter((rel) => !(rel in actual))
        .map((rel) => `${rel}（無い）`),
      ...Object.keys(actual)
        .filter((rel) => !(rel in recorded))
        .map((rel) => `${rel}（記録に無い）`),
      ...Object.keys(recorded)
        .filter((rel) => rel in actual && actual[rel] !== recorded[rel])
        .map((rel) => `${rel}（sha256 が違う）`),
    ];
    const missingSkills = p.skills.filter((dir) => !isDirectory(dir));
    copyOk = problems.length === 0 && missingSkills.length === 0;
    lines.push(`  写し ${p.root}: 適用 ${harness.appliedAt}、pin ${harness.pin?.commit}`);
    lines.push(problems.length === 0 ? "    組のファイルは記録の sha256 と一致しています" : `    組のファイルが記録と違います: ${problems.join(", ")}`);
    for (const dir of missingSkills) lines.push(`    生成したスキルの置き場 ${dir} がありません`);
  }

  const rulesPath = join(p.control, RULES_FILE);
  const repoRules = join(ctx.controlDir, RULES_FILE);
  if (existsSync(rulesPath)) {
    const rules = readRules(p.control);
    const sha = sha256(readFileSync(rulesPath));
    if (typeof rules === "string") {
      lines.push(`  制御の規則 ${rulesPath}: 正しくありません（${rules}）`);
    } else {
      lines.push(
        `  制御の規則 ${rulesPath}: 版 ${rules.version}、sha256 ${sha}（拒否するツール ${Object.keys(rules.toolApproval).join(", ")}、` +
          `bash の拒否のパターン ${rules.bashDeny.length} 個、github の拒否 ${rules.github.denyOps.join(", ")}、子と孫が起動できるエージェント ${rules.task.subAgents.join(", ")}、` +
          `書き込めない置き場 ${rules.protectedPaths.join(", ")}）`,
      );
    }
    const repoSha = existsSync(repoRules) ? sha256(readFileSync(repoRules)) : undefined;
    lines.push(repoSha === sha ? `    リポジトリの規則と一致しています（${repoRules}）` : `    リポジトリの規則と違います（${repoRules}）。apply し直すとリポジトリの規則に入れ替わります`);
  } else if (harness !== undefined) {
    lines.push(`  制御の規則 ${rulesPath}: ありません（制御の拡張は全ツールを遮断します）`);
  }

  const generated = readGenerated(p.generated);
  if (generated === undefined) {
    lines.push(`  生成物 ${p.generated}: ありません（bun scripts/pstack-omp/cli.ts sync で作ります）`);
  } else if (!samePin(generated.pin, ctx.pin)) {
    lines.push(`  生成物 ${p.generated}: 元にした pin（${generated.pin.commit}）が固定の記録（${ctx.pin.commit}）と違います。sync と apply をやり直してください`);
  } else if (harness !== undefined && harness.pin?.commit !== generated.pin.commit) {
    lines.push(`  生成物 ${p.generated}: 元にした pin（${generated.pin.commit}）が、適用したときの pin（${harness.pin?.commit}）と違います。apply をやり直してください`);
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

  const applied = complete && copyOk;
  if (applied) lines.push("  → 適用しています（新しく始めたセッションから効きます）");
  else if (registered) lines.push("  → 適用が壊れています（欠けているもの・違うものは上の行のとおり）。apply し直すか remove してください");
  else if (harness !== undefined) lines.push("  → 写しは残っていますが、OMP の設定に登録していないので読み込まれません。apply し直すか remove してください");
  else lines.push("  → 適用していません");

  let userDefinitions: Definition[] = [];
  try {
    if (config !== undefined) userDefinitions = userPlaces(ctx.agentDir, ctx.home, config, p.root).definitions;
  } catch {
    // 設定の値の形が正しくなければ、利用者の置き場は上の「OMP の設定」の行で報告している
  }
  lines.push("どの tdd が使われるか:");
  // 写しの中の pstack の tdd（skills.customDirectories の先頭の置き場）
  const pstackTdd = join(p.skills[0]!, "tdd", "SKILL.md");
  const userTdd = userDefinitions.filter((d) => d.kind === "skill" && d.name === "tdd");
  if (applied && existsSync(pstackTdd)) {
    lines.push(`  pstack の tdd（${pstackTdd}）が使われます（写しの中の生成したスキルの置き場が skills.customDirectories の先頭に入るため）`);
    for (const d of userTdd) lines.push(`  利用者の置き場の tdd（${d.path}）は、名前空間つきの <名前空間>/tdd の名前になります`);
  } else if (userTdd.length > 0) {
    lines.push(`  適用していないので、利用者の置き場の tdd（${userTdd[0]!.path}）が使われます`);
  } else {
    lines.push("  適用していないので、pstack の tdd は使われません（利用者の置き場にも tdd はありません）");
  }

  const project = projectPlaces(cwd, ctx.home);
  const content = packageDefinitions(ctx.packageDir);
  const contentNames = new Set(content.map((d) => `${d.kind}:${d.name}`));
  // 生成したスキルの名前（データ置き場の生成物と、写しの中の生成したスキル）
  const generatedNames = new Set([...(generated?.names ?? []), ...p.skills.flatMap(skillsIn).map((d) => d.name)]);
  const clashes = project.definitions.filter((d) => contentNames.has(`${d.kind}:${d.name}`) || (d.kind === "skill" && generatedNames.has(d.name)));
  lines.push(`プロジェクト（${project.root}）の置き場にある、今回の定義やスキルと同じ名前のもの:`);
  if (clashes.length === 0) lines.push("  ありません");
  for (const d of clashes) lines.push(`  ${d.path}: ${explain(d, generatedNames)}`);
  return lines;
}

function explain(d: Definition, generatedNames: Set<string>): string {
  if (d.kind === "agent") return `エージェント ${d.name}。プロジェクトの定義が優先されるので、このプロジェクトでは今回の定義が使われません`;
  if (generatedNames.has(d.name)) return `スキル ${d.name}。生成したスキル（skills.customDirectories）が優先され、このスキルは <名前空間>/${d.name} の名前になります`;
  return `スキル ${d.name}。今回の読み替え表のスキルと同じ名前なので、どちらかが <名前空間>/${d.name} の名前になり、skill://${d.name} で今回の表を読めないことがあります`;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
