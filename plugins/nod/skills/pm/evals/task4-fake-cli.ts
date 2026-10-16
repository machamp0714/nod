import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { runTask4Cli } from "./task4-cli";

const [tool, ...argv] = process.argv.slice(2);
const dir = process.env.PM_EVAL_DIR!;
appendFileSync(process.env.PM_EVAL_LOG!, JSON.stringify({ tool, argv, actor: "codex", origin: process.env.PM_EVAL_ORIGIN ?? "pm", at: new Date().toISOString() }) + "\n");
if (tool === "nod") {
  const result = Bun.spawnSync([process.env.PM_EVAL_BUN!, process.env.PM_EVAL_NOD_MAIN!, ...argv], { env: { ...process.env, NOD_DB: join(dir, "nod.db"), NOD_ACTOR: "codex", NOD_ORCA: "0", NOD_DOCS_DIR: join(dir, "documents"), NOD_ATTACHMENTS_DIR: join(dir, "attachments"), NOD_GH: join(dir, "bin/gh") }, stdout: "inherit", stderr: "inherit" });
  process.exit(result.exitCode);
}
runTask4Cli(tool!, argv);
