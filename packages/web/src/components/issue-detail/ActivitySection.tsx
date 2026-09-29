import { useState } from "react";
import type { ActivityItem } from "../../api/types";
import { hasText } from "../../lib/issue-edit";
import { visibleActivity } from "../../lib/activity";
import { ActivityLines, Button } from "../ui";
import { CommentThread, type ThreadHandlers } from "./CommentThread";
import s from "./issue-detail.module.css";
import { useAsyncAction } from "./useAsyncAction";

// readOnly（アーカイブ済み）のときはコメント欄の代わりに理由を出し、返信・解決済み化もできない（Pencil「Issue詳細｜アーカイブ済み」）
export function ActivitySection({
  activity,
  onComment,
  readOnly = false,
  ...handlers
}: { activity: ActivityItem[]; onComment: (body: string) => Promise<unknown>; readOnly?: boolean } & ThreadHandlers) {
  const [body, setBody] = useState("");
  const action = useAsyncAction();

  async function submit() {
    if (await action.run(() => onComment(body.trim()), "コメントできませんでした")) setBody("");
  }

  return (
    <section className={s.section} aria-label="Activity">
      <h2 className={s.sectionTitle}>Activity</h2>
      {activity.length === 0 ? <p className={s.muted}>Activity はありません</p> : <div className={s.activityCards}>{visibleActivity(activity).map((item, index) => item.kind === "comment" ?
        <CommentThread key={`comment-${item.id}`} thread={item} {...handlers} readOnly={readOnly} /> : <ActivityLines key={`${item.at}-${index}`} items={[item]} />)}</div>}
      {readOnly ? <p className={`${s.commentBox} ${s.commentBoxLocked}`}>アーカイブ済みのためコメントできません</p> : <div className={s.commentBox}>
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
      </div>}
    </section>
  );
}
