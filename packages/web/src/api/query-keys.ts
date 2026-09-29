import type { IssueQuery } from "./types";

// TanStack Query のキー。D、E、G のフックはここからキーを取り、同じデータを別のキーで持たないようにする。
// 1つ目の要素で資源を、2つ目で一覧（list）か詳細（detail）かを分ける。
export const queryKeys = {
  workspaces: () => ["workspaces"] as const,
  issueList: (query: IssueQuery) => ["issues", "list", query] as const,
  issue: (id: string) => ["issues", "detail", id] as const,
  inbox: () => ["inbox"] as const,
  inboxHistory: () => ["inbox", "history"] as const,
  triage: () => ["triage"] as const,
  notifications: () => ["notifications"] as const,
  notificationHistory: () => ["notifications", "history"] as const,
  projectList: (opts: { includeClosed?: boolean }) => ["projects", "list", opts] as const,
  project: (id: number) => ["projects", "detail", id] as const,
  views: () => ["views"] as const,
  document: (id: number) => ["documents", id] as const,
};

// Issue の API のパス。apiFetch に渡す（/api は apiFetch が前置する）
export function issuePath(id: string, op?: string): string {
  const base = `/issues/${encodeURIComponent(id)}`;
  return op ? `${base}/${op}` : base;
}
