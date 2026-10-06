import { useEffect, useId, useState } from "react";
import { errorMessage } from "../api/errors";
import { useClearWorkspaceGithubRepo, useSetWorkspaceGithubRepo, useWorkspaceGithubRepo } from "../api/hooks/github";
import type { Workspace } from "../api/types";
import { Icon } from "../components/ui";
import s from "./workspace-settings.module.css";

// nod issue publish・Issue 詳細の「GitHub に Issue を作成」で作る先。未設定なら origin から推定した候補を初期値にする
// （nod.pen に見本がなく、既存の節の書き方にならった）
export function GithubRepoSection({ workspace, onSaved }: { workspace: Workspace; onSaved: (message: string) => void }) {
  const titleId = useId();
  const current = useWorkspaceGithubRepo(workspace.key);
  const save = useSetWorkspaceGithubRepo(workspace.key);
  const clear = useClearWorkspaceGithubRepo(workspace.key);
  const [repo, setRepo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const saved = current.data?.repo ?? null;
  const candidate = current.data?.originCandidate ?? null;
  // 保存済みの値が変わったら（別の場所での更新を含む）それに合わせる
  useEffect(() => setRepo(saved ?? candidate ?? ""), [saved, candidate]);
  async function run(op: () => Promise<unknown>, message: string) {
    setError(null);
    try {
      await op();
      onSaved(message);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  const busy = save.isPending || clear.isPending;
  return (
    <section className={s.section} aria-labelledby={titleId}>
      <div className={s.sectionHeader}>
        <h2 id={titleId} className={s.sectionTitle}>GitHub の公開先</h2>
        <p className={s.description}>Issue を GitHub に作成するときの repo です。変えても、作成済みの対応は変わりません。</p>
      </div>
      <form className={s.labelInputs} onSubmit={(e) => { e.preventDefault(); void run(() => save.mutateAsync(repo), "保存しました"); }}>
        <input className={`${s.input} ${s.grow}`} aria-label="公開先（owner/repo）" placeholder="owner/repo" value={repo} onChange={(e) => setRepo(e.target.value)} />
        <button type="submit" className={`${s.smallButton} ${s.smallPrimary}`} disabled={!repo.trim() || busy}>保存</button>
        {saved && (
          <button type="button" className={`${s.smallButton} ${s.smallDanger}`} disabled={busy} onClick={() => void run(() => clear.mutateAsync(undefined), "解除しました")}>
            解除
          </button>
        )}
      </form>
      {!saved && candidate && <p className={s.description}>未設定です。origin から推定した候補: {candidate}</p>}
      {(current.error || error) && (
        <p role="alert" className={s.error}>
          <Icon name="circle-alert" size={13} />
          {error ?? errorMessage(current.error)}
        </p>
      )}
    </section>
  );
}
