import { NodError } from "@nod/core";
import type { Command } from "commander";
import { globalOpts } from "../context";
import { GUIDE } from "../guide";
import { print } from "../output";

const SKILLS: Record<string, string> = { nod: GUIDE };

export function registerSkillsCommands(program: Command): void {
  const skills = program.command("skills").description("LLM 向けの手引きを出力する");
  skills
    .command("get <name>")
    .description("手引きを出力する")
    .action((name: string, _o: unknown, cmd: Command) => {
      const guide = SKILLS[name];
      if (!guide) {
        throw new NodError("UNKNOWN_SKILL", `手引き ${name} はありません（あるもの: ${Object.keys(SKILLS).join(", ")}）`);
      }
      print(globalOpts(cmd), { name, guide }, () => guide);
    });
}
