import type { Status, WorkspaceLabel } from "../api/types";
import { STATUS_META, STATUS_ORDER } from "./meta";

// ステータスから表示名への対応（既定名から変えたものだけ）。Workspace のキーごとに持つ
export type StatusNames = Partial<Record<Status, string>>;
export type StatusNamesByWorkspace = Record<string, StatusNames>;

export const STATUS_NAME_MAX_LENGTH = 30;

// ラベル定義の色の選択肢。先頭の灰色が未選択時の既定で、残りは Workspace の色と同じ並び
export const LABEL_COLORS: readonly { value: string; name: string }[] = [
  { value: "#8A919E", name: "灰" },
  { value: "#7C5CFF", name: "紫" },
  { value: "#0D9768", name: "緑" },
  { value: "#C36B04", name: "橙" },
  { value: "#DB2777", name: "桃" },
  { value: "#2563EB", name: "青" },
  { value: "#0F766E", name: "青緑" },
  { value: "#B91C1C", name: "赤" },
  { value: "#6D28D9", name: "菫" },
  { value: "#A16207", name: "黄土" },
  { value: "#0369A1", name: "藍" },
  { value: "#4D7C0F", name: "草" },
  { value: "#BE123C", name: "紅" },
];

// 選択肢にない色（CLI で付けたもの）も選択中の値として出せるよう、先頭に足す
export function labelColorChoices(current: string): { value: string; name: string }[] {
  return LABEL_COLORS.some((c) => c.value === current) ? [...LABEL_COLORS] : [{ value: current, name: current }, ...LABEL_COLORS];
}

// Issue のラベルの表示色（#117）。Issue の Workspace で定義した色を返し、未定義なら null（既定の灰色で描く）。
// ラベル名は Workspace ごとに別なので、Workspace と名前の組で引く
export function labelColor(labels: readonly WorkspaceLabel[] | undefined, workspace: string | null | undefined, name: string): string | null {
  if (!workspace || !labels) return null;
  const key = workspace.toUpperCase();
  return labels.find((l) => l.workspaceKey.toUpperCase() === key && l.name === name)?.color ?? null;
}

// Issue の Workspace で設定された表示名。Workspace が分からないときや未設定なら既定名
export function statusName(status: Status, names: StatusNamesByWorkspace | undefined, workspace: string | null | undefined): string {
  return (workspace ? names?.[workspace]?.[status] : undefined) ?? STATUS_META[status].label;
}

// 一覧の列見出しや絞り込みの選択肢は、Workspace を1つに絞ったときだけ表示名を使う
export function singleWorkspace(workspaces: readonly string[] | undefined): string | null {
  return workspaces?.length === 1 ? workspaces[0]!.toUpperCase() : null;
}

// 表示名の下書き。入力欄の値（空は既定）を保存済みと比べる
export function statusNamesEditState(draft: StatusNames, saved: StatusNames) {
  const normalized: StatusNames = {};
  for (const status of STATUS_ORDER) {
    const value = (draft[status] ?? "").trim();
    if (value && value !== STATUS_META[status].label) normalized[status] = value;
  }
  const tooLong = STATUS_ORDER.filter((status) => (normalized[status]?.length ?? 0) > STATUS_NAME_MAX_LENGTH);
  const shown = STATUS_ORDER.map((status) => normalized[status] ?? STATUS_META[status].label);
  const duplicated = shown.find((name, i) => shown.indexOf(name) !== i) ?? null;
  const changed = STATUS_ORDER.some((status) => (normalized[status] ?? "") !== (saved[status] ?? ""));
  const empty = STATUS_ORDER.every((status) => !(draft[status] ?? "").trim());
  return { normalized, tooLong, duplicated, changed, empty, canSave: changed && tooLong.length === 0 && duplicated === null };
}

// Issue の ID（API-12）から Workspace のキーを取る。Workspace を持たない一覧の行で使う
export function workspaceOfIssueId(id: string): string {
  return id.slice(0, id.lastIndexOf("-"));
}
