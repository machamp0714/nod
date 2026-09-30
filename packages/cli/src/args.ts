import { DOC_KINDS, type DocKind, NodError, PROJECT_HEALTH_CLEAR, PROJECT_HEALTHS, PROJECT_STATUSES, type ProjectHealth, type ProjectStatus, STATUSES, type Status, STEP_STATUSES, type StepStatus } from "@nod/core";

export function collect(value: string, prev: string[] = []): string[] {
  return [...prev, value];
}

function oneOf<T extends string>(value: string, list: readonly T[], what: string): T {
  if (!list.includes(value as T)) {
    throw new NodError("INVALID_ARGS", `${what}「${value}」は使えません（使えるもの: ${list.join(", ")}）`);
  }
  return value as T;
}

export function parseStatus(value: string): Status {
  return oneOf(value, STATUSES, "ステータス");
}

export function parseProjectStatus(value: string): ProjectStatus {
  return oneOf(value, PROJECT_STATUSES, "Project のステータス");
}

export function parseProjectHealth(value: string): ProjectHealth | typeof PROJECT_HEALTH_CLEAR {
  return oneOf(value, [...PROJECT_HEALTHS, PROJECT_HEALTH_CLEAR] as const, "Project の健全性");
}

export function parseStatuses(value: string): Status[] {
  return value.split(",").map((s) => parseStatus(s.trim()));
}

export function parseStepStatus(value: string): StepStatus {
  return oneOf(value, STEP_STATUSES, "状態");
}

export function parseDocKind(value: string): DocKind {
  return oneOf(value, DOC_KINDS, "種類");
}

export function parsePriority(value: string): number {
  if (!/^P?[0-4]$/i.test(value)) {
    throw new NodError("INVALID_ARGS", "優先度は 0〜4 で指定してください（0 = なし、1 = Urgent、2 = High、3 = Medium、4 = Low）");
  }
  return Number(value.replace(/^P/i, ""));
}

// 範囲（1〜100）は core が検証する
export function parseEstimate(value: string): number {
  if (!/^\d+$/.test(value)) throw new NodError("INVALID_ARGS", "見積もりは 1〜100 の整数（ポイント）で指定してください");
  return Number(value);
}

// 空文字は「外す」（null）として扱う
export function orNull(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === "" ? null : value;
}

export function parsePositiveInt(value: string, what: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) === 0) {
    throw new NodError("INVALID_ARGS", `${what}は正の整数で指定してください（例: 3）`);
  }
  return Number(value);
}

export function parsePort(value: string): number {
  const port = Number(value);
  if (!/^\d+$/.test(value) || port > 65535) {
    throw new NodError("INVALID_ARGS", "ポートは 0〜65535 の整数で指定してください（0 なら空いているポートを使う）");
  }
  return port;
}
