import { NodError } from "@nod/core";
import type { Context } from "hono";

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
export type Body = Record<string, unknown>;

// JSON のオブジェクトの本文を読む。空の本文は {} とし、keys にないキーは受け付けない
export async function readBody(c: Context, keys: readonly string[]): Promise<Body> {
  const text = await c.req.text();
  let value: unknown = {};
  if (text.trim()) {
    try {
      value = JSON.parse(text);
    } catch {
      throw invalid("リクエストの本文を JSON として読めません");
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("リクエストの本文は JSON のオブジェクトで送ってください");
  }
  const unknownKeys = Object.keys(value).filter((k) => !keys.includes(k));
  if (unknownKeys.length) {
    throw invalid(`${unknownKeys.join(", ")} は受け付けません（使えるもの: ${keys.length ? keys.join(", ") : "なし"}）`);
  }
  return value as Body;
}

export function optString(body: Body, key: string): string | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw invalid(`${key} は文字列で指定してください`);
  return v;
}

export function reqString(body: Body, key: string): string {
  const v = optString(body, key);
  if (v === undefined) throw invalid(`${key} を指定してください`);
  return v;
}

export function optNullableString(body: Body, key: string): string | null | undefined {
  return body[key] === null ? null : optString(body, key);
}

export function optInt(body: Body, key: string): number | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) throw invalid(`${key} は整数で指定してください`);
  return v;
}

export function optStringArray(body: Body, key: string): string[] | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw invalid(`${key} は文字列の配列で指定してください`);
  }
  return v as string[];
}
