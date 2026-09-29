import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { nextDelay, nextSnoozeExpiry } from "../../lib/notification";
import { fetchNotifications, fetchReminders, type NotificationAction, postNotification } from "../notifications";
import { queryKeys } from "../query-keys";
import { useApiMutation } from "./shared";

export function useNotifications(opts: { includeRead?: boolean; snoozed?: boolean } = {}) {
  return useQuery({
    queryKey: opts.snoozed ? queryKeys.snoozedNotifications() : opts.includeRead ? queryKeys.notificationHistory() : queryKeys.notifications(),
    queryFn: () => fetchNotifications(undefined, opts),
  });
}

// 購読・解除・既読・スヌーズ・削除。書き込みの後の無効化は useApiMutation が行う
export function useNotificationAction() {
  return useApiMutation((action: NotificationAction) => postNotification(action));
}

// スヌーズの期限が来たら通知を読み直し、一覧と未読の数に戻す。次の期限はその読み直しの結果から決め直す
export function useSnoozeExpiry() {
  const queryClient = useQueryClient();
  const snoozed = useNotifications({ snoozed: true });
  useEffect(() => {
    const delay = nextSnoozeExpiry(snoozed.data ?? []);
    if (delay === null) return;
    const timer = setTimeout(() => void queryClient.invalidateQueries({ queryKey: queryKeys.notifications() }), delay);
    return () => clearTimeout(timer);
  }, [snoozed.data, snoozed.dataUpdatedAt, queryClient]);
}

// まだ届いていないリマインダー（#47）
export function useReminders() {
  return useQuery({ queryKey: queryKeys.reminders(), queryFn: () => fetchReminders() });
}

// リマインダーの期限が来たら通知を読み直す。server は通知や Issue 詳細の取得時に期限が来たものを通知に変える。
// 通知のキー（["notifications"]）の下にリマインダーの一覧もあるので、一緒に読み直して次の期限を決め直す。
// 開いている Issue 詳細のリマインダーの行も消えるよう、Issue 詳細も読み直す。どの画面でも動くよう AppLayout で1回だけ使う
export function useReminderExpiry() {
  const queryClient = useQueryClient();
  const reminders = useReminders();
  useEffect(() => {
    const delay = nextDelay((reminders.data ?? []).map((r) => r.remindAt));
    if (delay === null) return;
    const timer = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issueDetails() });
    }, delay);
    return () => clearTimeout(timer);
  }, [reminders.data, reminders.dataUpdatedAt, queryClient]);
}
