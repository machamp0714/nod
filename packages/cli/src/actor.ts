import { HUMAN_ACTOR } from "@nod/core";

export function detectActor(env: Record<string, string | undefined> = process.env): string {
  if (env.NOD_ACTOR) return env.NOD_ACTOR;
  if (env.CLAUDECODE === "1") return "claude-code";
  return HUMAN_ACTOR;
}
