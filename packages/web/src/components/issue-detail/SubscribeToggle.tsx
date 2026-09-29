import { useNotificationAction } from "../../api/hooks/notifications";
import { ActionError } from "../split/ActionError";
import { Icon } from "../ui";
import s from "./issue-detail.module.css";

// Pencil『Issue詳細｜購読トグル（#45）』。購読中の Issue の変化は Inbox の通知タブに届く
export function SubscribeToggle({ issueId, subscribed }: { issueId: string; subscribed: boolean }) {
  const action = useNotificationAction();
  return (
    <>
      <button type="button" className={s.subscribeToggle} data-subscribed={subscribed} aria-pressed={subscribed}
        title={subscribed ? "購読を解除する" : "変化を Inbox の通知で受け取る"} disabled={action.isPending}
        onClick={() => action.mutate({ op: subscribed ? "unsubscribe" : "subscribe", issueId })}>
        <Icon name={subscribed ? "bell-ring" : "bell"} size={13} />
        {subscribed ? "購読中" : "購読する"}
      </button>
      <ActionError error={action.error} />
    </>
  );
}
