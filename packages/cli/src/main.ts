#!/usr/bin/env bun
import { Command, CommanderError } from "commander";
import pkg from "../package.json";
import { registerHumanCommands } from "./commands/human";
import { registerIssueCommands } from "./commands/issue";
import { registerProjectCommands } from "./commands/project";
import { registerSkillsCommands } from "./commands/skills";
import { registerWorkspaceCommands } from "./commands/workspace";
import { printError } from "./output";

export function buildProgram(): Command {
  const program = new Command("nod")
    .description("LLM が作業し、人が判断するための Issue 管理")
    .version(pkg.version)
    .option("-w, --workspace <keyOrPath>", "Workspace のキーかパス（省略時は現在のディレクトリの git リポジトリ）")
    .option("--json", "JSON で出力する")
    .exitOverride()
    .showHelpAfterError();
  registerIssueCommands(program);
  registerProjectCommands(program);
  registerHumanCommands(program);
  registerWorkspaceCommands(program);
  registerSkillsCommands(program);
  return program;
}

export async function run(argv: string[]): Promise<number> {
  // -- の後ろは位置引数なので、--json の検出はその前だけを見る
  const sep = argv.indexOf("--");
  const json = (sep === -1 ? argv : argv.slice(0, sep)).includes("--json");
  try {
    await buildProgram().parseAsync(argv);
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // --help と --version を明示したときだけ 0。サブコマンドを省いたときのヘルプ（commander.help）は 1 で返る
      if (err.exitCode === 0) return 0;
      // commander は引数の誤りを標準エラーに出力済み。--json のときは JSON でも返す
      if (json) {
        const message = err.code === "commander.help" ? "サブコマンドを指定してください" : err.message;
        console.log(JSON.stringify({ error: { code: "INVALID_ARGS", message } }, null, 2));
      }
      return 1;
    }
    printError(err, json);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await run(process.argv);
}
