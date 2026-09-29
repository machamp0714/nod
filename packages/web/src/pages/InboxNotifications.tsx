import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useNotificationAction, useNotifications } from "../api/hooks/notifications";
import { useIssueDetail } from "../api/hooks/shared";
import type { Notification } from "../api/types";
import { ActionError } from "../components/split/ActionError";
import { QueueEmpty } from "../components/split/QueueItem";
import { AgentAvatar, Icon, StatusLabel, WorkspaceBadge } from "../components/ui";
import { formatRelative } from "../lib/format";
import { describeNotification, groupNotifications, groupSummary, type NotificationGroup, unreadToMark } from "../lib/notification";
import d from "./decision.module.css";
import n from "./notifications.module.css";

// Inbox の通知タブ（Pencil『Inbox｜通知タブ』）。一覧は Issue ごとに1行、既読も薄く残す
export function useNotificationGroups() {
  const history = useNotifications({ includeRead: true });
  const groups = groupNotifications(history.data ?? []);
  return { history, groups };
}

export function NotificationList({ groups, current, workspaceName }: { groups: NotificationGroup[]; current: NotificationGroup | undefined; workspaceName: (key: string) => string }) {
  if (groups.length === 0) return <QueueEmpty>通知はありません。Issue を購読すると変化が、LLM に任せた Issue は完了・入力待ち・エラーがここに届きます</QueueEmpty>;
  return groups.map((group) => {
    const unread = group.unread > 0;
    return (
      <Link key={group.issueId} to="/inbox" search={{ selected: group.issueId, tab: "notifications" }} className={n.row}
        data-selected={group === current} data-unread={unread} aria-label={`${group.issueTitle}${unread ? `（未読 ${group.unread}）` : ""}`}>
        <div className={n.rowHead}>
          <span className={n.dot} data-unread={unread} aria-hidden="true" />
          <span className={n.rowTitle}>{group.issueTitle}</span>
          <span className={n.rowTime}>{formatRelative(group.latest.createdAt)}</span>
        </div>
        <div className={n.rowSummary}>
          <AgentAvatar actor={group.latest.actor} size={16} />
          <span className={n.rowSummaryText}>{groupSummary(group)}</span>
        </div>
        <div className={n.rowMeta}>
          <WorkspaceBadge workspaceKey={group.workspace} name={workspaceName(group.workspace)} />
          <span className={n.rowId}>{group.issueId}</span>
        </div>
      </Link>
    );
  });
}

// 開いた（一覧で選んだ）Issue の通知は、開いている間に届いたものも既読にする。
// 開いてから見た未読は、この画面を離れるまで「未読」の欄に残す
export function NotificationDetail({ group, workspaceName, opened }: { group: NotificationGroup; workspaceName: string; opened: boolean }) {
  const detail = useIssueDetail(group.issueId);
  const action = useNotificationAction();
  const [seenUnread, setSeenUnread] = useState(() => new Set(group.notifications.filter((x) => x.readAt === null).map((x) => x.id)));
  const markedUpTo = useRef(0);
  const toMark = opened ? unreadToMark(group, markedUpTo.current) : null;
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
  return (
    <div className={d.detail}>
      <div className={d.crumb}>
        <WorkspaceBadge workspaceKey={group.workspace} name={workspaceName} />
        <span className={d.id}>{group.issueId}</span>
        {detail.data && <><span aria-hidden="true">·</span><StatusLabel status={detail.data.status} /></>}
      </div>
      <h2 className={d.title}>{group.issueTitle}</h2>
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
        <span className={d.spacer} />
        <Link to="/issues/$issueId" params={{ issueId: group.issueId }} className={d.link}>
          Issue を開く
          <Icon name="arrow-right" />
        </Link>
      </div>
      <ActionError error={action.error} />
      <section className={n.timeline} aria-label="通知">
        {unread.length > 0 && <NotificationSection title={`未読 ${unread.length}`} items={unread} unread />}
        {unread.length > 0 && read.length > 0 && <div className={n.gap} />}
        {read.length > 0 && <NotificationSection title="既読" items={read} unread={false} />}
      </section>
    </div>
  );
}

function NotificationSection({ title, items, unread }: { title: string; items: Notification[]; unread: boolean }) {
  return (
    <>
      <h3 className={n.sectionTitle}>{title}</h3>
      <ul className={n.items}>
        {items.map((item) => (
          <li key={item.id} className={n.item} data-unread={unread}>
            <span className={n.dot} data-unread={unread} aria-hidden="true" />
            <AgentAvatar actor={item.actor} />
            <span className={n.itemText}>{describeNotification(item)}</span>
            <span className={n.itemTime}>{formatRelative(item.createdAt)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
