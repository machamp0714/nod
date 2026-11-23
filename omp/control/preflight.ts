// 専用ランチャー（写しの bin/omp）が omp を起動する前に、同じプロファイルのサンドボックスの中で実行する組の検証（verify.ts）。
// 使い方: bun --no-env-file control/preflight.ts <ランチャーを呼んだディレクトリ> [omp に渡す引数...]
// （ランチャーは、作業中のプロジェクトの .env と bunfig.toml を読ませないため、写しの control を作業ディレクトリにして実行し、
// 呼んだディレクトリと、続けて omp に渡す引数をそのまま渡す。OMP の設定の置き場は、引数の --profile とランチャーが渡す環境変数で決める。
// どのプロジェクトでも書かせないパスは、呼んだディレクトリと引数の --cwd の全部の値（呼んだディレクトリを基準に解く）のどれも作業ディレクトリとして、
// それぞれと祖先（ファイルシステムの根まで）で試す）
// omp に渡す引数に --config（--config=<値> の形も）があれば通さない（利用者の設定の重ねは、ランチャーが渡す写しの重ねの後に合わされ、
// 規則の bash の拒否の前に要素を足したり [] で消したりできる）。
// 通れば何も出さずに 0、通らなければ理由を標準エラーに出して 1 で終わる（ランチャーは omp を起動しない）。
import { dirname, join } from "node:path";
import { launchDirs, LAUNCHER_FILE, real, verify } from "./verify";

const [cwd, ...args] = process.argv.slice(2);
if (cwd === undefined) {
  process.stderr.write("pstack-omp: omp を起動する作業ディレクトリが渡されていません。omp を起動しません\n");
  process.exit(1);
}
const config = args.find((arg) => arg === "--config" || arg.startsWith("--config="));
if (config !== undefined) {
  process.stderr.write(`pstack-omp: omp に設定の重ね（${config}）が渡されています。規則の bash の拒否を外し得るので、--config を外して起動してください。omp を起動しません\n`);
  process.exit(1);
}
const dirs = launchDirs(real(cwd), args);
if (typeof dirs === "string") {
  process.stderr.write(`pstack-omp: omp を起動する作業ディレクトリを決められません: ${dirs}。omp を起動しません\n`);
  process.exit(1);
}
const verdict = verify(import.meta.dir, dirs, args);
if (verdict.kind === "blocked") {
  const advice = verdict.confinement
    ? `${join(dirname(import.meta.dir), LAUNCHER_FILE)} のプロファイルで閉じ込められていないので、omp を起動しません`
    : "omp を起動しません。bun scripts/pstack-omp/cli.ts status で確かめ、apply し直すか remove してください";
  process.stderr.write(`pstack-omp: ${verdict.reason}。${advice}\n`);
  process.exit(1);
}
