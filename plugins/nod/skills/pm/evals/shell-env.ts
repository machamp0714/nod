import { writeFileSync } from "node:fs";
import { join } from "node:path";

const environmentKeys = [
  "PATH", "NOD_DB", "NOD_ACTOR", "NOD_ORCA", "NOD_GH", "PM_EVAL_DIR", "PM_EVAL_LOG", "PM_EVAL_BUN",
  "PM_EVAL_NOD_MAIN", "TYPESAFE_API_KEY", "BUN_OPTIONS", "ORCA_CLI_COMMAND", "NOD_DOCS_DIR", "NOD_ATTACHMENTS_DIR",
];

/** 値全体を一つのシェル引数にし、展開やコマンド置換を防ぐ。 */
export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** 評価で指定する変数だけを保存し、その他の継承変数を出力しない。 */
export function writeEvaluationEnv(directory: string, env: Record<string, string | undefined>, append = false) {
  const exports = Object.entries(env)
    .filter(([key, value]) => environmentKeys.includes(key) && value !== undefined)
    .map(([key, value]) => `export ${key}=${shellQuote(value!)}`);
  writeFileSync(join(directory, "env.sh"), exports.join("\n") + "\n", { flag: append ? "a" : "w" });
}
