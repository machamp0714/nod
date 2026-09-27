export class NodError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NodError";
  }
}

function isBusy(err: unknown): boolean {
  const e = err as { code?: unknown; errno?: unknown; message?: unknown } | null;
  if (!e) return false;
  if (typeof e.code === "string" && e.code.startsWith("SQLITE_BUSY")) return true;
  if (e.errno === 5) return true;
  return typeof e.message === "string" && e.message.includes("database is locked");
}

export function toNodError(err: unknown): unknown {
  if (err instanceof NodError) return err;
  if (isBusy(err)) {
    return new NodError("DB_BUSY", "DB がほかの処理にロックされています。少し待ってから再実行してください");
  }
  return err;
}
