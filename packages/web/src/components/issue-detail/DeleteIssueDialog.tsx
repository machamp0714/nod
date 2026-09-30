import { useEffect, useId, useRef, useState } from "react";
import { errorMessage } from "../../api/errors";
import s from "./issue-detail.module.css";

// Pencil「アーカイブ済み｜完全に削除（#30）」の確認ダイアログ。Issue ID を入力するまで「削除する」を押せない。
// 失敗したらダイアログを開いたまま理由を出す
export function DeleteIssueDialog({ issueId, onConfirm, onClose }: {
  issueId: string;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const messageId = useId();
  const inputId = useId();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  useEffect(() => {
    // 開発時の StrictMode は effect を2回呼ぶため、開いていなければ開く
    if (!ref.current?.open) ref.current?.showModal();
  }, []);
  const matches = typed.trim().toUpperCase() === issueId.toUpperCase();
  async function confirm() {
    if (!matches || running.current) return;
    running.current = true;
    setBusy(true); setError("");
    try { await onConfirm(); }
    catch (e) { setError(`削除できませんでした：${errorMessage(e)}`); }
    finally { running.current = false; setBusy(false); }
  }
  return (
    <dialog
      ref={ref}
      role="alertdialog"
      className={s.deleteDialog}
      aria-labelledby={titleId}
      aria-describedby={messageId}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
    >
      <form className={s.deleteDialogBody} onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
        <div className={s.deleteDialogText}>
          <h2 id={titleId} className={s.deleteDialogTitle}>{issueId} を完全に削除しますか？</h2>
          <p id={messageId} className={s.deleteDialogMessage}>コメント・添付・履歴も消え、元に戻せません。子Issueは残り、親が外れます</p>
          <div className={s.deleteConfirmField}>
            <label htmlFor={inputId} className={s.deleteConfirmLabel}>確認のため Issue ID を入力</label>
            <input id={inputId} className={s.deleteConfirmInput} value={typed} placeholder={issueId} autoComplete="off" spellCheck={false}
              autoFocus onChange={(event) => setTyped(event.target.value)} />
          </div>
          {error && <p role="alert" className={s.deleteDialogError}>{error}</p>}
        </div>
        <div className={s.deleteDialogButtons}>
          <button type="button" className={s.deleteCancel} disabled={busy} onClick={onClose}>キャンセル</button>
          <button type="submit" className={s.deleteConfirm} disabled={!matches || busy}>削除する</button>
        </div>
      </form>
    </dialog>
  );
}
