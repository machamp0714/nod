// Summary（最近の動き）画面の純粋な計算。条件は URL の search に持ち、API の /api/summary に渡す
import type { Status, Summary, SummaryItem, SummaryKind } from "../api/types";

export type SummaryPeriod = "24h" | "7d" | "30d";
export const SUMMARY_PERIODS: readonly SummaryPeriod[] = ["24h", "7d", "30d"];

export interface SummarySearch {
  since?: SummaryPeriod; // 省略時は 24h
  workspace?: string; // Workspace のキー
  project?: string; // Project の数字の ID
  archived?: boolean; // アーカイブ済み Issue の動きも含める
}

// 種類ごとに最初に並べる件数。「他 N 件を表示」で上限まで広げる
export const SUMMARY_PAGE = 10;
export const SUMMARY_EXPANDED_LIMIT = 200;

// URL を手で書き換えられても既定の表示に戻れるよう、知らない値は捨てる。
// Router は元の search に戻り値を重ねるため、不正な値のキーは undefined で上書きする
export function parseSummarySearch(raw: Record<string, unknown>): SummarySearch {
  const since = SUMMARY_PERIODS.includes(raw.since as SummaryPeriod) ? (raw.since as SummaryPeriod) : undefined;
  const workspace = typeof raw.workspace === "string" && raw.workspace.trim() ? raw.workspace.trim().toUpperCase() : undefined;
  const project = typeof raw.project === "number" ? String(raw.project) : raw.project;
  const out: SummarySearch = {
    since,
    workspace,
    project: typeof project === "string" && /^[1-9]\d*$/.test(project) ? project : undefined,
    archived: raw.archived === true || raw.archived === "true" ? true : undefined,
  };
  for (const key of Object.keys(out) as (keyof SummarySearch)[]) {
    if (out[key] === undefined && !(key in raw)) delete out[key];
  }
  return out;
}

// 既定値と同じものは URL に残さない
export function cleanSummarySearch(search: SummarySearch): SummarySearch {
  const out: SummarySearch = {};
  if (search.since && search.since !== "24h") out.since = search.since;
  if (search.workspace) out.workspace = search.workspace;
  if (search.project) out.project = search.project;
  if (search.archived) out.archived = true;
  return out;
}

export function summaryQueryString(search: SummarySearch, limit: number): string {
  const params = new URLSearchParams({ since: search.since ?? "24h", limit: String(limit) });
  if (search.workspace) params.set("workspace", search.workspace);
  if (search.project) params.set("project", search.project);
  if (search.archived) params.set("includeArchived", "true");
  return params.toString();
}

// 画面の区分。質問と回答は1つにまとめる
export type SummaryGroup = "completed" | "canceled" | "started" | "submitted" | "rejected" | "qa" | "created" | "archived" | "blocker";

const GROUP_KINDS: Record<SummaryGroup, readonly SummaryKind[]> = {
  completed: ["completed"],
  canceled: ["canceled"],
  started: ["started"],
  submitted: ["submitted"],
  rejected: ["rejected"],
  qa: ["asked", "answered"],
  created: ["created"],
  archived: ["archived"],
  blocker: ["blocker"],
};

export const GROUP_LABEL: Record<SummaryGroup, string> = {
  completed: "完了",
  canceled: "キャンセル",
  started: "着手",
  submitted: "レビュー提出",
  rejected: "差し戻し",
  qa: "質問/回答",
  created: "新規起票",
  archived: "アーカイブ",
  blocker: "ブロッカー",
};

// 件数カードの並び（nod.pen の Kind Counts）と、一覧の並び（人の対応が要るものから）
export const CARD_ORDER: readonly SummaryGroup[] = ["completed", "canceled", "started", "submitted", "rejected", "qa", "created", "archived", "blocker"];
export const SECTION_ORDER: readonly SummaryGroup[] = ["blocker", "rejected", "qa", "completed", "submitted", "started", "created", "canceled", "archived"];

export interface SummaryGroupView {
  group: SummaryGroup;
  label: string;
  total: number;
  human: number;
  llm: number;
  items: SummaryItem[];
  more: number;
}

// API の種類別の結果を画面の区分にまとめる。広げていない区分は SUMMARY_PAGE 件に切り詰め、残りを more に数える
export function summaryGroups(summary: Summary, expanded: ReadonlySet<SummaryGroup> = new Set()): Map<SummaryGroup, SummaryGroupView> {
  const byKind = new Map(summary.sections.map((x) => [x.kind, x]));
  return new Map(CARD_ORDER.map((group) => {
    const sections = GROUP_KINDS[group].map((kind) => byKind.get(kind)).filter((x) => x !== undefined);
    const all = sections.flatMap((x) => x.items).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const total = sections.reduce((n, x) => n + x.total, 0);
    const items = expanded.has(group) ? all : all.slice(0, SUMMARY_PAGE);
    return [group, {
      group,
      label: GROUP_LABEL[group],
      total,
      human: sections.reduce((n, x) => n + x.human, 0),
      llm: sections.reduce((n, x) => n + x.llm, 0),
      items,
      more: total - items.length,
    }];
  }));
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// 今日の動きは時刻だけ、それより前は日付も付ける（ブラウザのローカル時刻）
export function summaryTime(at: string, now: Date): string {
  const d = new Date(at);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

// 行の補足。遷移はステータスの表示名で、理由・質問・回答は前置きを付ける
export function summaryNote(item: SummaryItem, statusLabel: (status: Status) => string): string {
  switch (item.kind) {
    case "rejected":
      return item.detail ? `理由: ${item.detail}` : "";
    case "asked":
      return item.detail ? `質問: ${item.detail}` : "";
    case "answered":
      return item.detail ? `回答: ${item.detail}` : "";
    case "archived":
      return item.detail ? `理由: ${item.detail}` : "";
    case "blocker":
      return item.detail ?? "";
    case "created":
      return "";
    default:
      return item.from && item.to ? `${statusLabel(item.from)} → ${statusLabel(item.to)}` : "";
  }
}

export function actorLabel(item: Pick<SummaryItem, "actor" | "actorKind">): string {
  return item.actorKind === "human" ? `人 · ${item.actor}` : item.actor;
}

// Issue ID（API-12）から Workspace のキーを取り出す
export function workspaceKeyOf(issueId: string): string {
  return issueId.slice(0, issueId.lastIndexOf("-"));
}
