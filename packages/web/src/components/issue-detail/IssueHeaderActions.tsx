import { useEffect, useRef, useState } from "react";
import { Link as LinkIcon, Ellipsis } from "lucide-react";
import s from "./issue-detail.module.css";

export function IssueHeaderActions({ issueId }: { issueId: string }) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  async function copy(text: string) {
    setNotice(""); setError("");
    try { await navigator.clipboard.writeText(text); setNotice("コピーしました"); }
    catch { setError("コピーできませんでした"); }
  }
  return <div className={s.headerActions} ref={root}>
    <button type="button" className={s.iconButton} aria-label="リンクをコピー" onClick={() => void copy(new URL(`/issues/${encodeURIComponent(issueId)}`, window.location.origin).href)}><LinkIcon size={16} aria-hidden="true" /></button>
    <button type="button" ref={trigger} className={s.iconButton} aria-label="Issueのメニュー" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><Ellipsis size={18} aria-hidden="true" /></button>
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
      <button ref={first} role="menuitem" onClick={() => { void copy(issueId); close(); }}>Issue IDをコピー</button>
      <button role="menuitem" onClick={() => { void copy(`nod issue show ${issueId}`); close(); }}>コマンドをコピー</button>
    </div>}
    {notice && <span role="status" className={s.copyNotice}>{notice}</span>}
    {error && <span role="alert" className={s.error}>{error}</span>}
  </div>;
}
