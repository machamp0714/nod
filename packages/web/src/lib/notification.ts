import type { Notification, Status } from "../api/types";
import { formatEstimate } from "./due-date";
import { priorityMeta, STATUS_META } from "./meta";

// 通知1件の文。short は一覧の行で使い、コメント本文や理由を省く
export function describeNotification(n: Notification, opts: { short?: boolean } = {}): string {
  const d = n.data as { from?: unknown; to?: unknown; added?: string[]; removed?: string[]; reason?: string };
  const quote = (text: string | null | undefined) => (text && !opts.short ? `：「${text}」` : "");
  const to = d.to === null || d.to === undefined || d.to === "" ? null : d.to;
  const who = n.actor;
  switch (n.eventType) {
    case "status_changed":
      return `${who} がステータスを ${STATUS_META[to as Status]?.label ?? String(to)} に変更しました`;
    case "priority_changed":
      return `${who} が優先度を ${priorityMeta(Number(to ?? 0)).label} に変更しました`;
    case "estimate_changed":
      return to === null ? `${who} が見積もりを外しました` : `${who} が見積もりを ${formatEstimate(Number(to))} に変更しました`;
    case "due_date_changed":
      return to === null ? `${who} が期限を外しました` : `${who} が期限を ${String(to)} に変更しました`;
    case "assignee_changed":
      return to === null ? `${who} が担当者を外しました` : `${who} が担当者を ${String(to)} に変更しました`;
    case "title_changed":
      return `${who} がタイトルを${opts.short ? "" : `「${String(to ?? "")}」に`}変更しました`;
    case "project_changed":
      return to === null ? `${who} が Project から外しました` : `${who} が Project を ${String(to)} に変更しました`;
    case "labels_changed": {
      const parts = [...(d.added ?? []).map((l) => `+${l}`), ...(d.removed ?? []).map((l) => `-${l}`)];
      return `${who} がラベルを変更しました${opts.short || parts.length === 0 ? "" : `（${parts.join(" ")}）`}`;
    }
    case "comment_added":
      return `${who} がコメントしました${quote(n.body)}`;
    case "review_approved":
      return `${who} がレビューを承認しました`;
    case "review_rejected":
      return `${who} が差し戻しました${quote(d.reason)}`;
    case "triage_accepted":
      return `${who} が Triage を受け入れました`;
    case "triage_declined":
      return `${who} が Triage を却下しました${quote(d.reason)}`;
    case "agent_state_changed":
      if (to === "done") return `${who} が作業を完了しました（レビュー待ち）`;
      if (to === "awaiting_input") return `${who} が確認を求めました（入力待ち）${quote(d.reason)}`;
      if (to === "error") return `${who} がエラーで止まりました（エラー）${quote(d.reason)}`;
      return `${who} ${n.eventType}`;
    default:
      return `${who} ${n.eventType}`;
  }
}

export interface NotificationGroup {
  issueId: string;
  issueTitle: string;
  workspace: string;
  notifications: Notification[]; // 新しい順
  latest: Notification;
  unread: number;
}

// server は通知を新しい順で返す。画面は Issue ごとに1項目にまとめる
export function groupNotifications(list: readonly Notification[]): NotificationGroup[] {
  const groups = new Map<string, NotificationGroup>();
  for (const item of list) {
    const group = groups.get(item.issueId);
    if (group) {
      group.notifications.push(item);
      if (item.createdAt > group.latest.createdAt) group.latest = item;
    } else {
      groups.set(item.issueId, { issueId: item.issueId, issueTitle: item.issueTitle, workspace: item.workspace, notifications: [item], latest: item, unread: 0 });
    }
  }
  for (const group of groups.values()) group.unread = group.notifications.filter((x) => x.readAt === null).length;
  return [...groups.values()].sort((a, b) => b.latest.createdAt.localeCompare(a.latest.createdAt) || a.issueId.localeCompare(b.issueId));
}

// 一覧の行の要約。「claude-code がコメントしました ほか 2 件」
export function groupSummary(group: NotificationGroup): string {
  const rest = group.notifications.length - 1;
  return `${describeNotification(group.latest, { short: true })}${rest > 0 ? ` ほか ${rest} 件` : ""}`;
}

// 開いている Issue の通知を既読にするかどうか。markedUpTo は、これまでに既読にした時点の最新の未読 id。
// それより新しい未読が届いたら（開いたままの間に来た通知も）その id を返し、なければ null
export function unreadToMark(group: NotificationGroup, markedUpTo: number): number | null {
  const latest = group.notifications.reduce((max, x) => (x.readAt === null && x.id > max ? x.id : max), 0);
  return latest > markedUpTo ? latest : null;
}
