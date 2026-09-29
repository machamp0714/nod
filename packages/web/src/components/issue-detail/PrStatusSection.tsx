import { useState } from "react";
import { errorMessage } from "../../api/errors";
import { usePrStatus, useRefreshPrStatus } from "../../api/hooks/pr-status";
import { formatRelative } from "../../lib/format";
import { TONE_COLORS } from "../../lib/meta";
import { ciPill, type PillSpec, prStatePill, reviewPill } from "../../lib/pr-status";
import { Icon } from "../ui";
import s from "./issue-detail.module.css";

function PrPill({ spec }: { spec: PillSpec }) {
  const color = TONE_COLORS[spec.tone];
  return (
    <span className={s.prPill} style={{ color: color.fg, background: color.bg }}>
      <Icon name={spec.icon} size={11} />
      {spec.label}
    </span>
  );
}

// プロパティの PR 行の下に出す PR 状態（#67）。保存済みの結果を表示し、gh の実行は「更新」ボタンでだけ行う
export function PrStatusSection({ issueId }: { issueId: string }) {
  const query = usePrStatus(issueId);
  const refresh = useRefreshPrStatus(issueId);
  const [expanded, setExpanded] = useState(false);
  const status = query.data?.status ?? null;
  const fetchError = query.data?.fetchError ?? null;
  const busy = refresh.isPending;
  const requestError = refresh.error ?? query.error;
  const ci = status ? ciPill(status) : null;
  const review = status ? reviewPill(status) : null;
  const failures = status?.checks.filter((c) => c.state === "failure") ?? [];

  return (
    <div className={s.prStatus} role="group" aria-label="PR 状態" aria-busy={busy}>
      {status && (
        <div className={fetchError ? `${s.prResult} ${s.prResultStale}` : s.prResult} data-testid="pr-status-result">
          <div className={s.prPills}>
            <PrPill spec={prStatePill(status)} />
            {review && <PrPill spec={review} />}
          </div>
          {ci && (
            <div className={s.prPills}>
              {failures.length > 0 ? (
                <button
                  type="button"
                  className={`${s.prPill} ${s.prCiPill}`}
                  style={{ color: TONE_COLORS[ci.tone].fg, background: TONE_COLORS[ci.tone].bg }}
                  title={ci.title}
                  aria-label={`CI ${ci.title}`}
                  aria-expanded={expanded}
                  onClick={() => setExpanded(!expanded)}
                >
                  {ci.text}
                  <Icon name={expanded ? "chevron-up" : "chevron-down"} size={11} />
                </button>
              ) : (
                <span
                  className={`${s.prPill} ${s.prCiPill}`}
                  style={{ color: TONE_COLORS[ci.tone].fg, background: TONE_COLORS[ci.tone].bg }}
                  title={ci.title}
                  aria-label={`CI ${ci.title}`}
                >
                  {ci.text}
                </span>
              )}
            </div>
          )}
          {expanded && failures.length > 0 && (
            <ul className={s.prFailures} aria-label="失敗したチェック">
              {failures.map((c, i) => (
                <li key={`${c.name}-${i}`} className={s.prFailure}>
                  <Icon name="circle-x" size={11} />
                  {c.url ? (
                    <a href={c.url} target="_blank" rel="noreferrer">
                      {c.name}
                    </a>
                  ) : (
                    c.name
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {(fetchError || requestError) && (
        <p className={s.prError} role="alert">
          <Icon name="circle-alert" size={12} />
          <span>{fetchError ? fetchError.message : `更新できませんでした：${errorMessage(requestError)}`}</span>
        </p>
      )}
      <div className={s.prFetchRow}>
        <span className={s.prFetched} title={status && !busy ? status.fetchedAt : undefined}>
          {busy ? "取得中…" : status ? `取得: ${formatRelative(status.fetchedAt)}` : "未取得"}
        </span>
        <button
          type="button"
          className={s.prRefresh}
          aria-label="PR の状態を更新"
          title="gh で PR の状態を取得する"
          disabled={busy}
          onClick={() => refresh.mutate(undefined)}
        >
          <Icon name={busy ? "loader-circle" : "refresh-cw"} size={12} />
        </button>
      </div>
    </div>
  );
}
