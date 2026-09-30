import type { PrStatus } from "../../api/types";
import { APPROVAL_NOTE, approvalWarnings, PR_STATUS_UNFETCHED, prStatePill } from "../../lib/pr-status";
import { Icon } from "../ui";
import s from "./issue-detail.module.css";
import { PrCiPill, PrFailedChecks, PrFetchError, PrPill, prFetchedText, usePrStatusView } from "./PrStatusSection";

// nod の承認と GitHub PR の関係（#56/#57）。nod.pen「Reviews｜GitHub状態と承認注記」「Issue詳細｜親の完了候補 GitHub注記」に合わせる。
// 表示は保存済みの PR 状態だけを読み、gh の実行は「更新」ボタンでだけ行う。nod の承認は GitHub へ何も書き込まない

// Reviews の PR Card の下に出す「GitHub の状態」行
export function GithubStatusRow({ issueId }: { issueId: string }) {
  const view = usePrStatusView(issueId);
  const { status, busy, review } = view;
  return (
    <div className={s.ghStatus} role="group" aria-label="GitHub の状態" aria-busy={busy}>
      <div className={s.ghStatusRow}>
        <Icon name="github" size={14} />
        <span className={s.ghStatusLabel}>GitHub の状態</span>
        {status ? (
          <span className={s.prPills} data-testid="github-status-result">
            <PrPill spec={prStatePill(status)} />
            {review && <PrPill spec={review} />}
            <PrCiPill view={view} />
          </span>
        ) : (
          !busy && <span className={s.ghStatusUnfetched}>{PR_STATUS_UNFETCHED}</span>
        )}
        {(status || busy) && (
          <span className={s.prFetched} title={status && !busy ? status.fetchedAt : undefined}>
            {prFetchedText(view, "")}
          </span>
        )}
        <span className={s.ghStatusSpacer} />
        <button
          type="button"
          className={s.prRefresh}
          aria-label="GitHub の状態を更新"
          title="gh で PR の状態を取得する（GitHub へは読み取りのみ）"
          disabled={busy}
          onClick={view.refresh}
        >
          <Icon name={busy ? "loader-circle" : "refresh-cw"} size={12} />
        </button>
      </div>
      <PrFailedChecks view={view} />
      <PrFetchError view={view} />
    </div>
  );
}

// 承認ボタン付近の注記と注意。注意は未マージ・変更要求を知らせるだけで、承認は止めない
export function ApprovalNotice({ status, compact = false }: { status: PrStatus | null; compact?: boolean }) {
  const warnings = approvalWarnings(status);
  const iconSize = compact ? 12.5 : 13;
  return (
    <>
      <p className={compact ? `${s.approvalNote} ${s.approvalCompact}` : s.approvalNote}>
        <Icon name="info" size={iconSize} />
        <span>{APPROVAL_NOTE}</span>
      </p>
      {/* 注意は保存済みの状態から出す。更新で現れたときに読み上げるよう、ライブ領域は常に置く（#143） */}
      <div className={s.ghCautionLive} role="status">
        {warnings.length > 0 && (
          <ul
            className={compact ? `${s.ghCaution} ${s.approvalCompact}` : s.ghCaution}
            aria-label="GitHub 側の注意"
            title={status ? `取得: ${status.fetchedAt}` : undefined}
          >
            {warnings.map((w) => (
              <li key={w}>
                <Icon name="circle-alert" size={iconSize} />
                <span>{w}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
