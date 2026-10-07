import { useEffect, useState } from "react";
import { ApiError } from "../../api/client";
import { errorMessage } from "../../api/errors";
import { useToggl, useTogglAction, useTogglRefresh } from "../../api/hooks/toggl";
import { Button, Icon } from "../ui";
import s from "./issue-detail.module.css";

// 開始時刻からの経過を「時:分:秒」で表す（Toggl の表示と同じ形）
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${Math.floor(total / 3600)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

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

// ローカル時刻の「HH:mm」
function formatClock(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return Number.isNaN(d.getTime()) ? iso : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 表示している状態がいつ Toggl で分かったものか（「HH:mm 時点」）
function formatFetchedAt(iso: string): string {
  return `${formatClock(iso)} 時点`;
}

// 開始・停止の失敗の表示。切り替えの途中の失敗・競合は、server が前の打刻と新しい打刻の成否を書いた文言をそのまま出す。
// 認証の失敗・利用上限の待ちは、返ってきた状態（failure）の案内で知らせるので、ここでは出さない
function actionErrorText(err: Error): string | null {
  if (err instanceof ApiError && (err.code === "TOGGL_AUTH" || err.code === "TOGGL_QUOTA")) return null;
  if (err instanceof ApiError && (err.code === "TOGGL_START_FAILED" || err.code === "TOGGL_CONFLICT")) return err.message;
  return `Toggl の操作に失敗しました：${errorMessage(err)}`;
}

// until（ISO）より前か。until を過ぎたら描き直す（利用上限の待ちが終わったらボタンを戻す）
function useBefore(until: string | undefined): boolean {
  const end = until ? Date.parse(until) : Number.NaN;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (Number.isNaN(end) || end <= Date.now()) return;
    const timer = setTimeout(() => setTick((n) => n + 1), end - Date.now() + 50);
    return () => clearTimeout(timer);
  }, [end]);
  return !Number.isNaN(end) && Date.now() < end;
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
  const waiting = useBefore(failure?.kind === "quota" ? failure.retryAfter : undefined);
  const unconfirmed = view?.unconfirmed === true;
  // 成否を確認できていない間は、操作前の打刻を表示しない（「未確認」と出す）
  const current = unconfirmed ? null : (view?.current ?? null);
  const unknown = view?.configured === true && (unconfirmed || view.fetchedAt === null);
  const mine = current?.thisIssue ? current : null;
  const other = current && !current.thisIssue ? current : null;
  const busy = action.isPending || query.isPending || refresh.isPending;
  const blocked = busy || view?.configured !== true || authFailed || waiting || unconfirmed;
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
        {mine ? (
          <div className={s.togglRow}>
            <Elapsed start={mine.start} />
            <Button size="sm" icon="square" disabled={blocked} onClick={() => run("stop")}>
              打刻を停止
            </Button>
          </div>
        ) : other ? (
          <>
            <p className={s.togglOther}>
              <span className={s.togglOtherLabel}>別の打刻が動いています</span>
              <span className={s.togglOtherDescription}>{other.description || "（説明なし）"}</span>
            </p>
            <div className={s.togglRow}>
              <Button size="sm" icon="play" disabled={blocked} onClick={() => run("start")}>
                この Issue に切り替える
              </Button>
            </div>
          </>
        ) : (
          <div className={s.togglRow}>
            {/* 読み込み中・一度も取得できていない・成否を確認できていないときは「停止中」と言い切らない */}
            <span className={s.togglIdle}>{view?.configured === false ? "未設定" : unknown ? "未確認" : view?.configured === true ? "停止中" : ""}</span>
            <Button size="sm" icon="play" disabled={blocked} onClick={() => run("start")}>
              打刻を開始
            </Button>
          </div>
        )}
        {/* 取得時刻と「最新にする」。初めての取得に失敗したときも取り直せるように出す */}
        {(view?.configured || query.isError) && (
          <div className={s.prFetchRow}>
            <span className={s.prFetched} title={view?.fetchedAt ?? undefined}>
              {refresh.isPending ? "取得中…" : view?.fetchedAt && !unconfirmed ? formatFetchedAt(view.fetchedAt) : ""}
            </span>
            <button
              type="button"
              className={s.prRefresh}
              aria-label="最新にする"
              title="Toggl から現在の打刻を取り直す"
              disabled={busy || waiting}
              onClick={reload}
            >
              <Icon name={refresh.isPending ? "loader-circle" : "refresh-cw"} size={12} />
            </button>
          </div>
        )}
        {view?.configured === false && (
          <div className={s.togglGuide}>
            <p>Toggl の API トークンを次のファイルに書くと使えます（権限は 600 を推奨）。</p>
            <code className={s.togglCode}>{view.configPath}</code>
            <code className={s.togglCode}>{'{"apiToken": "<API トークン>"}'}</code>
          </div>
        )}
        {authFailed && view && (
          <div className={s.togglGuide} role="status">
            <p>Toggl の API トークンが受け付けられませんでした（{failure.detail}）。次のファイルのトークンを直してください。</p>
            <code className={s.togglCode}>{view.configPath}</code>
          </div>
        )}
        {waiting && failure?.retryAfter && (
          <p className={s.prError} role="status">
            <Icon name="circle-alert" size={12} />
            <span>Toggl の利用上限に達したため、{formatClock(failure.retryAfter)} まで打刻を操作できません</span>
          </p>
        )}
        {failure?.kind === "network" && !unconfirmed && (
          <p className={s.prError} role="status">
            <Icon name="circle-alert" size={12} />
            <span>
              Toggl に接続できませんでした（{failure.detail}）。{view?.fetchedAt ? "表示は最後に分かっている状態です" : "打刻の状態は分かりません"}
            </span>
          </p>
        )}
        {unconfirmed && (
          <p className={s.prError} role="status">
            <Icon name="circle-alert" size={12} />
            <span>打刻の成否を確認できていません。「最新にする」で取り直せるまで操作できません</span>
          </p>
        )}
        {errorText && (
          <p className={s.prError} role="alert">
            <Icon name="circle-alert" size={12} />
            <span>{errorText}</span>
          </p>
        )}
      </div>
    </section>
  );
}
