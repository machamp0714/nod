import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "nod-test-")), "nod.db");
}

export function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}
