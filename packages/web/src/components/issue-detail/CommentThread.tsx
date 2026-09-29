import { useState } from "react";
import type { ActivityItem } from "../../api/types";
import { formatRelative } from "../../lib/format";
import { hasText } from "../../lib/issue-edit";
import { AgentAvatar, Icon } from "../ui";
import s from "./issue-detail.module.css";
import { useAsyncAction } from "./useAsyncAction";

export type CommentThreadItem = Extract<ActivityItem, { kind: "comment" }>;

export interface ThreadHandlers {
  onReply: (parentId: number, body: string) => Promise<unknown>;
  onResolve: (commentId: number, resolved: boolean) => Promise<unknown>;
}

function Time({ at }: { at: string }) {
  return <time dateTime={at} title={at}>{formatRelative(at)}</time>;
}

// nod.pen「Issue詳細｜コメントスレッド（#48/#49）」の Activity に合わせる。
// 未解決はカード、解決済みは1行に折りたたみ、開くと「未解決に戻す」を出す。
export function CommentThread({ thread, onReply, onResolve }: { thread: CommentThreadItem } & ThreadHandlers) {
  const resolved = thread.resolvedAt !== null;
  const [expanded, setExpanded] = useState(false);
  const [replying, setReplying] = useState(false);
  const [body, setBody] = useState("");
  const action = useAsyncAction();

  async function submitReply() {
    if (await action.run(() => onReply(thread.id, body.trim()), "返信できませんでした")) {
      setBody("");
      setReplying(false);
    }
  }

  async function toggleResolved(next: boolean) {
    if (await action.run(() => onResolve(thread.id, next), next ? "解決済みにできませんでした" : "未解決に戻せませんでした")) {
      setExpanded(false);
      setReplying(false);
    }
  }

  const error = action.error && <p className={s.error} role="alert">{action.error}</p>;
  const replyCount = thread.replies.length > 0 && <span className={s.threadMeta}>{thread.replies.length}件の返信</span>;

  if (resolved && !expanded) {
    return (
      <article className={`${s.commentThread} ${s.threadResolved} ${s.threadCompact}`} aria-label="コメント記録">
        <button type="button" className={s.threadCollapsed} aria-expanded={false} onClick={() => setExpanded(true)}>
          <Icon name="check" color="var(--ready)" />
          <span className={s.resolvedLabel}>解決済み</span>
          <span className={s.threadMeta}>·</span>
          <span className={s.threadExcerpt}>{thread.actor}: {thread.body}</span>
          {replyCount && <><span className={s.threadMeta}>·</span>{replyCount}</>}
          <Icon name="chevron-down" color="var(--ink3)" />
        </button>
        {error}
      </article>
    );
  }

  return (
    <article className={`${s.commentThread} ${resolved ? s.threadResolved : ""}`} aria-label="コメント記録">
      {resolved && (
        <div className={s.resolvedBar}>
          <button type="button" className={s.resolvedToggle} aria-expanded onClick={() => setExpanded(false)}>
            <Icon name="check" color="var(--ready)" />
            <span className={s.resolvedLabel}>解決済み</span>
          </button>
          <span className={s.resolvedBy}>
            · {thread.resolvedBy} が解決 · <Time at={thread.resolvedAt!} />
          </span>
          <button type="button" className={s.reopenButton} disabled={action.busy} onClick={() => void toggleResolved(false)}>
            <Icon name="rotate-ccw" size={13} color="var(--ink3)" />
            未解決に戻す
          </button>
        </div>
      )}
      <div className={s.commentHead}>
        <AgentAvatar actor={thread.actor} />
        <strong>{thread.actor}</strong>
        <Time at={thread.at} />
        {!resolved && (
          <span className={s.threadActions}>
            <button type="button" className={s.threadAction} disabled={action.busy} onClick={() => setReplying(true)}>
              <Icon name="reply" size={13} color="var(--ink3)" />
              返信
            </button>
            <button type="button" className={s.threadAction} disabled={action.busy} onClick={() => void toggleResolved(true)}>
              <Icon name="check" size={13} color="var(--ink3)" />
              解決
            </button>
          </span>
        )}
      </div>
      <p>{thread.body}</p>
      {(thread.replies.length > 0 || replying) && (
        <div className={s.threadReplies}>
          {thread.replies.map((reply) => (
            <div key={reply.id} className={s.threadReply} role="group" aria-label="返信記録">
              <div className={s.replyHead}>
                <AgentAvatar actor={reply.actor} size={14} />
                <strong>{reply.actor}</strong>
                <Time at={reply.at} />
              </div>
              <p>{reply.body}</p>
            </div>
          ))}
          {replying && (
            <div className={s.replyBox}>
              <textarea
                autoFocus
                rows={1}
                disabled={action.busy}
                className={s.replyInput}
                aria-label="返信"
                placeholder="返信を書く…"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setReplying(false);
                }}
              />
              <button type="button" className={s.replySubmit} disabled={action.busy || !hasText(body)} onClick={() => void submitReply()}>
                返信する
              </button>
            </div>
          )}
        </div>
      )}
      {error}
    </article>
  );
}
