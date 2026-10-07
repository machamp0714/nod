import { type ReactNode, useEffect, useState } from "react";
import { ApiError } from "../../api/client";
import { errorMessage } from "../../api/errors";
import { useToggl, useTogglAction, useTogglRefresh } from "../../api/hooks/toggl";
import type { TogglCurrentEntry, TogglIssueView } from "../../api/types";
import { formatElapsed, formatTime } from "../../lib/format";
import { Button, Icon } from "../ui";
import s from "./issue-detail.module.css";

// 経過時間は取得した開始時刻から画面内で数え、毎秒 Toggl を呼ばない
function Elapsed({ start }: { start: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span role="timer" aria-label="経過時間" className={s.togglElapsed}>
      {formatElapsed(now - Date.parse(start))}
    </span>
  );
}

// 開始・停止の失敗の表示。切り替えの途中の失敗・競合は、server が前の打刻と新しい打刻の成否を書いた文言をそのまま出す。
// 認証の失敗・利用上限の待ちは、返ってきた状態（failure）の案内で知らせるので、ここでは出さない
function actionErrorText(err: Error): string | null {
  if (err instanceof ApiError && (err.code === "TOGGL_AUTH" || err.code === "TOGGL_QUOTA")) return null;
  if (err instanceof ApiError && (err.code === "TOGGL_START_FAILED" || err.code === "TOGGL_CONFLICT")) return err.message;
  return `Toggl の操作に失敗しました：${errorMessage(err)}`;
}

// until（ISO）より前の間は true。until を過ぎたら描き直す（利用上限の待ちが終わったらボタンを戻す）
function useWaitingUntil(until: string | undefined): boolean {
  const end = until ? Date.parse(until) : Number.NaN;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (Number.isNaN(end) || end <= Date.now()) return;
    const timer = setTimeout(() => setTick((n) => n + 1), end - Date.now() + 50);
    return () => clearTimeout(timer);
  }, [end]);
  return !Number.isNaN(end) && Date.now() < end;
}

// 欄の上段に出すもの。この Issue の打刻（停止と経過時間）、別の打刻（説明と切り替え）、どちらでもない（状態の文言と開始）
type EntryDisplay =
  | { kind: "this_issue"; entry: TogglCurrentEntry }
  | { kind: "other"; entry: TogglCurrentEntry }
  | { kind: "none"; label: string };

// 成否を確認できていない間は、操作前の打刻を表示しない（「未確認」と出す）。
// 読み込み中・一度も取得できていない・成否を確認できていないときは「停止中」と言い切らない
function entryDisplayOf(view: TogglIssueView | undefined): EntryDisplay {
  if (view === undefined) return { kind: "none", label: "" };
  if (!view.configured) return { kind: "none", label: "未設定" };
  if (view.unconfirmed || view.fetchedAt === null) return { kind: "none", label: "未確認" };
  if (view.current === null) return { kind: "none", label: "停止中" };
  return { kind: view.current.thisIssue ? "this_issue" : "other", entry: view.current };
}

