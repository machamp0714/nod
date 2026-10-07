import { useLayoutEffect, useRef, useState } from "react";
import type { ActivityItem, AgentInstruction, WorkLogKind } from "../../api/types";
import { formatRelative } from "../../lib/format";
import { hasText } from "../../lib/issue-edit";
import { isMonoWorkLog, WORK_LOG_KIND_META, WORK_LOG_TONE_COLORS } from "../../lib/work-log";
import { Markdown } from "../markdown/Markdown";
import { AgentAvatar, Icon } from "../ui";
import s from "./issue-detail.module.css";
import { type InstructionTarget, SendInstructionDialog } from "./SendInstructionDialog";
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

// 作業ログの本文は6行を超えたら折りたたみ、「続きを表示」で開く。行数は折り返しを含めて実際の表示で測る。
// コマンドの出力とテスト結果は桁を崩さないよう等幅の素の文字で、それ以外はコメントと同じく Markdown で描く
function WorkLogBody({ body, kind }: { body: string; kind: WorkLogKind }) {
  const ref = useRef<HTMLDivElement & HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setOverflow(el.scrollHeight > el.clientHeight + 1);
  }, [body, open]);
  return (
    <>
      {isMonoWorkLog(kind) ? (
        <p ref={ref} className={`${s.logMono} ${open ? "" : s.logClamp}`} data-log-body>
          {body}
        </p>
      ) : (
        <div ref={ref} className={`${s.commentBody} ${open ? "" : s.logClampBox}`} data-log-body>
          <Markdown breaks>{body}</Markdown>
        </div>
      )}
      {(overflow || open) && (
        <button type="button" className={s.logToggle} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "折りたたむ" : "続きを表示"}
          <Icon name={open ? "chevron-up" : "chevron-down"} size={12} color="var(--accent)" />
        </button>
      )}
    </>
  );
}

// コメントと返信の本文。LLM は行を改行だけで区切って書くため、説明と同じく改行1つを改行のまま出す
function CommentBody({ body }: { body: string }) {
  return (
    <div className={s.commentBody}>
      <Markdown breaks>{body}</Markdown>
    </div>
  );
}

const INSTRUCTION_LABEL: Record<AgentInstruction["kind"], string> = {
  instruction: "追加指示",
  review_fix: "対応依頼（指摘対応）",
  rebase: "対応依頼（rebase）",
};

