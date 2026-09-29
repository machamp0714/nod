import { recordedTimestamp } from "@nod/core/src/recorded-time";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
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

export function DocumentsSection({ documents, onAttach }: { documents: IssueDocumentRef[]; onAttach: (input: AttachDocumentInput) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<DocKind | "">("");
  const action = useAsyncAction();
  const reset = () => { setOpen(false); setPath(""); setTitle(""); setKind(""); action.clearError(); };
  async function attach() {
    if (await action.run(() => onAttach({ path: path.trim(), title: title.trim() || undefined, kind: kind || undefined }), "添付できませんでした")) reset();
  }
  return <section className={s.section} aria-label="Documents">
    <div className={s.documentsHeading}><h2 className={s.sectionTitle}>Documents</h2><span className={s.meta}>{documents.length}</span>
      <button type="button" className={s.iconButton} aria-label="Documentを追加" disabled={action.busy} onClick={() => setOpen(true)}><Icon name="plus" /></button></div>
    {documents.length === 0 ? <p className={s.muted}>Document はありません</p> : <ul className={s.documentCards}>
      {documents.map(doc => <li key={doc.id} className={s.documentCard}>
        <Link to="/documents/$documentId" params={{ documentId: String(doc.id) }} className={s.link}><Icon name="file-text" />{doc.title}</Link>
        <div className={s.documentMeta}><Pill tone={doc.kind === "plan" ? "ready" : doc.kind === "spec" ? "accent" : "muted"}>{KINDS[doc.kind]}</Pill>
          <span title={doc.attachedAt ?? undefined}>添付者: {doc.attachedBy ?? "記録なし"} · 添付日: {attachmentDate(doc.attachedAt)}</span>
        </div>
      </li>)}
    </ul>}
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
