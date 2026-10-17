import type { IssueDetail } from "../../api/types";
import { Icon } from "../ui";
import s from "./issue-detail.module.css";
import { useAsyncAction } from "./useAsyncAction";

// 子がすべて終わった親を、通常の状態変更で完了にする
export function CompletionCandidateBanner({ issue, onComplete }: {
  issue: IssueDetail;
  onComplete: () => Promise<unknown>;
}) {
  const action = useAsyncAction();
  if (!issue.completionCandidate) return null;
  const count = (status: string) => issue.children.filter((child) => child.status === status).length;
  return (
    <section className={s.completionBanner} aria-label="親の完了候補">
      <div className={s.completionRow}>
        <Icon name="circle-check" size={16} color="var(--ready)" />
        <div className={s.completionText}>
          Sub-issue がすべて完了しました（完了 {count("done")}・キャンセル {count("canceled")}）。この Issue も完了にできます
        </div>
        <button
          type="button"
          className={s.completionButton}
          disabled={action.busy}
          onClick={() => void action.run(onComplete, "完了にできませんでした")}
        >
          完了にする
        </button>
      </div>
      {action.error && (
        <p className={s.completionError} role="alert">
          <Icon name="circle-alert" size={13} color="var(--fail)" />
          {action.error}
        </p>
      )}
    </section>
  );
}
