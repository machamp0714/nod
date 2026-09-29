import type { IssueDetail } from "../../api/types";
import { Icon } from "../ui";
import s from "./issue-detail.module.css";
import { useAsyncAction } from "./useAsyncAction";

// 親の完了候補。完了の確定は人が既存の経路（In Review なら承認、ほかは done への変更）で行う
export function CompletionCandidateBanner({ issue, onComplete, onApprove }: {
  issue: IssueDetail;
  onComplete: () => Promise<unknown>;
  onApprove: () => Promise<unknown>;
}) {
  const action = useAsyncAction();
  if (!issue.completionCandidate) return null;
  const count = (status: string) => issue.children.filter((child) => child.status === status).length;
  const inReview = issue.status === "in_review";
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
          onClick={() => void action.run(inReview ? onApprove : onComplete, "完了にできませんでした")}
        >
          {inReview ? "承認して完了" : "完了にする"}
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
