import { useEffect, useRef, useState } from "react";
import { CircleAlert, CopyPlus, Ellipsis, Hash, Link as LinkIcon, Terminal } from "lucide-react";
import { errorMessage } from "../../api/errors";
import s from "./issue-detail.module.css";

// onDuplicate は複製して新しい Issue へ移る。失敗したらメニューを開いたまま理由を出す（Pencil「Issue詳細｜複製メニュー」）
export function IssueHeaderActions({ issueId, onDuplicate }: { issueId: string; onDuplicate: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [duplicateError, setDuplicateError] = useState("");
  const [duplicating, setDuplicating] = useState(false);
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
  async function duplicate() {
    if (running.current) return;
    running.current = true;
    setDuplicateError(""); setDuplicating(true);
    try { await onDuplicate(); setOpen(false); }
    catch (e) { setDuplicateError(`複製できませんでした：${errorMessage(e)}`); }
    finally { running.current = false; setDuplicating(false); }
  }
  async function copy(text: string) {
    setNotice(""); setError("");
    try { await navigator.clipboard.writeText(text); setNotice("コピーしました"); }
    catch { setError("コピーできませんでした"); }
  }
  return <div className={s.headerActions} ref={root}>
    <button type="button" className={s.iconButton} aria-label="リンクをコピー" onClick={() => void copy(new URL(`/issues/${encodeURIComponent(issueId)}`, window.location.origin).href)}><LinkIcon size={16} aria-hidden="true" /></button>
    <button type="button" ref={trigger} className={s.iconButton} aria-label="Issueのメニュー" aria-haspopup="menu" aria-expanded={open} onClick={() => { setDuplicateError(""); setOpen(!open); }}><Ellipsis size={18} aria-hidden="true" /></button>
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
      <button role="menuitem" aria-disabled={duplicating} onClick={() => { if (!duplicating) void duplicate(); }}><CopyPlus size={14} aria-hidden="true" />Issueを複製</button>
      {duplicateError && <>
        <hr className={s.menuSeparator} />
        <p role="alert" className={s.menuError}><CircleAlert size={14} aria-hidden="true" />{duplicateError}</p>
      </>}
    </div>}
    {notice && <span role="status" className={s.copyNotice}>{notice}</span>}
    {error && <span role="alert" className={s.error}>{error}</span>}
    {/* 複製中にメニューが閉じられても、失敗はメニューの外で知らせる */}
    {duplicateError && !open && <span role="alert" className={s.error}>{duplicateError}</span>}
  </div>;
}
