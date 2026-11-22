// pstack を OMP 向けに使う道具の入口。
// 使い方: bun scripts/pstack-omp/cli.ts <サブコマンド>
//   sync  固定の記録（pin.json）どおりに上流を nod のデータ置き場へ取得し、続けて OMP 向けのコピーを生成する（generate.ts）
// 止まったときは理由を標準エラーに出して 1 で終わる。サブコマンドの誤りは 2。
// 置き場と実行ファイルを差し替える環境変数は context.ts を参照。
import { checkOmpVersion, loadContext, PstackOmpError } from "./context";
import { generate } from "./generate";
import { fetchUpstream } from "./upstream";

const USAGE = "使い方: bun scripts/pstack-omp/cli.ts sync";

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

const commands: Record<string, () => void> = { sync };

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
