import { useState } from "react";
import type { ActivityItem } from "../../api/types";
import { hasText } from "../../lib/issue-edit";
import { visibleActivity } from "../../lib/activity";
import { filterActivity, WORK_LOG_FILTERS, type WorkLogFilter } from "../../lib/work-log";
import { ActivityLines, Button, Icon } from "../ui";
import { CommentThread, type ThreadHandlers } from "./CommentThread";
import s from "./issue-detail.module.css";
import { type InstructionTarget, SendInstructionDialog } from "./SendInstructionDialog";
import { useAsyncAction } from "./useAsyncAction";

type ComposerMode = "comment" | "instruction";

// readOnly（アーカイブ済み）のときはコメント欄の代わりに理由を出し、返信・解決済み化もできない（Pencil「Issue詳細｜アーカイブ済み」）。
// instructionTarget があれば、コメント欄を「LLM に追加指示」に切り替えられる（#51、Pencil『Issue詳細｜LLMに追加指示』）。
// 追加指示は確認画面で宛先を示し、人が「送信」を押したときだけ Orca の端末へ送る
export function ActivitySection({
  workspace,
  activity,
  onComment,
  readOnly = false,
  instructionTarget,
  ...handlers
}: {
  workspace?: string;
  activity: ActivityItem[];
  onComment: (body: string) => Promise<unknown>;
  readOnly?: boolean;
  instructionTarget?: InstructionTarget;
} & ThreadHandlers) {
  const [body, setBody] = useState("");
  const [mode, setMode] = useState<ComposerMode>("comment");
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState("");
  // 絞り込みは画面内だけの状態にし、URL には載せない
  const [filter, setFilter] = useState<WorkLogFilter>("all");
  const action = useAsyncAction();
  const shown = filterActivity(visibleActivity(activity), filter);

  async function submit() {
    if (await action.run(() => onComment(body.trim()), "コメントできませんでした")) setBody("");
  }
  const instructing = mode === "instruction" && instructionTarget !== undefined;

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
              <CommentThread key={`comment-${item.id}`} thread={item} {...handlers} readOnly={readOnly} instructionTarget={instructionTarget} />
            ) : (
              <ActivityLines key={`${item.at}-${index}`} items={[item]} workspace={workspace} showSource />
            ),
          )}
        </div>
      )}
      {readOnly ? <p className={`${s.commentBox} ${s.commentBoxLocked}`}>アーカイブ済みのためコメントできません</p> : <div className={`${s.commentBox} ${instructing ? s.commentBoxInstruction : ""}`}>
        {instructionTarget && (
          <div className={s.modeSwitchRow}>
            <div className={s.modeSwitch} role="radiogroup" aria-label="コメント欄の種類">
              {([["comment", "コメント"], ["instruction", "LLM に追加指示"]] as const).map(([key, label]) => (
                <button key={key} type="button" role="radio" aria-checked={mode === key} disabled={action.busy} onClick={() => { setMode(key); setNotice(""); }}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
        <textarea
          disabled={action.busy}
          className={s.commentInput}
          aria-label={instructing ? "追加指示" : "コメント"}
          placeholder={instructing ? `${instructionTarget.agent} への追加指示を書く…` : "コメントを書く…"}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        {action.error && (
          <p className={`${s.error} ${s.panelError}`} role="alert">
            {action.error}
          </p>
        )}
        <div className={s.commentActions}>
          {instructing ? (
            <>
              <span className={s.instructionHint}>
                宛先: {instructionTarget.agent}{instructionTarget.location ? `（Orca · ${instructionTarget.location}）` : "（実行場所未記録）"}
              </span>
              {notice && <span role="status" className={s.copyNotice}>{notice}</span>}
              <Button variant="primary" onClick={() => { setNotice(""); setConfirming(true); }} disabled={!hasText(body)}>
                送信…
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={() => void submit()} disabled={action.busy || !hasText(body)}>
              コメントする
            </Button>
          )}
        </div>
      </div>}
      {confirming && instructionTarget && (
        <SendInstructionDialog
          issueId={instructionTarget.issueId}
          agent={instructionTarget.agent}
          target={{ kind: "new", body: body.trim() }}
          onClose={() => setConfirming(false)}
          onDone={({ sent, sendFailed }) => {
            setConfirming(false);
            setBody("");
            setNotice(sent ? "送信しました" : sendFailed ? "記録しました（送信できませんでした。Activity から送り直せます）" : "記録しました");
          }}
        />
      )}
    </section>
  );
}
