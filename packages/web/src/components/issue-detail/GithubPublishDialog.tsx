import { useCallback, useEffect, useId, useReducer, useRef, useState } from "react";
import { ApiError } from "../../api/client";
import { errorMessage } from "../../api/errors";
import { checkGithubText, useClearGithubUnknown, useGithubPreview, useLinkGithub, usePublishGithub, useSetWorkspaceGithubRepo } from "../../api/hooks/github";
import type { GithubPublishPreview, GithubPublishResult, LeakFinding } from "../../api/types";
import { canSend, checkReducer, findingLocation, githubLinkLabel, initialCheck } from "../../lib/github-publish";
import { Button } from "../ui";
import s from "./issue-detail.module.css";

const CHECK_DEBOUNCE_MS = 400;

// nod の Issue を GitHub Issue として作成する確認ダイアログ。宛先・アカウント・送る文面（その場で編集でき、保存しない）と、
// nod の情報の検出結果を示す。検出なしの今の文面だけを送れる。結果不明のときは作成の代わりに復旧の操作（紐付け・解除）を出す
export function GithubPublishDialog({ issueId, workspaceKey, onClose }: { issueId: string; workspaceKey: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const preview = useGithubPreview(issueId);
  // 下見を取り直している間も前の結果を出し続ける（mutate は data を空にするため、編集中の文面を失わないよう手元に持つ）
  const [data, setData] = useState<GithubPublishPreview>();
  const mutate = preview.mutate;
  const run = useCallback(() => mutate(undefined, { onSuccess: setData }), [mutate]);
  useEffect(() => {
    // 開発時の StrictMode は effect を2回呼ぶため、開いていなければ開く
    if (!ref.current?.open) ref.current?.showModal();
    run();
  }, [run]);
  const unknown = data?.state.pending?.state === "unknown";
  return (
    <dialog ref={ref} className={s.githubDialog} aria-labelledby={titleId} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <h2 id={titleId} className={s.githubDialogTitle}>GitHub に Issue を作成</h2>
      {preview.isPending && <p className={s.githubDialogNote}>宛先と内容を確かめています…</p>}
      {preview.error && <p role="alert" className={s.error}>確かめられませんでした：{errorMessage(preview.error)}</p>}
      {data && unknown && <UnknownPanel issueId={issueId} preview={data} onCleared={run} onLinked={onClose} />}
      {data && !unknown && !data.repo && <RepoSetup workspaceKey={workspaceKey} preview={data} onSaved={run} />}
      {data && !unknown && data.repo && <PublishForm key={data.issueId} issueId={issueId} preview={data} onDone={onClose} onStale={run} />}
      <div className={s.githubDialogActions}>
        <Button onClick={onClose}>閉じる</Button>
      </div>
    </dialog>
  );
}

function FindingList({ findings }: { findings: LeakFinding[] }) {
  if (!findings.length) return null;
  return (
    <div role="group" aria-label="nod の情報の検出結果" className={s.githubFindings}>
      <p className={s.githubFindingsHead}>nod の情報が {findings.length} 件見つかりました。書き換えるまで送れません</p>
      <ul>
        {findings.map((f) => (
          <li key={`${f.field}:${f.line}:${f.column}:${f.rule}`}>
            <span className={s.githubFindingAt}>{findingLocation(f)}</span> <code>{f.text}</code> — {f.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PublishForm({ issueId, preview, onDone, onStale }: { issueId: string; preview: GithubPublishPreview; onDone: () => void; onStale: () => void }) {
  const [title, setTitle] = useState(preview.title);
  const [body, setBody] = useState(preview.body);
  const [check, dispatch] = useReducer(checkReducer, preview.findings, initialCheck);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<GithubPublishResult | null>(null);
  const publish = usePublishGithub(issueId);
  const blocked = preview.blockers.length > 0 || preview.ghError !== null;
  // 編集のたびに、少し待ってから今の版を server で再検査する。古い版の結果は reducer が捨てる
  useEffect(() => {
    if (check.status !== "checking") return;
    const revision = check.revision;
    const timer = setTimeout(() => {
      checkGithubText(issueId, { title, body }).then(
        (r) => dispatch({ type: "result", revision, findings: r.findings }),
        (e) => dispatch({ type: "failed", revision, error: errorMessage(e) }),
      );
    }, CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [issueId, title, body, check.revision, check.status]);
  const sendable = !created && canSend(check, { sending: publish.isPending, repo: preview.repo, ghLogin: preview.ghLogin, blocked });
  async function send() {
    if (!sendable || !preview.repo || !preview.ghLogin) return;
    setError("");
    try {
      const result = await publish.mutateAsync({ title, body, repo: preview.repo, ghLogin: preview.ghLogin });
      // 宛先と違う repo に作られた・対応を記録できなかったなど、知らせることがあれば閉じずに出す
      if (result.message) setCreated(result);
      else onDone();
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        const findings = (e.details as { findings?: LeakFinding[] } | undefined)?.findings ?? [];
        dispatch({ type: "result", revision: check.revision, findings });
        return;
      }
      setError(errorMessage(e));
      // 結果不明（502）・送信中（409）などは下見を取り直し、復旧の操作や理由を出す
      if (e instanceof ApiError) onStale();
    }
  }
  if (created) {
    return (
      <div className={s.githubDialogBody} role="status">
        <p>
          <a href={created.url} target="_blank" rel="noreferrer" className={s.link}>{githubLinkLabel(created)}</a> を作成しました
        </p>
        <p className={s.githubDialogNote}>{created.message}</p>
      </div>
    );
  }
  return (
    <form className={s.githubDialogBody} onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <dl className={s.githubTarget}>
        <dt>宛先</dt><dd>{preview.repo}</dd>
        <dt>gh アカウント</dt><dd>{preview.ghLogin ?? `確かめられません（${preview.ghError?.message ?? ""}）`}</dd>
      </dl>
      {preview.blockers.map((b) => <p key={b.code} role="alert" className={s.error}>{b.message}</p>)}
      <label className={s.githubField}>
        <span>タイトル</span>
        <input value={title} onChange={(e) => { setTitle(e.target.value); dispatch({ type: "edited" }); }} />
      </label>
      <label className={s.githubField}>
        <span>本文</span>
        <textarea rows={12} value={body} onChange={(e) => { setBody(e.target.value); dispatch({ type: "edited" }); }} />
      </label>
      <p className={s.githubDialogNote}>ここで直した文面は送信にだけ使い、nod の本文は変えません</p>
      {check.status === "checking" && <p className={s.githubDialogNote}>確かめています…</p>}
      {check.status === "error" && <p role="alert" className={s.error}>確かめられませんでした：{check.error}</p>}
      <FindingList findings={check.findings} />
      {error && <p role="alert" className={s.error}>作成できませんでした：{error}</p>}
      <Button type="submit" variant="primary" disabled={!sendable}>{publish.isPending ? "作成しています…" : "GitHub に作成する"}</Button>
    </form>
  );
}

function RepoSetup({ workspaceKey, preview, onSaved }: { workspaceKey: string; preview: GithubPublishPreview; onSaved: () => void }) {
  const [repo, setRepo] = useState(preview.repoCandidate ?? "");
  const [error, setError] = useState("");
  const save = useSetWorkspaceGithubRepo(workspaceKey);
  async function submit() {
    setError("");
    try {
      await save.mutateAsync(repo);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <form className={s.githubDialogBody} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <p>この Workspace の公開先（GitHub の repo）が未設定です。{preview.repoCandidate ? `origin から推定した候補は ${preview.repoCandidate} です。` : ""}</p>
      <label className={s.githubField}>
        <span>公開先（owner/repo）</span>
        <input value={repo} placeholder="owner/repo" onChange={(e) => setRepo(e.target.value)} />
      </label>
      {error && <p role="alert" className={s.error}>{error}</p>}
      <Button type="submit" variant="primary" disabled={!repo.trim() || save.isPending}>この repo に設定</Button>
    </form>
  );
}

// 結果不明の作成の復旧。宛先は試行で固定した repo。作られていたら URL を紐付け、作られていなかったら解除して作り直す
function UnknownPanel({ issueId, preview, onCleared, onLinked }: { issueId: string; preview: GithubPublishPreview; onCleared: () => void; onLinked: () => void }) {
  const clear = useClearGithubUnknown(issueId);
  const link = useLinkGithub(issueId);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const pending = preview.state.pending;
  const busy = clear.isPending || link.isPending;
  async function cleared() {
    setError("");
    try {
      await clear.mutateAsync(undefined);
      onCleared();
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function linked() {
    setError("");
    try {
      await link.mutateAsync(url.trim());
      onLinked();
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <div className={s.githubDialogBody} role="group" aria-label="結果不明の作成">
      <p>前回の作成は、GitHub に作られたか分かりません。GitHub の <strong>{pending?.repo}</strong> の Issue を確かめてください。</p>
      <ul>
        <li>作られていた: その Issue の URL を入力して紐付けてください</li>
        <li>作られていなかった: 下のボタンで解除し、もう一度作成してください</li>
      </ul>
      <form className={s.githubLinkForm} onSubmit={(e) => { e.preventDefault(); void linked(); }}>
        <input aria-label="GitHub Issue の URL" placeholder={`https://github.com/${pending?.repo ?? "owner/repo"}/issues/12`} value={url} onChange={(e) => setUrl(e.target.value)} />
        <Button type="submit" size="sm" disabled={!url.trim() || busy}>紐付ける</Button>
      </form>
      {error && <p role="alert" className={s.error}>{error}</p>}
      <Button disabled={busy} onClick={() => void cleared()}>作られていなかったので解除する</Button>
    </div>
  );
}
