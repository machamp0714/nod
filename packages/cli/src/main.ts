#!/usr/bin/env bun
import { Command, CommanderError } from "commander";
import pkg from "../package.json";
import { registerHumanCommands } from "./commands/human";
import { registerIssueCommands } from "./commands/issue";
import { registerProjectCommands } from "./commands/project";
import { registerTemplateCommands } from "./commands/template";
import { registerSkillsCommands } from "./commands/skills";
import { registerWorkspaceCommands } from "./commands/workspace";
import { NodError } from "@nod/core";
import { printError } from "./output";

export function buildProgram(): Command {
  const program = new Command("nod")
    .description("LLM が作業し、人が判断するための Issue 管理")
    .version(pkg.version)
    .option("-w, --workspace <keyOrPath>", "Workspace のキーかパス（省略時は現在のディレクトリの git リポジトリ）")
    .option("--json", "JSON で出力する")
    .exitOverride()
    // commander の英語のエラーは出さず、run() で日本語にして出す。ヘルプ（writeErr）はそのまま出す
    .configureOutput({ outputError: () => {} });
  registerIssueCommands(program);
  registerProjectCommands(program);
  registerHumanCommands(program);
  registerWorkspaceCommands(program);
  registerTemplateCommands(program);
  registerSkillsCommands(program);
  return program;
}

// commander のメッセージの '...' で囲まれた部分を順に取り出す
function quoted(message: string): string[] {
  return [...message.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? "");
}

export function translateCommanderError(err: CommanderError): NodError {
  const message = err.message.split("\n")[0] ?? "";
  const [a = "", b = ""] = quoted(message);
  const hint = "（使い方は --help で確認できます）";
  let text: string;
  switch (err.code) {
    case "commander.missingArgument":
      text = `引数 ${a} を指定してください`;
      break;
    case "commander.optionMissingArgument":
      text = `オプション ${a} に値を指定してください`;
      break;
    case "commander.missingMandatoryOptionValue":
      text = `オプション ${a} は必須です`;
      break;
    case "commander.unknownOption":
      text = `オプション ${a} はありません`;
      break;
    case "commander.unknownCommand":
      text = `コマンド ${a} はありません`;
      break;
    case "commander.excessArguments": {
      const [, expected = "?", got = "?"] = /Expected (\d+) arguments? but got (\d+)/.exec(message) ?? [];
      text = `引数が多すぎます${a ? `（${a}）` : ""}。受け付けるのは ${expected} 個ですが、${got} 個渡されました`;
      break;
    }
    case "commander.invalidArgument":
      text = message.startsWith("error: option")
        ? `オプション ${a} の値 ${b} は使えません`
        : `引数 ${b} の値 ${a} は使えません`;
      break;
    default:
      text = `引数が正しくありません（${message.replace(/^error: /, "")}）`;
  }
  return new NodError("INVALID_ARGS", `${text}${hint}`);
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
      const e =
        err.code === "commander.help"
          ? new NodError("INVALID_ARGS", "サブコマンドを指定してください")
          : translateCommanderError(err);
      printError(e, json);
      return 1;
    }
    printError(err, json);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await run(process.argv);
}
