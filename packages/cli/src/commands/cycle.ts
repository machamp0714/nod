import { NodError } from "@nod/core";
import type { Command } from "commander";

export function cycleRetired(): never {
  throw new NodError("CYCLE_RETIRED", "Cycleと--cycleは廃止されました。履歴は nod sprint list/show、検索は --sprint UUID・番号・current・none を利用してください。SprintへのIssueの追加は nod sprint add <sprint> <issue> で行います");
}

export function registerCycleCommands(program: Command): void {
  program.command("cycle", { hidden: true })
    .description("廃止済み。nod sprint list/showへ移行してください")
    .argument("[args...]")
    .allowUnknownOption()
    .allowExcessArguments()
    .action(cycleRetired);
}
