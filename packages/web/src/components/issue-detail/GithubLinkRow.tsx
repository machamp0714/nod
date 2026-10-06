import { useState } from "react";
import { errorMessage } from "../../api/errors";
import { useGithubState, useLinkGithub, useUnlinkGithub } from "../../api/hooks/github";
import { GITHUB_LINK_ORIGIN_LABEL, githubLinkLabel } from "../../lib/github-publish";
import { Button } from "../ui";
import s from "./issue-detail.module.css";

// プロパティの「GitHub」行。対応があればリンクと経路、なければ紐付けの入力を出す。解除は確認してから行う。
// done・アーカイブ済みでも紐付け・解除できる（決定）ため、操作には unlocked を付けて淡くしない
export function GithubLinkRow({ issueId }: { issueId: string }) {
  const state = useGithubState(issueId);
  const link = useLinkGithub(issueId);
  const unlink = useUnlinkGithub(issueId);
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const current = state.data?.link ?? null;
  async function submitLink() {
    setError("");
    try {
      await link.mutateAsync(url.trim());
      setEditing(false);
      setUrl("");
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function submitUnlink() {
    setError("");
    try {
      await unlink.mutateAsync(undefined);
      setConfirming(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <div className={s.githubRow} role="group" aria-label="GitHub">
      {current ? (
        <span className={s.githubLinked}>
          <a href={current.url} target="_blank" rel="noreferrer" className={s.link}>{githubLinkLabel(current)}</a>
          <span className={s.propQuiet}>{GITHUB_LINK_ORIGIN_LABEL[current.origin]}</span>
          {!confirming && <Button size="sm" className={s.unlocked} onClick={() => setConfirming(true)}>解除</Button>}
          {confirming && (
            <span role="alertdialog" aria-label="紐付けを外す確認" className={s.githubConfirm}>
              {githubLinkLabel(current)} の紐付けを外しますか？外しても再公開はできません
              <Button size="sm" variant="danger" className={s.unlocked} disabled={unlink.isPending} onClick={() => void submitUnlink()}>外す</Button>
              <Button size="sm" className={s.unlocked} onClick={() => setConfirming(false)}>やめる</Button>
            </span>
          )}
        </span>
      ) : editing ? (
        <form className={s.githubLinkForm} onSubmit={(e) => { e.preventDefault(); void submitLink(); }}>
          <input className={s.unlocked} aria-label="GitHub Issue の URL" placeholder="https://github.com/owner/repo/issues/12" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Button type="submit" size="sm" className={s.unlocked} disabled={!url.trim() || link.isPending}>紐付ける</Button>
          <Button size="sm" className={s.unlocked} onClick={() => setEditing(false)}>やめる</Button>
        </form>
      ) : (
        <Button size="sm" className={s.unlocked} onClick={() => setEditing(true)}>紐付ける</Button>
      )}
      {state.error && <p role="alert" className={s.error}>{errorMessage(state.error)}</p>}
      {error && <p role="alert" className={s.error}>{error}</p>}
    </div>
  );
}
