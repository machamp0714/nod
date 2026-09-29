import type { Notification, Status } from "../api/types";
import { priorityMeta, STATUS_META } from "./meta";

function shown(v: unknown, label?: (v: never) => string): string {
  if (v === null || v === undefined || v === "") return "なし";
  return label ? label(v as never) : String(v);
}

// 通知1件の要約（誰が、は画面で別に出す）
export function describeNotification(n: Notification): string {
  const d = n.data as { from?: unknown; to?: unknown; added?: string[]; removed?: string[]; reason?: string };
  const change = (what: string, label?: (v: never) => string) => `${what}を ${shown(d.from, label)} → ${shown(d.to, label)} に変更`;
  switch (n.eventType) {
    case "status_changed":
      return change("ステータス", (v: Status) => STATUS_META[v]?.label ?? v);
    case "priority_changed":
      return change("優先度", (v: number) => priorityMeta(v).label);
    case "assignee_changed":
      return change("担当");
    case "title_changed":
      return change("タイトル");
    case "project_changed":
      return change("Project");
    case "labels_changed":
      return `ラベルを変更（${[...(d.added ?? []).map((l) => `+${l}`), ...(d.removed ?? []).map((l) => `-${l}`)].join(" ")}）`;
    case "comment_added":
      return `コメント: ${n.body ?? ""}`;
    case "review_approved":
      return "レビューを承認";
    case "review_rejected":
      return d.reason ? `差し戻し: ${d.reason}` : "差し戻し";
    case "triage_accepted":
      return "Triage を受け入れ";
    case "triage_declined":
      return d.reason ? `Triage を却下: ${d.reason}` : "Triage を却下";
    default:
      return n.eventType;
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
