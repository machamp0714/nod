import { Link } from "@tanstack/react-router";
import { AlarmClock, AlarmClockOff, CalendarClock, ChevronDown, Clock3, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../api/errors";
import { useNotificationAction, useNotifications } from "../api/hooks/notifications";
import type { NotificationAction } from "../api/notifications";
import { useIssueDetail } from "../api/hooks/shared";
import { useProjectChoices, useRemind, useUpdateIssue } from "../api/hooks/issue-detail";
import { PropertiesPanel } from "../components/issue-detail/PropertiesPanel";
import type { Notification } from "../api/types";
import { ActionError } from "../components/split/ActionError";
import { QueueEmpty } from "../components/split/QueueItem";
import { AgentAvatar, Icon, StatusLabel, WorkspaceBadge } from "../components/ui";
import { formatRelative } from "../lib/format";
import {
  customSnoozeUntil,
  describeNotification,
  formatSnoozeUntil,
  groupNotifications,
  groupSummary,
  type NotificationGroup,
  snoozePresets,
  unreadToMark,
} from "../lib/notification";
import { useStatusNames } from "../api/hooks/workspace-labels";
import d from "./decision.module.css";
import n from "./notifications.module.css";

export type NotificationView = "inbox" | "snoozed";

// Inbox の通知タブ（Pencil『Inbox｜通知タブ』）。一覧は Issue ごとに1行、既読も薄く残す。
// snoozed はスヌーズ中の通知（Pencil『Inbox｜スヌーズ中』）
export function useNotificationGroups(view: NotificationView) {
  const history = useNotifications({ includeRead: true });
  const snoozed = useNotifications({ snoozed: true });
  const snoozedGroups = groupNotifications(snoozed.data ?? []);
  const query = view === "snoozed" ? snoozed : history;
  const groups = view === "snoozed" ? snoozedGroups : groupNotifications(history.data ?? []);
  return { query, groups, snoozedCount: snoozedGroups.length };
}

// 一覧の上の「すべて｜スヌーズ中 N」の切り替え
export function SnoozeFilter({ view, snoozedCount, onChange }: { view: NotificationView; snoozedCount: number; onChange: (view: NotificationView) => void }) {
  return (
    <div className={n.filter}>
      <div role="tablist" aria-label="通知の表示" className={n.switch}>
        <button type="button" role="tab" aria-selected={view === "inbox"} className={n.switchItem} onClick={() => onChange("inbox")}>すべて</button>
        <button type="button" role="tab" aria-selected={view === "snoozed"} className={n.switchItem} onClick={() => onChange("snoozed")}>
          スヌーズ中<span className={n.switchCount}>{snoozedCount}</span>
        </button>
      </div>
    </div>
  );
}

export function NotificationList({ groups, current, workspaceName, view }: { groups: NotificationGroup[]; current: NotificationGroup | undefined; workspaceName: (key: string) => string; view: NotificationView }) {
  const statusNames = useStatusNames();
  if (groups.length === 0) {
    return <QueueEmpty>{view === "snoozed" ? "スヌーズ中の通知はありません" : "通知はありません。Issue を購読すると変化が、LLM に任せた Issue は完了・入力待ち・エラーがここに届きます"}</QueueEmpty>;
  }
  return groups.map((group) => {
    const unread = group.unread > 0;
    const until = group.latest.snoozedUntil;
    return (
      <Link key={group.issueId} to="/inbox" search={{ selected: group.issueId, tab: "notifications", ...(view === "snoozed" ? { view } : {}) }} className={n.row}
        data-selected={group === current} data-unread={unread} aria-label={`${group.issueTitle}${unread ? `（未読 ${group.unread}）` : ""}`}>
        <div className={n.rowHead}>
          <span className={n.dot} data-unread={unread} aria-hidden="true" />
          <span className={n.rowTitle}>{group.issueTitle}</span>
          <span className={n.rowTime}>{formatRelative(group.latest.createdAt)}</span>
        </div>
        <div className={n.rowSummary}>
          <NotificationAvatar item={group.latest} size={16} />
          <span className={n.rowSummaryText}>{groupSummary(group, statusNames.data)}</span>
        </div>
        <div className={n.rowMeta}>
          {until && <span className={n.snoozeUntil}><Clock3 size={12} aria-hidden="true" />{formatSnoozeUntil(until)}</span>}
          <WorkspaceBadge workspaceKey={group.workspace} name={workspaceName(group.workspace)} />
          <span className={n.rowId}>{group.issueId}</span>
        </div>
      </Link>
    );
  });
}

// 開いた（一覧で選んだ）Issue の通知は、開いている間に届いたものも既読にする（スヌーズ中の表示では既読にしない）。
// 開いてから見た未読は、この画面を離れるまで「未読」の欄に残す。
// onRemoved はスヌーズ・解除・削除でこの一覧から消えたときに呼ぶ（削除なら取り消しに使う id を渡す）
export function NotificationDetail({ group, workspaceName, opened, view, onRemoved }: {
  group: NotificationGroup;
  workspaceName: string;
  opened: boolean;
  view: NotificationView;
  onRemoved: (deletedIds?: number[]) => void;
}) {
  const detail = useIssueDetail(group.issueId);
  const action = useNotificationAction();
  const update = useUpdateIssue(group.issueId);
  const remind = useRemind(group.issueId);
  const projects = useProjectChoices();
  const [seenUnread, setSeenUnread] = useState(() => new Set(group.notifications.filter((x) => x.readAt === null).map((x) => x.id)));
  const markedUpTo = useRef(0);
  const toMark = opened && view === "inbox" ? unreadToMark(group, markedUpTo.current) : null;
  useEffect(() => {
    if (toMark === null || toMark <= markedUpTo.current) return;
    markedUpTo.current = toMark;
    const ids = group.notifications.filter((x) => x.readAt === null).map((x) => x.id);
    setSeenUnread((prev) => new Set([...prev, ...ids]));
    action.mutate({ op: "read", issueId: group.issueId });
  }, [toMark, group, action.mutate]);
  const unread = group.notifications.filter((x) => x.readAt === null || seenUnread.has(x.id));
  const read = group.notifications.filter((x) => !unread.includes(x));
  const subscribed = detail.data?.subscribed;
  const until = group.latest.snoozedUntil;
  // 成功すると一覧が読み直され、この詳細は消える。mutate の onSuccess は消えた後には呼ばれないため、Promise で受ける
  const removeBy = (next: NotificationAction) => {
    action.mutateAsync(next).then((r) => onRemoved("ids" in r ? r.ids : undefined), () => {});
  };
  const remove = (
    <button type="button" className={`${n.action} ${n.danger}`} disabled={action.isPending}
      onClick={() => removeBy({ op: "delete", issueId: group.issueId })}>
      <Trash2 size={13} aria-hidden="true" />削除
    </button>
  );
  return (
    <div className={n.split}>
    <div className={`${d.detail} ${n.main}`}>
      <div className={d.crumb}>
        <WorkspaceBadge workspaceKey={group.workspace} name={workspaceName} />
        <span className={d.id}>{group.issueId}</span>
        {detail.data && <><span aria-hidden="true">·</span><StatusLabel status={detail.data.status} workspace={group.workspace} /></>}
      </div>
      <h2 className={d.title}>{group.issueTitle}</h2>
      {view === "snoozed" ? (
        <div className={n.actions}>
          <button type="button" className={n.action} disabled={action.isPending} onClick={() => removeBy({ op: "unsnooze", issueId: group.issueId })}>
            <AlarmClockOff size={13} aria-hidden="true" />スヌーズを解除
          </button>
          {remove}
          {until && <span className={n.snoozeStatus}><Clock3 size={13} aria-hidden="true" />{formatSnoozeUntil(until)}スヌーズ中</span>}
          <span className={d.spacer} />
          <Link to="/issues/$issueId" params={{ issueId: group.issueId }} className={d.link}>
            Issue を開く
            <Icon name="arrow-right" />
          </Link>
        </div>
      ) : (
        <div className={n.actionRows}>
        <div className={n.actions}>
          <button type="button" className={n.action} disabled={group.unread === 0 || action.isPending}
            onClick={() => action.mutate({ op: "read", issueId: group.issueId })}>
            <Icon name="check" size={13} />既読にする
          </button>
          <button type="button" className={n.action} disabled={action.isPending} onClick={() => action.mutate({ op: "read", all: true })}>
            <Icon name="check-check" size={13} />すべて既読
          </button>
          {subscribed !== undefined && (
            <button type="button" className={n.action} disabled={action.isPending}
              onClick={() => action.mutate({ op: subscribed ? "unsubscribe" : "subscribe", issueId: group.issueId })}>
              <Icon name={subscribed ? "bell-off" : "bell"} size={13} />{subscribed ? "購読を解除" : "購読する"}
            </button>
          )}
        </div>
        <div className={n.actions}>
          <SnoozeMenu disabled={action.isPending} onSnooze={(until) => removeBy({ op: "snooze", issueId: group.issueId, until: until.toISOString() })} />
          {remove}
          <span className={d.spacer} />
          <Link to="/issues/$issueId" params={{ issueId: group.issueId }} className={d.link}>
            Issue を開く
            <Icon name="arrow-right" />
          </Link>
        </div>
        </div>
      )}
      <ActionError error={action.error} />
      <section className={n.timeline} aria-label="通知">
        {unread.length > 0 && <NotificationSection title={`未読 ${unread.length}`} items={unread} unread />}
        {unread.length > 0 && read.length > 0 && <div className={n.gap} />}
        {read.length > 0 && <NotificationSection title="既読" items={read} unread={false} />}
      </section>
    </div>
    {/* 通知から Issue のプロパティを直接変える（#46）。Issue 詳細と同じ部品・同じ API で、失敗は欄の下に出す */}
    <aside className={n.propsRail}>
      {detail.data && (
        <PropertiesPanel variant="inbox" issue={detail.data} workspaceName={workspaceName} projects={projects}
          onUpdate={(input) => update.mutateAsync(input)} reminder={detail.data.reminder ?? null} onRemind={remind} />
      )}
    </aside>
    </div>
  );
}

// リマインダー（#47）は人やLLMの操作ではないので、アバターの代わりに目覚まし時計を出す（nod.pen の Reminder Icon）
function NotificationAvatar({ item, size }: { item: Notification; size: number }) {
  if (item.kind !== "reminder") return <AgentAvatar actor={item.actor} size={size} />;
  return (
    <span className={n.reminderIcon} style={{ width: size, height: size }} aria-hidden="true">
      <AlarmClock size={Math.round(size * 0.66)} />
    </span>
  );
}

function NotificationSection({ title, items, unread }: { title: string; items: Notification[]; unread: boolean }) {
  const statusNames = useStatusNames();
  return (
    <>
      <h3 className={n.sectionTitle}>{title}</h3>
      <ul className={n.items}>
        {items.map((item) => (
          <li key={item.id} className={n.item} data-unread={unread}>
            <span className={n.dot} data-unread={unread} aria-hidden="true" />
            <NotificationAvatar item={item} size={18} />
            <span className={n.itemText}>{describeNotification(item, { statusNames: statusNames.data })}</span>
            <span className={n.itemTime}>{formatRelative(item.createdAt)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

// スヌーズのメニュー（Pencil『Inbox｜通知スヌーズ・削除』）。プリセットか日時指定で期限を選ぶ
function SnoozeMenu({ disabled, onSnooze }: { disabled: boolean; onSnooze: (until: Date) => void }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("09:00");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); setCustom(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) { setOpen(false); setCustom(false); } };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const choose = (until: Date) => { onSnooze(until); close(); };
  const customUntil = customSnoozeUntil(date, time);
  return (
    <div className={n.menuRoot} ref={root}>
      <button type="button" ref={trigger} className={n.action} data-open={open} disabled={disabled} aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setCustom(false); setOpen(!open); }}>
        <Clock3 size={13} aria-hidden="true" />スヌーズ<ChevronDown size={12} aria-hidden="true" className={n.chevron} />
      </button>
      {open && (
        <div role="menu" aria-label="スヌーズの期限" className={n.menu} onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); close(); }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
            const current = items.indexOf(document.activeElement as HTMLButtonElement);
            items[(current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
          }
        }}>
          {snoozePresets().map((preset, i) => (
            <button key={preset.label} ref={i === 0 ? first : undefined} type="button" role="menuitem" className={n.menuItem} onClick={() => choose(preset.until)}>
              <Clock3 size={14} aria-hidden="true" /><span className={n.menuLabel}>{preset.label}</span><span className={n.menuHint}>{preset.hint}</span>
            </button>
          ))}
          <hr className={n.menuSeparator} />
          <button type="button" role="menuitem" className={n.menuItem} data-active={custom} aria-expanded={custom} onClick={() => setCustom(!custom)}>
            <CalendarClock size={14} aria-hidden="true" /><span className={n.menuLabel}>日時指定…</span>
          </button>
          {custom && (
            <form className={n.custom} onSubmit={(event) => { event.preventDefault(); if (customUntil) choose(customUntil); }}>
              <div className={n.customInputs}>
                <input type="date" aria-label="スヌーズの日付" className={n.input} value={date} onChange={(e) => setDate(e.target.value)} />
                <input type="time" aria-label="スヌーズの時刻" className={`${n.input} ${n.timeInput}`} value={time} onChange={(e) => setTime(e.target.value)} />
              </div>
              <div className={n.customButtons}>
                <button type="submit" className={n.primary} disabled={customUntil === null}>スヌーズする</button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

// 削除直後のトースト（Pencil『Inbox｜削除トースト』）。約5秒で消える。取り消しに失敗したらトースト内に理由を出し、そこから5秒待つ
export function DeleteToast({ onUndo, onClose, pending, error }: { onUndo: () => void; onClose: () => void; pending: boolean; error: unknown }) {
  useEffect(() => {
    if (pending) return;
    const timer = setTimeout(onClose, 5000);
    return () => clearTimeout(timer);
  }, [onClose, pending, error]);
  return (
    <div role="status" className={n.toast}>
      <Trash2 size={14} aria-hidden="true" />
      {error ? <span role="alert" className={n.toastError}>元に戻せませんでした（{errorMessage(error)}）</span> : <span>通知を削除しました</span>}
      <button type="button" className={n.undo} disabled={pending} onClick={onUndo}>元に戻す</button>
    </div>
  );
}
