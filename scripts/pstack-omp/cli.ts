// pstack を OMP 向けに使う道具の入口。
// 使い方: bun scripts/pstack-omp/cli.ts <サブコマンド>
//   sync    固定の記録（pin.json）どおりに上流を nod のデータ置き場へ取得し、続けて OMP 向けのコピーを生成する（generate.ts）
//   apply   データ置き場に写しと専用ランチャーを置く（harness.ts）。利用者の OMP の設定には読み込みの設定を書かない。OMP の版が固定の記録と違えば止める
//   remove  写しと専用ランチャーを消す（harness.ts）。OMP の版が違っても行える
//   status  適用の状態、どの tdd が使われるか、実行したディレクトリのプロジェクトの置き場の名前のぶつかりを表示する（status.ts）
// apply と remove は、以前の配置（config.yml に読み込みの設定を入れた適用）の項目が config.yml に残っていれば、それだけを取り除く。
// 止まったときは理由を標準エラーに出して 1 で終わる。サブコマンドの誤りは 2。
// 置き場と実行ファイルを差し替える環境変数は context.ts を参照。
import { checkOmpVersion, loadContext, PstackOmpError } from "./context";
import { generate } from "./generate";
import { apply, type Cleanup, entryGuide, remove } from "./harness";
import { status } from "./status";
import { fetchUpstream } from "./upstream";

const USAGE = "使い方: bun scripts/pstack-omp/cli.ts <sync|apply|remove|status>";

function sync(): void {
  const ctx = loadContext();
  // OMP の版が違えば、置き場に何も作らずに止める
  checkOmpVersion(ctx);
  const upstream = fetchUpstream(ctx);
  const how = upstream.cloned ? "新しく clone" : "既存の clone を再利用";
  console.log(`上流を取得しました（${how}）: ${ctx.pin.repository} ${ctx.pin.commit}（pstack ${ctx.pin.pstackVersion}）→ ${upstream.dir}`);
  const generated = generate(ctx, upstream.dir);
  const guided = generated.guided.pstack.length + generated.guided["cursor-team-kit"].length;
  console.log(
    `OMP 向けのコピーを生成しました: ${generated.dir}（pstack ${generated.skills.pstack.length} 個、cursor-team-kit ${generated.skills["cursor-team-kit"].length} 個、` +
      `案内の1行を入れたスキル ${guided} 個）`,
  );
  for (const [key, skills] of generated.terms) console.log(`  ${key}（使うスキル: ${skills.join(", ")}）`);
}

// 以前の配置の項目を取り除いた結果の報告
function reportLegacy(configPath: string, legacy: Cleanup): void {
  if (legacy.changed) {
    console.log(
      legacy.restoredBytes
        ? `OMP の設定 ${configPath} に残っていた以前の配置の読み込みの設定を取り除きました（以前の適用の前のバイトに戻しました）`
        : `OMP の設定 ${configPath} から、以前の配置の読み込みの設定（写しを指す extensions・skills.customDirectories と、記録にある skills.manualSkills の名前）だけを取り除きました（ほかの値は保っています）`,
    );
  }
  if (legacy.kept.length > 0) {
    console.log(
      `OMP の設定 ${configPath} の skills.manualSkills に、以前の配置が足したかもしれない名前 ${legacy.kept.join(", ")} が残っています（以前の配置の記録が無いので、外していません）。要らなければ手で外してください`,
    );
  }
}

function applyCommand(): void {
  const result = apply(loadContext());
  console.log(`写しを置きました: ${result.root}（OMP 向けのディレクトリ・制御の拡張・生成物・専用ランチャー）`);
  console.log(`OMP の設定 ${result.configPath} には読み込みの設定を書いていません（通常の omp には pstack を読み込みません）`);
  reportLegacy(result.configPath, result.legacy);
  for (const path of result.userTdd) {
    console.log(`利用者の置き場の tdd（${path}）より、専用ランチャーから起動したセッションでは pstack の tdd が優先されます（通常の omp では利用者の tdd が使われます）`);
  }
  console.log(`専用ランチャーから起動したセッションでは、生成したスキルと OMP 向けのディレクトリが読み込まれ、${result.manualSkills} 個のスキルがスキルの一覧から外れます`);
  for (const line of entryGuide(result.launcher)) console.log(line);
}

function removeCommand(): void {
  const result = remove(loadContext());
  if (!result.legacy.changed && result.legacy.kept.length === 0 && !result.removedCopy) {
    console.log("適用していません。何も変えていません");
    return;
  }
  reportLegacy(result.configPath, result.legacy);
  if (result.removedCopy) console.log("写し（専用ランチャー・制御の拡張・生成物の写し）を消しました（データ置き場の生成物と上流の clone は残しています）");
  console.log("専用ランチャーは無くなりました。通常の omp は pstack と cursor-team-kit のスキルと今回の定義を読み込みません");
}

function statusCommand(): void {
  for (const line of status(loadContext(), process.cwd())) console.log(line);
}

const commands: Record<string, () => void> = { sync, apply: applyCommand, remove: removeCommand, status: statusCommand };

const [name, ...rest] = process.argv.slice(2);
// 自分のプロパティだけを引く（toString などの継承されたものをサブコマンドとみなさない）
const command = name !== undefined && Object.hasOwn(commands, name) ? commands[name] : undefined;
if (command === undefined || rest.length > 0) {
  console.error(USAGE);
  process.exit(2);
}
try {
  command();
} catch (e) {
  if (!(e instanceof PstackOmpError)) throw e;
  console.error(`止めました: ${e.message}`);
  process.exit(1);
}
