import { useLayoutEffect, useRef, useState } from "react";
import type { ActivityItem, WorkLogKind } from "../../api/types";
import { formatRelative } from "../../lib/format";
import { hasText } from "../../lib/issue-edit";
import { isMonoWorkLog, WORK_LOG_KIND_META, WORK_LOG_TONE_COLORS } from "../../lib/work-log";
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

// nod.pen「Issue詳細｜作業ログ」の種類バッジ（点と種類名）
function WorkLogBadge({ kind }: { kind: WorkLogKind }) {
  const meta = WORK_LOG_KIND_META[kind];
  const color = WORK_LOG_TONE_COLORS[meta.tone];
  return (
    <span className={s.kindBadge} style={{ background: color.bg, color: color.fg }} data-log-kind={kind}>
      <span className={s.kindDot} style={{ background: color.dot }} />
      {meta.label}
    </span>
  );
}

// 作業ログの本文は6行を超えたら折りたたみ、「続きを表示」で開く。行数は折り返しを含めて実際の表示で測る
function WorkLogBody({ body, kind }: { body: string; kind: WorkLogKind }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setOverflow(el.scrollHeight > el.clientHeight + 1);
  }, [body, open]);
  return (
    <>
      <p ref={ref} className={`${isMonoWorkLog(kind) ? s.logMono : ""} ${open ? "" : s.logClamp}`}>
        {body}
      </p>
      {(overflow || open) && (
        <button type="button" className={s.logToggle} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "折りたたむ" : "続きを表示"}
          <Icon name={open ? "chevron-up" : "chevron-down"} size={12} color="var(--accent)" />
        </button>
      )}
    </>
  );
}

// nod.pen「Issue詳細｜コメントスレッド（#48/#49）」の Activity に合わせる。
// 未解決はカード、解決済みは1行に折りたたみ、開くと「未解決に戻す」を出す。
// readOnly（アーカイブ済み）のときは返信・解決済み化・未解決に戻すを無効にする
export function CommentThread({ thread, onReply, onResolve, readOnly = false }: { thread: CommentThreadItem; readOnly?: boolean } & ThreadHandlers) {
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
    <article
      className={`${s.commentThread} ${resolved ? s.threadResolved : ""} ${thread.logKind === "blocker" && !resolved ? s.threadBlocker : ""}`}
      aria-label={thread.logKind ? "作業ログ" : "コメント記録"}
    >
      {resolved && (
        <div className={s.resolvedBar}>
          <button type="button" className={s.resolvedToggle} aria-expanded onClick={() => setExpanded(false)}>
            <Icon name="check" color="var(--ready)" />
            <span className={s.resolvedLabel}>解決済み</span>
          </button>
          <span className={s.resolvedBy}>
            · {thread.resolvedBy} が解決 · <Time at={thread.resolvedAt!} />
          </span>
          <button type="button" className={s.reopenButton} disabled={action.busy || readOnly} onClick={() => void toggleResolved(false)}>
            <Icon name="rotate-ccw" size={13} color="var(--ink3)" />
            未解決に戻す
          </button>
        </div>
      )}
      <div className={s.commentHead}>
        <AgentAvatar actor={thread.actor} />
        <strong>{thread.actor}</strong>
        {thread.logKind && <WorkLogBadge kind={thread.logKind} />}
        <Time at={thread.at} />
        {!resolved && (
          <span className={s.threadActions}>
            <button type="button" className={s.threadAction} disabled={action.busy || readOnly} onClick={() => setReplying(true)}>
              <Icon name="reply" size={13} color="var(--ink3)" />
              返信
            </button>
            <button type="button" className={s.threadAction} disabled={action.busy || readOnly} onClick={() => void toggleResolved(true)}>
              <Icon name="check" size={13} color="var(--ink3)" />
              解決
            </button>
          </span>
        )}
      </div>
      {thread.logKind ? <WorkLogBody body={thread.body} kind={thread.logKind} /> : <p>{thread.body}</p>}
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
