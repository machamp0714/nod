import type { Database } from "bun:sqlite";
import { NodError } from "../errors";

export function resolveProject(db: Database, ref: string): { id: number; name: string } {
  const row = (
    /^\d+$/.test(ref)
      ? db.query("SELECT id, name FROM projects WHERE id = ?").get(Number(ref))
      : db.query("SELECT id, name FROM projects WHERE name = ?").get(ref)
  ) as { id: number; name: string } | null;
  if (!row) throw new NodError("NOT_FOUND", `Project ${ref} はありません`);
  return row;
}
