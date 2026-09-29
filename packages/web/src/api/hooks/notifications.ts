import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { nextSnoozeExpiry } from "../../lib/notification";
import { fetchNotifications, type NotificationAction, postNotification } from "../notifications";
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
