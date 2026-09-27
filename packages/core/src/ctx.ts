import type { Database } from "bun:sqlite";

export interface OpCtx {
  db: Database;
  actor: string;
}

export const HUMAN_ACTOR = "me";

export function isLlm(ctx: OpCtx): boolean {
  return ctx.actor !== HUMAN_ACTOR;
}

export function now(): string {
  return new Date().toISOString();
}
