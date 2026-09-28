import { useState } from "react";
import type { ActivityItem } from "../../api/types";
import { hasText } from "../../lib/issue-edit";
import { visibleActivity } from "../../lib/activity";
import { formatRelative } from "../../lib/format";
import { ActivityLines, AgentAvatar, Button } from "../ui";
import s from "./issue-detail.module.css";
import { useAsyncAction } from "./useAsyncAction";

export function ActivitySection({ activity, onComment }: { activity: ActivityItem[]; onComment: (body: string) => Promise<unknown> }) {
  const [body, setBody] = useState("");
  const action = useAsyncAction();

  async function submit() {
    if (await action.run(() => onComment(body.trim()), "コメントできませんでした")) setBody("");
  }

  return (
    <section className={s.section} aria-label="Activity">
      <h2 className={s.sectionTitle}>Activity</h2>
      {activity.length === 0 ? <p className={s.muted}>Activity はありません</p> : <div className={s.activityCards}>{visibleActivity(activity).map((item, index) => item.kind === "comment" ?
        <article key={`${item.at}-${index}`} className={s.commentCard} aria-label="コメント記録">
          <div className={s.commentHead}><AgentAvatar actor={item.actor} /><strong>{item.actor}</strong><time dateTime={item.at} title={item.at}>{formatRelative(item.at)}</time></div>
          <p>{item.body}</p>
        </article> : <ActivityLines key={`${item.at}-${index}`} items={[item]} />)}</div>}
      <div className={s.commentBox}>
        <textarea
          disabled={action.busy}
          className={s.commentInput}
          aria-label="コメント"
          placeholder="コメントを書く…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        {action.error && (
          <p className={`${s.error} ${s.panelError}`} role="alert">
            {action.error}
          </p>
        )}
        <div className={s.commentActions}>
          <Button variant="primary" onClick={() => void submit()} disabled={action.busy || !hasText(body)}>
            コメントする
          </Button>
        </div>
      </div>
    </section>
  );
}
