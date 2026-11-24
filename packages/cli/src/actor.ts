import { HUMAN_ACTOR } from "@nod/core";

export function detectActor(env: Record<string, string | undefined> = process.env): string {
  if (env.NOD_ACTOR) return env.NOD_ACTOR;
  if (env.OMPCODE === "1") return "omp";
  if (env.CLAUDECODE === "1") return "claude-code";
  if (env.CODEX_THREAD_ID) return "codex";
  return HUMAN_ACTOR;
}
