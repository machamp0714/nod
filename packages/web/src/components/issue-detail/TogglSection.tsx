import { type ReactNode, useEffect, useState } from "react";
import { ApiError } from "../../api/client";
import { errorMessage } from "../../api/errors";
import { type TogglActionInput, useToggl, useTogglAction, useTogglProjects, useTogglProjectsRefresh, useTogglRefresh } from "../../api/hooks/toggl";
import type { TogglCurrentEntry, TogglIssueView, TogglProject, TogglProjectsView } from "../../api/types";
import { formatElapsed, formatTime } from "../../lib/format";
import { Button, Icon } from "../ui";
import s from "./issue-detail.module.css";

// 前回使った Project（開始・変更に成功した Project）。ブラウザに覚え、nod の DB には保存しない。
// 覚えられない・読めないブラウザ（保存が禁じられているなど）でも打刻できるよう、失敗は無視する
const LAST_PROJECT_KEY = "nod.toggl.projectId";

function readLastProject(): number | null {
  try {
    const value = window.localStorage.getItem(LAST_PROJECT_KEY);
    return value !== null && /^\d+$/.test(value) ? Number(value) : null;
  } catch {
    return null;
  }
}

function saveLastProject(projectId: number | null): void {
  try {
    if (projectId === null) window.localStorage.removeItem(LAST_PROJECT_KEY);
    else window.localStorage.setItem(LAST_PROJECT_KEY, String(projectId));
  } catch {
    // 覚えられなくても打刻はできる。次に開いたときの初期値が「Project なし」になるだけ
  }
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
// （認証の失敗・利用上限の待ち・成否を確認できていない間。通信の失敗だけなら開始の直前に取り直すので押せる）。
// ボタンの横に Project の選択欄を置く。打刻中はその打刻の Project を出し、変えると Toggl の打刻の Project も変える。
// そうでなければ開始（切り替え）に使う Project で、初期値は前回使った Project（一覧に無くなっていれば「Project なし」）。
// Project の一覧を取得できなければ選択欄だけを無効にし、開始・停止はできる（Project なしで開始する）
export function TogglSection({ issueId }: { issueId: string }) {
  const query = useToggl(issueId);
  const action = useTogglAction(issueId);
  const refresh = useTogglRefresh(issueId);
  const projectsQuery = useTogglProjects();
  const projectsRefresh = useTogglProjectsRefresh();
  const projectsView = projectsQuery.data;
  const projects = projectsView?.projects ?? null;
  const [lastProject, setLastProject] = useState<number | null>(readLastProject);
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
  const projectsError = projectsRefresh.error ?? projectsQuery.error;
  // 開始（切り替え）に使う Project。前回の Project が一覧に無ければ（一覧を取得できていなければ）Project なし
  const startProject = lastProject !== null && projects?.some((p) => p.id === lastProject) ? lastProject : null;
  // 選択欄に出す Project。打刻中はその打刻の Project（変更の応答を待つ間は選んだ Project）
  const pendingProject = action.isPending && action.variables?.op === "project" ? action.variables.projectId : undefined;
  const shownProject = display.kind === "this_issue" ? (pendingProject !== undefined ? pendingProject : display.entry.projectId) : startProject;
  // 開始・停止・Project の変更と「最新にする」は、前の操作の失敗の表示を消してから行う。
  // 開始・変更に成功した Project を、次の開始の初期値としてブラウザに覚える
  const run = (input: TogglActionInput) => {
    refresh.reset();
    projectsRefresh.reset();
    action.mutate(input, {
      onSuccess: () => {
        if (input.op === "stop") return;
        saveLastProject(input.projectId);
        setLastProject(input.projectId);
      },
    });
  };
  const chooseProject = (projectId: number | null) => {
    if (display.kind === "this_issue") run({ op: "project", projectId });
    else setLastProject(projectId);
  };
  const reload = () => {
    action.reset();
    refresh.mutate();
    projectsRefresh.mutate();
  };
  const projectSelect = (
    <ProjectSelect
      projects={projects}
      value={shownProject}
      disabled={blocked || projects === null || projectsRefresh.isPending}
      onChange={chooseProject}
    />
  );

  return (
    <section className={s.panel} aria-label="Toggl 打刻" aria-busy={busy}>
      <h2 className={s.panelHeading}>Toggl 打刻</h2>
      <div className={s.toggl}>
        {display.kind === "this_issue" && (
          <>
            <Elapsed start={display.entry.start} />
            <div className={s.togglRow}>
              {projectSelect}
              <Button size="sm" icon="square" disabled={blocked} onClick={() => run({ op: "stop" })}>
                打刻を停止
              </Button>
            </div>
          </>
        )}
        {display.kind === "other" && (
          <>
            <p className={s.togglOther}>
              <span className={s.togglOtherLabel}>別の打刻が動いています</span>
              <span className={s.togglOtherDescription}>{display.entry.description || "（説明なし）"}</span>
            </p>
            <div className={s.togglRow}>
              {projectSelect}
              <Button size="sm" icon="play" disabled={blocked} onClick={() => run({ op: "start", projectId: startProject })}>
                この Issue に切り替える
              </Button>
            </div>
          </>
        )}
        {display.kind === "none" && (
          <>
            {display.label && <span className={s.togglIdle}>{display.label}</span>}
            <div className={s.togglRow}>
              {projectSelect}
              <Button size="sm" icon="play" disabled={blocked} onClick={() => run({ op: "start", projectId: startProject })}>
                打刻を開始
              </Button>
            </div>
          </>
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
              disabled={busy || quotaWaiting || projectsRefresh.isPending}
              onClick={reload}
            >
              <Icon name={refresh.isPending ? "loader-circle" : "refresh-cw"} size={12} />
            </button>
          </div>
        )}
        {view && <TogglNotices view={view} quotaWaiting={quotaWaiting} />}
        {view?.configured && <ProjectsNotice view={view} projectsView={projectsView} error={projectsError} />}
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

// Project の選択欄。「Project なし」と一覧の Project を出す。今の値が一覧に無い（打刻の Project が有効でなくなった・
// 一覧を取得できていない）ときは、「Project なし」と取り違えないよう「一覧にない Project」として出す
function ProjectSelect({ projects, value, disabled, onChange }: {
  projects: TogglProject[] | null;
  value: number | null;
  disabled: boolean;
  onChange: (projectId: number | null) => void;
}) {
  const unlisted = value !== null && !projects?.some((p) => p.id === value);
  return (
    <select
      className={`${s.select} ${s.togglProject}`}
      aria-label="Toggl の Project"
      value={value === null ? "" : String(value)}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
    >
      <option value="">Project なし</option>
      {unlisted && <option value={String(value)}>一覧にない Project</option>}
      {projects?.map((p) => (
        <option key={p.id} value={String(p.id)}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

// Project の一覧を取得できなかった理由。認証の失敗・利用上限の待ちは打刻の欄の案内と同じなので、重ねて出さない
function ProjectsNotice({ view, projectsView, error }: { view: TogglIssueView; projectsView: TogglProjectsView | undefined; error: Error | null }) {
  if (error) return <Notice>Project の一覧を取得できませんでした：{errorMessage(error)}</Notice>;
  const failure = projectsView?.failure;
  if (!failure || failure.kind === view.failure?.kind) return null;
  return (
    <Notice>
      Project の一覧を取得できませんでした（{failure.detail}）。{projectsView?.projects ? "一覧は最後に分かっているものです" : "Project なしで打刻します"}
    </Notice>
  );
}
