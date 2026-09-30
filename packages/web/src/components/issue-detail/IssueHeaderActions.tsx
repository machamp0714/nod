import { useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, CircleAlert, CopyPlus, Ellipsis, Hash, Link as LinkIcon, Terminal, Trash2 } from "lucide-react";
import { errorMessage } from "../../api/errors";
import { DeleteIssueDialog } from "./DeleteIssueDialog";
import s from "./issue-detail.module.css";

// onDuplicate は複製して新しい Issue へ移る。onArchive はアーカイブ済みなら復元、そうでなければアーカイブする。
// 失敗したらメニューを開いたまま理由を出す（Pencil「Issue詳細｜複製メニュー」「Issue詳細｜アーカイブメニュー」）。
// アーカイブ済みなら「完全に削除」を出し、確認ダイアログで Issue ID を入力してから onDelete を呼ぶ（Pencil「アーカイブ済み｜完全に削除」）
export function IssueHeaderActions({ issueId, archived, onDuplicate, onArchive, onDelete }: {
  issueId: string;
  archived: boolean;
  onDuplicate: () => Promise<unknown>;
  onArchive: () => Promise<unknown>;
  onDelete: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [menuError, setMenuError] = useState("");
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const running = useRef(false); // 同じティックの2回目のクリックは state の反映前に届くため、ref で止める
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  // モーダルのダイアログが閉じてから（外の要素が操作できるようになってから）メニューのボタンへ戻す
  const wasDeleting = useRef(false);
  useEffect(() => {
    if (wasDeleting.current && !deleting) trigger.current?.focus();
    wasDeleting.current = deleting;
  }, [deleting]);
  async function run(operation: () => Promise<unknown>, failure: string) {
    if (running.current) return;
    running.current = true;
    setMenuError(""); setBusy(true);
    try { await operation(); setOpen(false); }
    catch (e) { setMenuError(`${failure}：${errorMessage(e)}`); }
    finally { running.current = false; setBusy(false); }
  }
  async function copy(text: string) {
    setNotice(""); setError("");
    try { await navigator.clipboard.writeText(text); setNotice("コピーしました"); }
    catch { setError("コピーできませんでした"); }
  }
  return <div className={s.headerActions} ref={root}>
    <button type="button" className={s.iconButton} aria-label="リンクをコピー" onClick={() => void copy(new URL(`/issues/${encodeURIComponent(issueId)}`, window.location.origin).href)}><LinkIcon size={16} aria-hidden="true" /></button>
    <button type="button" ref={trigger} className={s.iconButton} aria-label="Issueのメニュー" aria-haspopup="menu" aria-expanded={open} onClick={() => { setMenuError(""); setOpen(!open); }}><Ellipsis size={18} aria-hidden="true" /></button>
    {open && <div role="menu" aria-label="Issueの操作" className={s.headerMenu} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (event.key === "Tab") setOpen(false);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    }}>
      <button ref={first} role="menuitem" onClick={() => { void copy(issueId); close(); }}><Hash size={14} aria-hidden="true" />Issue IDをコピー</button>
      <button role="menuitem" onClick={() => { void copy(`nod issue show ${issueId}`); close(); }}><Terminal size={14} aria-hidden="true" />コマンドをコピー</button>
      <hr className={s.menuSeparator} />
      <button role="menuitem" aria-disabled={busy} onClick={() => void run(onDuplicate, "複製できませんでした")}><CopyPlus size={14} aria-hidden="true" />Issueを複製</button>
      <hr className={s.menuSeparator} />
      {archived
        ? <button role="menuitem" aria-disabled={busy} onClick={() => void run(onArchive, "復元できませんでした")}><ArchiveRestore size={14} aria-hidden="true" />復元</button>
        : <button role="menuitem" aria-disabled={busy} onClick={() => void run(onArchive, "アーカイブできませんでした")}><Archive size={14} aria-hidden="true" />アーカイブ</button>}
      {archived && <>
        <hr className={s.menuSeparator} />
        <button role="menuitem" className={s.menuDanger} aria-disabled={busy} onClick={() => { if (!busy) { setOpen(false); setDeleting(true); } }}><Trash2 size={14} aria-hidden="true" />完全に削除</button>
      </>}
      {menuError && <>
        <hr className={s.menuSeparator} />
        <p role="alert" className={s.menuError}><CircleAlert size={14} aria-hidden="true" />{menuError}</p>
      </>}
    </div>}
    {notice && <span role="status" className={s.copyNotice}>{notice}</span>}
    {error && <span role="alert" className={s.error}>{error}</span>}
    {/* 実行中にメニューが閉じられても、失敗はメニューの外で知らせる */}
    {menuError && !open && <span role="alert" className={s.error}>{menuError}</span>}
    {deleting && <DeleteIssueDialog issueId={issueId} onConfirm={onDelete} onClose={() => setDeleting(false)} />}
  </div>;
}