function clock(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

// 追加指示・対応依頼の送信状態（#51、Pencil『Issue詳細｜LLMに追加指示（#51）』TsJz1 の GdvBc・bSQYp）。未送信・失敗・結果不明は送り直せる
function InstructionStatus({ instruction, target, readOnly }: { instruction: AgentInstruction; target?: InstructionTarget; readOnly: boolean }) {
  const [open, setOpen] = useState(false);
  const state = instruction.sendState;
  const chip =
    state === "sent" ? { cls: s.sendChipSent, icon: "check" as const, text: `送信済み ${instruction.sentAt ? clock(instruction.sentAt) : ""} → ${instruction.sentAgent ?? instruction.sentTerminal ?? ""}` }
    : state === "failed" ? { cls: s.sendChipFailed, icon: "circle-alert" as const, text: `送信失敗: ${instruction.sendError?.message ?? "理由は分かりません"}` }
    : state === "unconfirmed" ? { cls: s.sendChipUnknown, icon: "circle-alert" as const, text: `送信結果不明: ${instruction.sendError?.message ?? "届いたか分かりません"}` }
    : state === "sending" ? { cls: s.sendChipPending, icon: "send" as const, text: "送信中" }
    : { cls: s.sendChipPending, icon: "send" as const, text: "未送信（LLM は start/show で読みます）" };
  const canSend = target !== undefined && !readOnly && (state === "unsent" || state === "failed" || state === "unconfirmed");
  return (
    <div className={s.instructionStatus}>
      <span className={`${s.sendChip} ${chip.cls}`} data-send-state={state}>
        <Icon name={chip.icon} size={11} />
        {chip.text}
      </span>
      {instruction.acknowledgedAt && <span className={s.threadMeta}>{instruction.acknowledgedBy} が確認済み</span>}
      {canSend && (
        <button type="button" className={s.resendButton} onClick={() => setOpen(true)}>
          送信…
        </button>
      )}
      {open && target && (
        <SendInstructionDialog
          issueId={target.issueId}
          agent={target.agent}
          target={{ kind: "existing", instruction }}
          onClose={() => setOpen(false)}
          onDone={() => setOpen(false)}
        />
      )}
    </div>
  );
}

// nod.pen「Issue詳細｜コメントスレッド（#48/#49）」の Activity に合わせる。
// 未解決はカード、解決済みは1行に折りたたみ、開くと「未解決に戻す」と「返信」を出す。
// readOnly（アーカイブ済み）のときは返信・解決済み化・未解決に戻すを無効にする
export function CommentThread({
  thread,
  onReply,
  onResolve,
  readOnly = false,
  instructionTarget,
}: { thread: CommentThreadItem; readOnly?: boolean; instructionTarget?: InstructionTarget } & ThreadHandlers) {
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
  // 古いスレッドへの新しい返信に気づけるよう、返信があれば最後の返信の時刻を出す（design/nod.pen「Issue詳細｜最終返信時刻（#97）」）
  const lastReply = thread.replies.at(-1);
  const lastReplyAt = lastReply && (
    <span className={s.threadMeta}>
      · 最終返信 <Time at={lastReply.at} />
    </span>
  );

  if (resolved && !expanded) {
    return (
      <article className={`${s.commentThread} ${s.threadResolved} ${s.threadCompact}`} aria-label="コメント記録">
        <button type="button" className={s.threadCollapsed} aria-expanded={false} onClick={() => setExpanded(true)}>
          <Icon name="check" color="var(--ready)" />
          <span className={s.resolvedLabel}>解決済み</span>
          <span className={s.threadMeta}>·</span>
          <span className={s.threadExcerpt}>{thread.actor}: {thread.body}</span>
          {replyCount && <><span className={s.threadMeta}>·</span>{replyCount}{lastReplyAt}</>}
          <Icon name="chevron-down" color="var(--ink3)" />
        </button>
        {error}
      </article>
    );
  }

  return (
    <article
      className={`${s.commentThread} ${resolved ? s.threadResolved : ""} ${thread.logKind === "blocker" && !resolved ? s.threadBlocker : ""}`}
      aria-label={thread.logKind ? "作業ログ" : thread.instruction ? "追加指示" : "コメント記録"}
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
        {thread.instruction && (
          <span className={s.instructionBadge} data-instruction-kind={thread.instruction.kind}>
            <Icon name="send" size={10} />
            {INSTRUCTION_LABEL[thread.instruction.kind]}
          </span>
        )}
        <Time at={thread.at} />
        {!resolved && lastReplyAt}
        {/* 解決済みも開けば返信できる（API・CLI と同じ）。解決は未解決のときだけ */}
        <span className={s.threadActions}>
          <button type="button" className={s.threadAction} disabled={action.busy || readOnly} onClick={() => setReplying(true)}>
            <Icon name="reply" size={13} color="var(--ink3)" />
            返信
          </button>
          {!resolved && (
            <button type="button" className={s.threadAction} disabled={action.busy || readOnly} onClick={() => void toggleResolved(true)}>
              <Icon name="check" size={13} color="var(--ink3)" />
              解決
            </button>
          )}
        </span>
      </div>
      {thread.logKind ? (
        <WorkLogBody body={thread.body} kind={thread.logKind} />
      ) : thread.instruction ? (
        <p className={s.instructionBody}>{thread.body}</p>
      ) : (
        <CommentBody body={thread.body} />
      )}
      {thread.instruction && <InstructionStatus instruction={thread.instruction} target={instructionTarget} readOnly={readOnly} />}
      {(thread.replies.length > 0 || replying) && (
        <div className={s.threadReplies}>
          {thread.replies.map((reply) => (
            <div key={reply.id} className={s.threadReply} role="group" aria-label="返信記録">
              <div className={s.replyHead}>
                <AgentAvatar actor={reply.actor} size={14} />
                <strong>{reply.actor}</strong>
                <Time at={reply.at} />
              </div>
              <CommentBody body={reply.body} />
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
