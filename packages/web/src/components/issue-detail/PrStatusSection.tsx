import { useState } from "react";
import { errorMessage } from "../../api/errors";
import { usePrStatus, useRefreshPrStatus } from "../../api/hooks/pr-status";
import type { PrCheck } from "../../api/types";
import { formatRelative } from "../../lib/format";
import { TONE_COLORS } from "../../lib/meta";
import { ciPill, type PillSpec, prStatePill, reviewPill, safeCheckUrl } from "../../lib/pr-status";
import { Icon } from "../ui";
import s from "./issue-detail.module.css";

export function PrPill({ spec }: { spec: PillSpec }) {
  const color = TONE_COLORS[spec.tone];
  return (
    <span className={s.prPill} style={{ color: color.fg, background: color.bg }}>
      <Icon name={spec.icon} size={11} />
      {spec.label}
    </span>
  );
}

// 保存済みの PR 状態と「更新」の状態。プロパティの PR 状態と Reviews の「GitHub の状態」で共通
export function usePrStatusView(issueId: string) {
  const query = usePrStatus(issueId);
  const refresh = useRefreshPrStatus(issueId);
  const [expanded, setExpanded] = useState(false);
  const status = query.data?.status ?? null;
  return {
    status,
    fetchError: query.data?.fetchError ?? null,
    requestError: refresh.error ?? query.error,
    busy: refresh.isPending,
    refresh: () => refresh.mutate(undefined),
    review: status ? reviewPill(status) : null,
    ci: status ? ciPill(status) : null,
    failures: status?.checks.filter((c) => c.state === "failure") ?? [],
    expanded,
    toggleExpanded: () => setExpanded(!expanded),
  };
}
type PrStatusView = ReturnType<typeof usePrStatusView>;

// CI のピル。失敗したチェックがあれば、押して一覧を開くボタンにする
export function PrCiPill({ view }: { view: PrStatusView }) {
  const { ci, failures, expanded } = view;
  if (!ci) return null;
  const style = { color: TONE_COLORS[ci.tone].fg, background: TONE_COLORS[ci.tone].bg };
  return failures.length > 0 ? (
    <button
      type="button"
      className={`${s.prPill} ${s.prCiPill}`}
      style={style}
      title={ci.title}
      aria-label={`CI ${ci.title}`}
      aria-expanded={expanded}
      onClick={view.toggleExpanded}
    >
      {ci.text}
      <Icon name={expanded ? "chevron-up" : "chevron-down"} size={11} />
    </button>
  ) : (
    <span className={`${s.prPill} ${s.prCiPill}`} style={style} title={ci.title} aria-label={`CI ${ci.title}`}>
      {ci.text}
    </span>
  );
}

export function PrFailedChecks({ view }: { view: PrStatusView }) {
  if (!view.expanded || view.failures.length === 0) return null;
  return (
    <ul className={s.prFailures} aria-label="失敗したチェック">
      {view.failures.map((c: PrCheck, i) => {
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
  );
}

export function PrFetchError({ view }: { view: PrStatusView }) {
  const { fetchError, requestError } = view;
  if (!fetchError && !requestError) return null;
  return (
    <p className={s.prError} role="alert">
      <Icon name="circle-alert" size={12} />
      <span>{fetchError ? fetchError.message : `更新できませんでした：${errorMessage(requestError)}`}</span>
    </p>
  );
}

// 取得時刻の表示（更新中は「取得中…」）
export function prFetchedText(view: PrStatusView, unfetched: string): string {
  return view.busy ? "取得中…" : view.status ? `取得: ${formatRelative(view.status.fetchedAt)}` : unfetched;
}

// プロパティの PR 行の下に出す PR 状態（#67）。保存済みの結果を表示し、gh の実行は「更新」ボタンでだけ行う
export function PrStatusSection({ issueId }: { issueId: string }) {
  const view = usePrStatusView(issueId);
  const { status, fetchError, busy, review } = view;

  return (
    <div className={s.prStatus} role="group" aria-label="PR 状態" aria-busy={busy}>
      {status && (
        <div className={fetchError ? `${s.prResult} ${s.prResultStale}` : s.prResult} data-testid="pr-status-result">
          <div className={s.prPills}>
            <PrPill spec={prStatePill(status)} />
            {review && <PrPill spec={review} />}
          </div>
          {view.ci && (
            <div className={s.prPills}>
              <PrCiPill view={view} />
            </div>
          )}
          <PrFailedChecks view={view} />
        </div>
      )}
      <PrFetchError view={view} />
      <div className={s.prFetchRow}>
        <span className={s.prFetched} title={status && !busy ? status.fetchedAt : undefined}>
          {prFetchedText(view, "未取得")}
        </span>
        <button
          type="button"
          className={s.prRefresh}
          aria-label="PR の状態を更新"
          title="gh で PR の状態を取得する"
          disabled={busy}
          onClick={view.refresh}
        >
          <Icon name={busy ? "loader-circle" : "refresh-cw"} size={12} />
        </button>
      </div>
    </div>
  );
}
