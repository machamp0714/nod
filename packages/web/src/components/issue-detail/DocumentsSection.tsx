import { recordedTimestamp } from "@nod/core/src/recorded-time";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { DocKind, IssueDocumentRef } from "../../api/types";
import { Button, Icon, Pill } from "../ui";
import { useAsyncAction } from "./useAsyncAction";
import s from "./issue-detail.module.css";

export interface AttachDocumentInput { path: string; title?: string; kind?: DocKind }
const KINDS: Record<DocKind, string> = { spec: "Spec", plan: "Plan", doc: "Doc" };
export function attachmentDate(iso: string | null): string {
  const value = recordedTimestamp(iso);
  const at = value === null ? null : new Date(value);
  return at && Number.isFinite(at.getTime()) ? at.toLocaleDateString("ja-JP", { month: "long", day: "numeric" }) : "記録なし";
}

// nod.pen の「Issue詳細｜Documents操作」。「+」は既存の添付か新規作成を選ぶメニュー、カードの × は添付の解除
function AddMenu({ disabled, onAttach, onCreate }: { disabled: boolean; onAttach: () => void; onCreate: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const choose = (fn: () => void) => { setOpen(false); fn(); };
  return <div className={s.addMenuWrap} ref={root}>
    <button ref={trigger} type="button" className={s.iconButton} aria-label="Documentを追加" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}><Icon name="plus" /></button>
    {open && <div role="menu" aria-label="Documentの追加" className={s.headerMenu} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
      if (event.key === "Tab") setOpen(false);
      if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }
    }}>
      <button ref={first} type="button" role="menuitem" className={s.menuItem} onClick={() => choose(onAttach)}><Icon name="paperclip" />既存を添付</button>
      <button type="button" role="menuitem" className={s.menuItem} onClick={() => choose(onCreate)}><Icon name="file-plus" />新規作成</button>
    </div>}
  </div>;
}

export function DocumentsSection({ issueId, documents, onAttach, onRemove }: {
  issueId: string;
  documents: IssueDocumentRef[];
  onAttach: (input: AttachDocumentInput) => Promise<unknown>;
  onRemove: (documentId: number) => Promise<unknown>;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<DocKind | "">("");
  const action = useAsyncAction();
  const reset = () => { setOpen(false); setPath(""); setTitle(""); setKind(""); action.clearError(); };
  async function attach() {
    if (await action.run(() => onAttach({ path: path.trim(), title: title.trim() || undefined, kind: kind || undefined }), "添付できませんでした")) reset();
  }
  const remove = (doc: IssueDocumentRef) => void action.run(() => onRemove(doc.id), "添付を解除できませんでした");
  return <section className={s.section} aria-label="Documents">
    <div className={s.documentsHeading}><h2 className={s.sectionTitle}>Documents</h2><span className={s.meta}>{documents.length}</span>
      <AddMenu disabled={action.busy} onAttach={() => setOpen(true)}
        onCreate={() => void navigate({ to: "/documents/new", search: { issue: issueId } })} /></div>
    {documents.length === 0 ? <p className={s.muted}>Document はありません</p> : <ul className={s.documentCards}>
      {documents.map(doc => <li key={doc.id} className={s.documentCard}>
        <div className={s.documentCardHead}>
          <Link to="/documents/$documentId" params={{ documentId: String(doc.id) }} className={s.link}><Icon name={doc.kind === "plan" ? "list-checks" : "file-text"} />{doc.title}</Link>
          <button type="button" className={s.iconButton} aria-label={`${doc.title} の添付を解除`} disabled={action.busy} onClick={() => remove(doc)}><Icon name="x" size={13} /></button>
        </div>
        <div className={s.documentMeta}><Pill tone={doc.kind === "plan" ? "ready" : doc.kind === "spec" ? "accent" : "muted"}>{KINDS[doc.kind]}</Pill>
          <span title={doc.attachedAt ?? undefined}>添付者: {doc.attachedBy ?? "記録なし"} · 添付日: {attachmentDate(doc.attachedAt)}</span>
        </div>
      </li>)}
    </ul>}
    {!open && action.error && <p role="alert" className={s.error}>{action.error}</p>}
    {open && <form className={s.documentForm} onSubmit={event => { event.preventDefault(); if (!action.busy && path.trim()) void attach(); }}>
      <label>Markdown絶対パス<input className={s.input} aria-label="Markdown絶対パス" autoFocus value={path} disabled={action.busy} onChange={e => setPath(e.target.value)} placeholder="/path/to/document.md" /></label>
      <label>タイトル（任意）<input className={s.input} aria-label="Documentのタイトル" value={title} disabled={action.busy} onChange={e => setTitle(e.target.value)} /></label>
      <label>種類（任意）<select className={s.select} aria-label="Documentの種類" value={kind} disabled={action.busy} onChange={e => setKind(e.target.value as DocKind | "")}>
        <option value="">指定しない</option>{Object.entries(KINDS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      {action.error && <p role="alert" className={s.error}>{action.error}</p>}
      <div className={s.commentActions}><Button type="submit" variant="primary" disabled={action.busy || !path.trim()}>追加</Button><Button disabled={action.busy} onClick={reset}>キャンセル</Button></div>
    </form>}
  </section>;
}
