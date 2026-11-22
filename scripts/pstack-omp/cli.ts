// pstack を OMP 向けに使う道具の入口。
// 使い方: bun scripts/pstack-omp/cli.ts <サブコマンド>
//   sync    固定の記録（pin.json）どおりに上流を nod のデータ置き場へ取得し、続けて OMP 向けのコピーを生成する（generate.ts）
//   apply   利用者の OMP の設定に適用する（harness.ts）。OMP の版が固定の記録と違えば止める
//   remove  適用を解除する（harness.ts）。OMP の版が違っても行える
//   status  適用の状態、どの tdd が使われるか、実行したディレクトリのプロジェクトの置き場の名前のぶつかりを表示する（status.ts）
// 止まったときは理由を標準エラーに出して 1 で終わる。サブコマンドの誤りは 2。
// 置き場と実行ファイルを差し替える環境変数は context.ts を参照。
import { checkOmpVersion, loadContext, PstackOmpError } from "./context";
import { generate } from "./generate";
import { apply, remove } from "./harness";
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

function applyCommand(): void {
  const result = apply(loadContext());
  console.log(`写しを置きました: ${result.root}（OMP 向けのディレクトリ・制御の拡張・生成したスキル）`);
  console.log(
    result.configChanged
      ? `OMP の設定 ${result.configPath} に、extensions（${result.control} と ${result.content}）・skills.customDirectories（写しの中の生成したスキルの置き場）・skills.manualSkills を入れました`
      : `OMP の設定 ${result.configPath} には、extensions・skills.customDirectories・skills.manualSkills の項目が既にあります（変えていません）`,
  );
  console.log(`新しく始めたセッションから、生成したスキルと OMP 向けのディレクトリが読み込まれ、${result.manualSkills} 個のスキルがスキルの一覧から外れます`);
}

function removeCommand(): void {
  const result = remove(loadContext());
  if (!result.configChanged && !result.removedCopy) {
    console.log("適用していません。何も変えていません");
    return;
  }
  if (result.configChanged) {
    console.log(
      result.restoredBytes
        ? `OMP の設定 ${result.configPath} を適用の前に戻しました`
        : `OMP の設定 ${result.configPath} から自分の項目（extensions・skills.customDirectories・skills.manualSkills）を外しました（適用の後に変わったほかの値は保っています）`,
    );
  }
  if (result.removedCopy) console.log("写しを消しました（生成物と上流の clone は残しています）");
  console.log("新しく始めたセッションから、pstack と cursor-team-kit のスキルと今回の定義は読み込まれません");
}

function statusCommand(): void {
  for (const line of status(loadContext(), process.cwd())) console.log(line);
}

const commands: Record<string, () => void> = { sync, apply: applyCommand, remove: removeCommand, status: statusCommand };

const [name, ...rest] = process.argv.slice(2);
const command = name === undefined ? undefined : commands[name];
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