// 右 rail の Toggl 打刻の欄（NOD-6）。この Issue の打刻（説明が「<ID> 」で始まる）なら停止と経過時間を出す。
// 別の打刻が動いていれば、その説明と「この Issue に切り替える」を出し、確認なしで止めて切り替える。何も動いていなければ開始を出す。
// Toggl を呼べなかったときは、最後に分かっている状態を「〜時点」と添えて出し、理由に応じてボタンを無効にする
// （認証の失敗・利用上限の待ち・成否を確認できていない間。通信の失敗だけなら開始の直前に取り直すので押せる）
export function TogglSection({ issueId }: { issueId: string }) {
  const query = useToggl(issueId);
  const action = useTogglAction(issueId);
  const refresh = useTogglRefresh(issueId);
  const view = query.data;
  const failure = view?.failure ?? null;
  const authFailed = failure?.kind === "auth";
  const quotaWaiting = useWaitingUntil(failure?.kind === "quota" ? failure.retryAfter : undefined);
  const unconfirmed = view?.unconfirmed === true;
  const display = entryDisplayOf(view);
  const busy = action.isPending || query.isPending || refresh.isPending;
  const blocked = busy || view?.configured !== true || authFailed || quotaWaiting || unconfirmed;
  const error = action.error ?? refresh.error ?? query.error;
  const errorText = action.error ? actionErrorText(action.error) : error ? `Toggl の状態を取得できませんでした：${errorMessage(error)}` : null;
  // 開始・停止と「最新にする」は、前の操作の失敗の表示を消してから行う
  const run = (op: "start" | "stop") => {
    refresh.reset();
    action.mutate(op);
  };
  const reload = () => {
    action.reset();
    refresh.mutate();
  };

  return (
    <section className={s.panel} aria-label="Toggl 打刻" aria-busy={busy}>
      <h2 className={s.panelHeading}>Toggl 打刻</h2>
      <div className={s.toggl}>
        {display.kind === "this_issue" && (
          <div className={s.togglRow}>
            <Elapsed start={display.entry.start} />
            <Button size="sm" icon="square" disabled={blocked} onClick={() => run("stop")}>
              打刻を停止
            </Button>
          </div>
        )}
        {display.kind === "other" && (
          <>
            <p className={s.togglOther}>
              <span className={s.togglOtherLabel}>別の打刻が動いています</span>
              <span className={s.togglOtherDescription}>{display.entry.description || "（説明なし）"}</span>
            </p>
            <div className={s.togglRow}>
              <Button size="sm" icon="play" disabled={blocked} onClick={() => run("start")}>
                この Issue に切り替える
              </Button>
            </div>
          </>
        )}
        {display.kind === "none" && (
          <div className={s.togglRow}>
            <span className={s.togglIdle}>{display.label}</span>
            <Button size="sm" icon="play" disabled={blocked} onClick={() => run("start")}>
              打刻を開始
            </Button>
          </div>
        )}
        {/* 取得時刻と「最新にする」。成否を確認できていない間も、最後に Toggl の状態が分かった時刻を出す。
            初めての取得に失敗したときも取り直せるように出す */}
        {(view?.configured || query.isError) && (
          <div className={s.fetchRow}>
            <span className={s.fetchedText} title={view?.fetchedAt ?? undefined}>
              {refresh.isPending ? "取得中…" : view?.fetchedAt ? `${formatTime(view.fetchedAt)} 時点` : ""}
            </span>
            <button
              type="button"
              className={s.refreshButton}
              aria-label="最新にする"
              title="Toggl から現在の打刻を取り直す"
              disabled={busy || quotaWaiting}
              onClick={reload}
            >
              <Icon name={refresh.isPending ? "loader-circle" : "refresh-cw"} size={12} />
            </button>
          </div>
        )}
        {view && <TogglNotices view={view} quotaWaiting={quotaWaiting} />}
        {errorText && (
          <p className={s.inlineError} role="alert">
            <Icon name="circle-alert" size={12} />
            <span>{errorText}</span>
          </p>
        )}
      </div>
    </section>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className={s.inlineError} role="status">
      <Icon name="circle-alert" size={12} />
      <span>{children}</span>
    </p>
  );
}

// 未設定・認証の失敗の案内と、利用上限の待ち・通信の失敗・成否不明の知らせ。
// 成否を確認できていない間は、通信の失敗より成否不明を知らせる
function TogglNotices({ view, quotaWaiting }: { view: TogglIssueView; quotaWaiting: boolean }) {
  const { failure } = view;
  return (
    <>
      {!view.configured && (
        <div className={s.togglGuide}>
          <p>Toggl の API トークンを次のファイルに書くと使えます（権限は 600 を推奨）。</p>
          <code className={s.togglCode}>{view.configPath}</code>
          <code className={s.togglCode}>{'{"apiToken": "<API トークン>"}'}</code>
        </div>
      )}
      {failure?.kind === "auth" && (
        <div className={s.togglGuide} role="status">
          <p>Toggl の API トークンが受け付けられませんでした（{failure.detail}）。次のファイルのトークンを直してください。</p>
          <code className={s.togglCode}>{view.configPath}</code>
        </div>
      )}
      {failure?.kind === "quota" && quotaWaiting && failure.retryAfter && (
        <Notice>Toggl の利用上限に達したため、{formatTime(failure.retryAfter)} まで打刻を操作できません</Notice>
      )}
      {failure?.kind === "network" && !view.unconfirmed && (
        <Notice>
          Toggl に接続できませんでした（{failure.detail}）。{view.fetchedAt ? "表示は最後に分かっている状態です" : "打刻の状態は分かりません"}
        </Notice>
      )}
      {view.unconfirmed && <Notice>打刻の成否を確認できていません。「最新にする」で取り直せるまで操作できません</Notice>}
    </>
  );
}
