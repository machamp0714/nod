import { useQuery } from "@tanstack/react-query";
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
