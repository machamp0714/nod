// pstack を OMP 向けに使う道具の入口。
// 使い方: bun scripts/pstack-omp/cli.ts <サブコマンド>
//   sync    固定の記録（pin.json）どおりに上流を nod のデータ置き場へ取得し、続けて OMP 向けのコピーを固定の生成先
//           （<データ置き場>/pstack-omp/generated）に生成する（generate.ts）。OMP の版が固定の記録と違えば止める
//   status  生成物の pin と OMP の版、OMP が読む設定ファイルの3つの読み込みの設定（欠けていれば一度だけ登録する値）、通常の omp でどの tdd が
//           使われるか、実行したディレクトリのプロジェクトの置き場の名前のぶつかりを表示する（status.ts）。読むだけで何も書かない
// 読み込みの設定は、利用者が README のとおり一度だけ手で登録し、手で外す。
// 止まったときは理由を標準エラーに出して 1 で終わる。サブコマンドの誤りは 2。
// 置き場と実行ファイルを差し替える環境変数は context.ts を参照。
import { checkOmpVersion, loadContext, PstackOmpError } from "./context";
import { generate } from "./generate";
import { status } from "./status";
import { fetchUpstream } from "./upstream";

const USAGE = "使い方: bun scripts/pstack-omp/cli.ts <sync|status>";

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
  console.log("読み込みの設定は README（pstack を OMP で使う）のとおり一度だけ手で登録します。揃っているかは bun scripts/pstack-omp/cli.ts status で確かめられます");
}

function statusCommand(): void {
  for (const line of status(loadContext(), process.cwd())) console.log(line);
}

const commands: Record<string, () => void> = { sync, status: statusCommand };

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
