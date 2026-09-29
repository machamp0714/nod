import type { Notification, Status } from "../api/types";
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
