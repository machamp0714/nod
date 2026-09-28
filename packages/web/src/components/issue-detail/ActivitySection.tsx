import { useState } from "react";
import type { ActivityItem } from "../../api/types";
import { hasText } from "../../lib/issue-edit";
import { ActivityLines, Button } from "../ui";
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
      {activity.length === 0 ? <p className={s.muted}>Activity はありません</p> : <ActivityLines items={activity} />}
      <div className={s.commentBox}>
        <textarea
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
