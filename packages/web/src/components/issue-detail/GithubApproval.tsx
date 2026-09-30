import { useState } from "react";
import { errorMessage } from "../../api/errors";
import { usePrStatus, useRefreshPrStatus } from "../../api/hooks/pr-status";
import type { PrStatus } from "../../api/types";
import { formatRelative } from "../../lib/format";
import { TONE_COLORS } from "../../lib/meta";
import { APPROVAL_NOTE, approvalWarnings, ciPill, PR_STATUS_UNFETCHED, prStatePill, reviewPill, safeCheckUrl } from "../../lib/pr-status";
import { Icon } from "../ui";
import s from "./issue-detail.module.css";
import { PrPill } from "./PrStatusSection";

// nod の承認と GitHub PR の関係（#56/#57）。nod.pen「Reviews｜GitHub状態と承認注記」「Issue詳細｜親の完了候補 GitHub注記」に合わせる。
// 表示は保存済みの PR 状態だけを読み、gh の実行は「更新」ボタンでだけ行う。nod の承認は GitHub へ何も書き込まない

// Reviews の PR Card の下に出す「GitHub の状態」行
export function GithubStatusRow({ issueId }: { issueId: string }) {
  const query = usePrStatus(issueId);
  const refresh = useRefreshPrStatus(issueId);
  const [expanded, setExpanded] = useState(false);
  const status = query.data?.status ?? null;
  const fetchError = query.data?.fetchError ?? null;
  const busy = refresh.isPending;
  const requestError = refresh.error ?? query.error;
  const review = status ? reviewPill(status) : null;
  const ci = status ? ciPill(status) : null;
  const failures = status?.checks.filter((c) => c.state === "failure") ?? [];
  const ciStyle = ci ? { color: TONE_COLORS[ci.tone].fg, background: TONE_COLORS[ci.tone].bg } : undefined;
  return (
    <div className={s.ghStatus} role="group" aria-label="GitHub の状態" aria-busy={busy}>
      <div className={s.ghStatusRow}>
        <Icon name="github" size={14} />
        <span className={s.ghStatusLabel}>GitHub の状態</span>
        {status ? (
          <span className={s.prPills} data-testid="github-status-result">
            <PrPill spec={prStatePill(status)} />
            {review && <PrPill spec={review} />}
            {ci &&
              (failures.length > 0 ? (
                <button
                  type="button"
                  className={`${s.prPill} ${s.prCiPill}`}
                  style={ciStyle}
                  title={ci.title}
                  aria-label={`CI ${ci.title}`}
                  aria-expanded={expanded}
                  onClick={() => setExpanded(!expanded)}
                >
                  {ci.text}
                  <Icon name={expanded ? "chevron-up" : "chevron-down"} size={11} />
                </button>
              ) : (
                <span className={`${s.prPill} ${s.prCiPill}`} style={ciStyle} title={ci.title} aria-label={`CI ${ci.title}`}>
                  {ci.text}
                </span>
              ))}
          </span>
        ) : (
          !busy && <span className={s.ghStatusUnfetched}>{PR_STATUS_UNFETCHED}</span>
        )}
        {(status || busy) && (
          <span className={s.prFetched} title={status && !busy ? status.fetchedAt : undefined}>
            {busy ? "取得中…" : status ? `取得: ${formatRelative(status.fetchedAt)}` : ""}
          </span>
        )}
        <span className={s.ghStatusSpacer} />
        <button
          type="button"
          className={s.prRefresh}
          aria-label="GitHub の状態を更新"
          title="gh で PR の状態を取得する（GitHub へは読み取りのみ）"
          disabled={busy}
          onClick={() => refresh.mutate(undefined)}
        >
          <Icon name={busy ? "loader-circle" : "refresh-cw"} size={12} />
        </button>
      </div>
      {expanded && failures.length > 0 && (
        <ul className={s.prFailures} aria-label="失敗したチェック">
          {failures.map((c, i) => {
            const href = safeCheckUrl(c.url);
            return (
              <li key={`${c.name}-${i}`} className={s.prFailure}>
                <Icon name="circle-x" size={11} />
                {href ? (
                  <a href={href} target="_blank" rel="noreferrer">
                    {c.name}
                  </a>
                ) : (
                  c.name
                )}
              </li>
            );
          })}
        </ul>
      )}
      {(fetchError || requestError) && (
        <p className={s.prError} role="alert">
          <Icon name="circle-alert" size={12} />
          <span>{fetchError ? fetchError.message : `更新できませんでした：${errorMessage(requestError)}`}</span>
        </p>
      )}
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
      {warnings.length > 0 && (
        <ul className={compact ? `${s.ghCaution} ${s.approvalCompact}` : s.ghCaution} aria-label="GitHub 側の注意">
          {warnings.map((w) => (
            <li key={w}>
              <Icon name="circle-alert" size={iconSize} />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
