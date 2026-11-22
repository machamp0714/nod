// 専用ランチャー（写しの bin/omp）が omp を起動する前に、同じプロファイルのサンドボックスの中で実行する組の検証（verify.ts）。
// 使い方: bun --no-env-file control/preflight.ts <omp を起動する作業ディレクトリ>
// （ランチャーは、作業中のプロジェクトの .env と bunfig.toml を読ませないため、写しの control を作業ディレクトリにして実行し、
// omp を起動する作業ディレクトリを引数で渡す。どのプロジェクトでも書かせないパスはそこで試す）
// 通れば何も出さずに 0、通らなければ理由を標準エラーに出して 1 で終わる（ランチャーは omp を起動しない）。
import { dirname, join } from "node:path";
import { LAUNCHER_FILE, real, verify } from "./verify";

const cwd = process.argv[2];
if (cwd === undefined) {
  process.stderr.write("pstack-omp: omp を起動する作業ディレクトリが渡されていません。omp を起動しません\n");
  process.exit(1);
}
const verdict = verify(import.meta.dir, real(cwd));
if (verdict.kind === "blocked") {
  const advice = verdict.confinement
    ? `${join(dirname(import.meta.dir), LAUNCHER_FILE)} のプロファイルで閉じ込められていないので、omp を起動しません`
    : "omp を起動しません。bun scripts/pstack-omp/cli.ts status で確かめ、apply し直すか remove してください";
  process.stderr.write(`pstack-omp: ${verdict.reason}。${advice}\n`);
  process.exit(1);
}
