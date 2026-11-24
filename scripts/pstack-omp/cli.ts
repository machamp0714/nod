// pstack を OMP 向けに使う道具の入口。
// 使い方: bun scripts/pstack-omp/cli.ts <サブコマンド>
//   sync    固定の記録（pin.json）どおりに上流を nod のデータ置き場へ取得し、続けて OMP 向けのコピーを生成する（generate.ts）
//   apply   データ置き場に写しを置き、OMP が global の設定として読むファイル（config.yml、無ければ config.yaml）に3つの読み込みの設定を入れる
//           （harness.ts）。OMP の版が固定の記録と違えば止める
//   remove  設定ファイルを適用の前に戻し（変わっていれば管理対象の項目だけを外し）、写しを消す（harness.ts）。OMP の版が違っても行える
//   status  適用の状態、通常の omp でどの tdd が使われるか、実行したディレクトリのプロジェクトの置き場の名前のぶつかりを表示する（status.ts）
// apply と remove は、旧管理配置（専用ランチャーの写し、config.yml に制御と読み込みの設定を入れた配置）が残っていれば、それを取り除く。
// 止まったときは理由を標準エラーに出して 1 で終わる。サブコマンドの誤りは 2。
// 置き場と実行ファイルを差し替える環境変数は context.ts を参照。
import { checkOmpVersion, loadContext, PstackOmpError } from "./context";
import { generate } from "./generate";
import { apply, type Cleanup, remove } from "./harness";
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

// 前の適用の項目を設定ファイルから取り除いた結果の報告（旧管理配置からか、この道具の適用の解除か）
function reportCleanup(cleanup: Cleanup): void {
  const what = cleanup.legacy ? "旧管理配置" : "管理対象";
  if (cleanup.legacyCopy) console.log("旧管理配置の写し（専用ランチャー・制御の拡張・規則・サンドボックスのプロファイル）を消しました");
  for (const { path, how } of cleanup.changed) {
    if (how === "restored") console.log(`OMP の設定 ${path} を${cleanup.legacy ? "旧管理配置の" : ""}適用の前のバイトに戻しました`);
    else if (how === "recorded") {
      console.log(`OMP の設定 ${path} から、${what}の項目（写しの中を指す extensions・skills.customDirectories と、記録にある skills.manualSkills の名前）だけを外しました（ほかの値は保っています）`);
    } else console.log(`OMP の設定 ${path} から、写しの中を指す extensions・skills.customDirectories の項目だけを外しました（ほかの値は保っています）`);
  }
  for (const { path, names } of cleanup.kept) {
    console.log(
      `OMP の設定 ${path} の skills.manualSkills に、旧管理配置が足したかもしれない名前 ${names.join(", ")} が残っています（旧管理配置の記録が無いので、外していません）。要らなければ手で外してください`,
    );
  }
}

function applyCommand(): void {
  const result = apply(loadContext());
  console.log(`写しを置きました: ${result.root}（OMP 向けのディレクトリと生成物）`);
  reportCleanup(result.cleanup);
  console.log(
    result.configChanged
      ? `OMP の設定 ${result.configPath} に読み込みの設定を入れました（既にある値とほかのキーは保っています）:`
      : `OMP の設定 ${result.configPath} は既に読み込みの設定のとおりなので、変えていません:`,
  );
  console.log(`  extensions に ${result.content}`);
  console.log(`  skills.customDirectories の先頭に ${result.skillDirectories.join(", ")}`);
  console.log(`  skills.manualSkills に ${result.manualSkills} 個のスキル（スキルの一覧から外れます。名前で呼べば使えます）`);
  for (const path of result.userTdd) {
    console.log(`利用者の置き場の tdd（${path}）より、pstack の tdd が優先されます（利用者の tdd は <名前空間>/tdd の名前になります）`);
  }
  console.log("新しく始める omp のセッションから、pstack の生成したスキル・読み替え表・poteto-agent が読み込まれます（実行中のセッションには入りません）");
}

function removeCommand(): void {
  const result = remove(loadContext());
  const { cleanup } = result;
  if (cleanup.changed.length === 0 && cleanup.kept.length === 0 && !result.removedCopy) {
    console.log("適用していません。何も変えていません");
    return;
  }
  reportCleanup(cleanup);
  if (result.removedCopy) console.log(`写し ${result.root} を消しました（データ置き場の生成物と上流の clone は残しています）`);
  console.log("次に始める omp のセッションから、pstack の生成したスキル・読み替え表・poteto-agent を読み込みません");
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
