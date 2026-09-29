import type { Notification } from "../api/types";
import { formatEstimate } from "./due-date";
import { isStatus, priorityMeta } from "./meta";
import { statusName, type StatusNamesByWorkspace } from "./workspace-labels";

// 通知1件の文。short は一覧の行で使い、コメント本文や理由を省く
// statusNames を渡すと、ステータスを通知の Issue の Workspace の表示名で書く
export function describeNotification(n: Notification, opts: { short?: boolean; statusNames?: StatusNamesByWorkspace } = {}): string {
  const d = n.data as { from?: unknown; to?: unknown; agent?: unknown; added?: string[]; removed?: string[]; reason?: string };
  const quote = (text: string | null | undefined) => (text && !opts.short ? `：「${text}」` : "");
  const to = d.to === null || d.to === undefined || d.to === "" ? null : d.to;
  const who = n.actor;
  switch (n.eventType) {
    case "status_changed":
      return `${who} がステータスを ${isStatus(to) ? statusName(to, opts.statusNames, n.workspace) : String(to)} に変更しました`;
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
    case "agent_state_changed": {
      // 主語は操作した人ではなく、作業を任された担当（data.agent）
      const agent = typeof d.agent === "string" ? d.agent : who;
      if (to === "done") return `${agent} が作業を完了しました（レビュー待ち）`;
      if (to === "awaiting_input") return `${agent} が確認を求めました（入力待ち）${quote(d.reason)}`;
      if (to === "error") return `${agent} がエラーで止まりました（エラー）${quote(d.reason)}`;
      return `${agent} ${n.eventType}`;
    }
    case "reminder": {
      const note = (n.data as { note?: unknown }).note;
      return typeof note === "string" && note ? `リマインダー：${note}` : "リマインダーの時刻です";
    }
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
export function groupSummary(group: NotificationGroup, statusNames?: StatusNamesByWorkspace): string {
  const rest = group.notifications.length - 1;
  return `${describeNotification(group.latest, { short: true, statusNames })}${rest > 0 ? ` ほか ${rest} 件` : ""}`;
}

// 開いている Issue の通知を既読にするかどうか。markedUpTo は、これまでに既読にした時点の最新の未読 id。
// それより新しい未読が届いたら（開いたままの間に来た通知も）その id を返し、なければ null
export function unreadToMark(group: NotificationGroup, markedUpTo: number): number | null {
  const latest = group.notifications.reduce((max, x) => (x.readAt === null && x.id > max ? x.id : max), 0);
  return latest > markedUpTo ? latest : null;
}

// スヌーズの期限（#43）。端末のタイムゾーンで計算し、server へは ISO で送る
export interface SnoozePreset {
  label: string;
  hint: string; // メニューの右に出す具体的な時刻
  until: Date;
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const hm = (d: Date) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
const md = (d: Date) => `${d.getMonth() + 1}月${d.getDate()}日`;
const at9 = (base: Date, days: number) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + days, 9);

export function snoozePresets(now: Date = new Date()): SnoozePreset[] {
  const hour = new Date(now.getTime() + 3_600_000);
  const tomorrow = at9(now, 1);
  const monday = at9(now, ((8 - now.getDay()) % 7) || 7);
  return [
    { label: "1時間後", hint: hm(hour).padStart(5, "0"), until: hour },
    { label: "明日 9:00", hint: `${md(tomorrow)}（${WEEKDAYS[tomorrow.getDay()]}）`, until: tomorrow },
    { label: "来週月曜 9:00", hint: `${md(monday)}（${WEEKDAYS[monday.getDay()]}）`, until: monday },
  ];
}

// 日時指定。date は YYYY-MM-DD、time は HH:MM（空なら 9:00）。空・存在しない日付・過去は null
export function customSnoozeUntil(date: string, time: string, now: Date = new Date()): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!d) return null;
  const t = /^(\d{2}):(\d{2})$/.exec(time || "09:00");
  if (!t) return null;
  const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const until = new Date(y, m - 1, day, Number(t[1]), Number(t[2]));
  if (until.getMonth() !== m - 1 || until.getDate() !== day) return null;
  return until.getTime() > now.getTime() ? until : null;
}

// 「今日 15:20 まで」「明日 9:00 まで」「10月2日 14:00 まで」
export function formatSnoozeUntil(iso: string, now: Date = new Date()): string {
  const until = new Date(iso);
  const days = Math.round((at9(until, 0).getTime() - at9(now, 0).getTime()) / 86_400_000);
  const day = days === 0 ? "今日" : days === 1 ? "明日" : md(until);
  return `${day} ${hm(until)} まで`;
}

// setTimeout が扱える最大の待ち時間。これを超えるとすぐ呼ばれてしまうので、ここで打ち切って待ち直す
const MAX_TIMER_MS = 2 ** 31 - 1;

// いちばん早く期限が来るスヌーズまでの待ち時間（ms）。server の時計とのずれを見込んで margin だけ遅らせ、
// 期限を過ぎていても margin は待つ（server がまだスヌーズ中と返しても読み直しを繰り返し過ぎない）。スヌーズ中がなければ null
export function nextSnoozeExpiry(list: readonly Notification[], now: number = Date.now(), margin = 1000): number | null {
  return nextDelay(list.flatMap((x) => (x.snoozedUntil ? [x.snoozedUntil] : [])), now, margin);
}

// いちばん早い日時（ISO）までの待ち時間（ms）。考え方は nextSnoozeExpiry と同じ。リマインダーの期限（#47）にも使う
export function nextDelay(isoTimes: readonly string[], now: number = Date.now(), margin = 1000): number | null {
  const times = isoTimes.map((x) => Date.parse(x)).filter((t) => !Number.isNaN(t));
  if (times.length === 0) return null;
  return Math.min(Math.max(Math.min(...times) - now, 0) + margin, MAX_TIMER_MS);
}
