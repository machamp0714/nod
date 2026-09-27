import { NodError } from "@nod/core";

export function invalid(message: string): NodError {
  return new NodError("INVALID_ARGS", message);
}

// パスの数字の ID（Document、View）
export function paramInt(value: string, what: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw invalid(`${what}は正の整数で指定してください（受け取った値: ${value}）`);
  return Number(value);
}

// ?includeClosed=true のような真偽値のクエリパラメータ
export function queryFlag(value: string | undefined, key: string): boolean {
  if (value === undefined || value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return true;
  throw invalid(`${key} は true か false で指定してください（受け取った値: ${value}）`);
}
