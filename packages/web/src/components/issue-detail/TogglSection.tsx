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

// 表示している状態がいつ Toggl で分かったものか（ローカル時刻の「HH:mm 時点」）
function formatFetchedAt(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return Number.isNaN(d.getTime()) ? iso : `${pad(d.getHours())}:${pad(d.getMinutes())} 時点`;
}

// 開始・停止の失敗の表示。切り替えの途中の失敗・競合は、server が前の打刻と新しい打刻の成否を書いた文言をそのまま出す
function actionErrorText(err: Error): string {
  if (err instanceof ApiError && (err.code === "TOGGL_START_FAILED" || err.code === "TOGGL_CONFLICT")) return err.message;
  return `Toggl の操作に失敗しました：${errorMessage(err)}`;
}

// 右 rail の Toggl 打刻の欄（NOD-6）。この Issue の打刻（説明が「<ID> 」で始まる）なら停止と経過時間を出す。
// 別の打刻が動いていれば、その説明と「この Issue に切り替える」を出し、確認なしで止めて切り替える。何も動いていなければ開始を出す
export function TogglSection({ issueId }: { issueId: string }) {
  const query = useToggl(issueId);
  const action = useTogglAction(issueId);
  const refresh = useTogglRefresh(issueId);
  const view = query.data;
  const current = view?.current ?? null;
  const mine = current?.thisIssue ? current : null;
  const other = current && !current.thisIssue ? current : null;
  const busy = action.isPending || query.isPending || refresh.isPending;
  const error = action.error ?? refresh.error ?? query.error;
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
            <Button size="sm" icon="square" disabled={busy} onClick={() => run("stop")}>
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
              <Button size="sm" icon="play" disabled={busy || view?.configured !== true} onClick={() => run("start")}>
                この Issue に切り替える
              </Button>
            </div>
          </>
        ) : (
          <div className={s.togglRow}>
            {/* 読み込み中・取得の失敗では「停止中」と言い切らない */}
            <span className={s.togglIdle}>{view?.configured === false ? "未設定" : view?.configured === true ? "停止中" : ""}</span>
            <Button size="sm" icon="play" disabled={busy || view?.configured !== true} onClick={() => run("start")}>
              打刻を開始
            </Button>
          </div>
        )}
        {/* 取得時刻と「最新にする」。初めての取得に失敗したときも取り直せるように出す */}
        {(view?.configured || query.isError) && (
          <div className={s.prFetchRow}>
            <span className={s.prFetched} title={view?.fetchedAt ?? undefined}>
              {refresh.isPending ? "取得中…" : view?.fetchedAt ? formatFetchedAt(view.fetchedAt) : ""}
            </span>
            <button
              type="button"
              className={s.prRefresh}
              aria-label="最新にする"
              title="Toggl から現在の打刻を取り直す"
              disabled={busy}
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
        {error && (
          <p className={s.prError} role="alert">
            <Icon name="circle-alert" size={12} />
            <span>{action.error ? actionErrorText(action.error) : `Toggl の状態を取得できませんでした：${errorMessage(error)}`}</span>
          </p>
        )}
      </div>
    </section>
  );
}
