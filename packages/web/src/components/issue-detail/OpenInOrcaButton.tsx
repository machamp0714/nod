import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../../api/errors";
import { useOpenInOrca } from "../../api/hooks/orca";
import { Icon } from "../ui";
import s from "./issue-detail.module.css";

// プロパティの実行場所の下の「Orca で開く」（#52、Pencil『Issue詳細｜Orcaで開く』）。
// 記録済みの worktree を Orca で前面に出すだけで、セッションは起動・再開しない。
// 開けなかったときは理由と、手で開くためのパス・cd コマンドのコピーをポップオーバーで出す
export function OpenInOrcaButton({ issueId }: { issueId: string }) {
  const open = useOpenInOrca(issueId);
  const [failure, setFailure] = useState<{ message: string; worktree: string | null; command: string | null } | null>(null);
  const [notice, setNotice] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!failure) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setFailure(null); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [failure]);

  async function run() {
    setFailure(null); setNotice("");
    try {
      const result = await open.mutateAsync();
      if (!result.opened) {
        const reason = result.failure?.message ?? "理由は分かりません";
        setFailure({ message: result.worktree ? `${reason}（${result.worktree}）` : reason, worktree: result.worktree, command: result.copyCommand });
      }
    } catch (e) {
      setFailure({ message: errorMessage(e), worktree: null, command: null });
    }
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setNotice("コピーしました"); }
    catch { setNotice("コピーできませんでした"); }
    setFailure(null);
  }

  return (
    <div className={s.orcaOpen} ref={root}>
      <button type="button" className={s.orcaOpenButton} disabled={open.isPending} aria-haspopup="dialog" aria-expanded={failure !== null} onClick={() => void run()}>
        <Icon name="terminal" size={13} />
        Orca で開く
      </button>
      {failure && (
        <div className={s.orcaPopover} role="dialog" aria-label="Orca で開けませんでした" onKeyDown={(e) => { if (e.key === "Escape") setFailure(null); }}>
          <p role="alert" className={s.menuError}><Icon name="circle-alert" size={14} />Orca で開けませんでした：{failure.message}</p>
          {failure.worktree && <>
            <hr className={s.menuSeparator} />
            <button type="button" onClick={() => void copy(failure.worktree ?? "")}><Icon name="copy" size={14} />パスをコピー</button>
            {failure.command && <button type="button" onClick={() => void copy(failure.command ?? "")}><Icon name="terminal" size={14} />cd コマンドをコピー</button>}
          </>}
        </div>
      )}
      {notice && <span role="status" className={s.copyNotice}>{notice}</span>}
    </div>
  );
}
