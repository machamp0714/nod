import { useState } from "react";
import type { ActivityItem } from "../../api/types";
import { hasText } from "../../lib/issue-edit";
import { visibleActivity } from "../../lib/activity";
import { filterActivity, WORK_LOG_FILTERS, type WorkLogFilter } from "../../lib/work-log";
import { ActivityLines, Button, Icon } from "../ui";
import { CommentThread, type ThreadHandlers } from "./CommentThread";
import s from "./issue-detail.module.css";
import { useAsyncAction } from "./useAsyncAction";

// readOnly（アーカイブ済み）のときはコメント欄の代わりに理由を出し、返信・解決済み化もできない（Pencil「Issue詳細｜アーカイブ済み」）
export function ActivitySection({
  workspace,
  activity,
  onComment,
  readOnly = false,
  ...handlers
}: { workspace?: string; activity: ActivityItem[]; onComment: (body: string) => Promise<unknown>; readOnly?: boolean } & ThreadHandlers) {
  const [body, setBody] = useState("");
  // 絞り込みは画面内だけの状態にし、URL には載せない
  const [filter, setFilter] = useState<WorkLogFilter>("all");
  const action = useAsyncAction();
  const shown = filterActivity(visibleActivity(activity), filter);

  async function submit() {
    if (await action.run(() => onComment(body.trim()), "コメントできませんでした")) setBody("");
  }

  return (
    <section className={s.section} aria-label="Activity">
      <h2 className={s.sectionTitle}>Activity</h2>
      <div className={s.kindFilter} role="group" aria-label="作業ログの種類">
        {WORK_LOG_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`${s.kindChip} ${filter === f.key ? s.kindChipSelected : ""}`}
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
      {activity.length === 0 && filter === "all" ? (
        <p className={s.muted}>Activity はありません</p>
      ) : shown.length === 0 ? (
        <div className={s.kindEmpty} role="status">
          <Icon name="file-search" size={20} color="var(--ink3)" />
          <span>この種類の作業ログはありません</span>
        </div>
      ) : (
        <div className={s.activityCards}>
          {shown.map((item, index) =>
            item.kind === "comment" ? (
              <CommentThread key={`comment-${item.id}`} thread={item} {...handlers} readOnly={readOnly} />
            ) : (
              <ActivityLines key={`${item.at}-${index}`} items={[item]} workspace={workspace} />
            ),
          )}
        </div>
      )}
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
