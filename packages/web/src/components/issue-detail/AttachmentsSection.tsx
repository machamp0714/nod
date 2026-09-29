import { useState } from "react";
import type { IssueAttachment } from "../../api/types";
import { attachmentDownloadPath, attachmentMeta, attachmentTitle, safeLinkHref } from "../../lib/attachment";
import { Button, Icon } from "../ui";
import { useAsyncAction } from "./useAsyncAction";
import s from "./issue-detail.module.css";

const URL_ERROR = "http または https の URL を入力してください";

function AttachmentRow({ attachment, disabled, onRemove }: { attachment: IssueAttachment; disabled: boolean; onRemove: () => void }) {
  const title = attachmentTitle(attachment);
  const file = attachment.kind === "file";
  const href = file ? attachmentDownloadPath(attachment.id) : safeLinkHref(attachment.url);
  return <li className={s.attachmentRow}>
    <span className={s.attachmentIcon} aria-hidden="true"><Icon name={file ? "paperclip" : "link"} size={13} /></span>
    <div className={s.attachmentText}>
      {href
        ? <a className={file ? s.attachmentFileName : s.attachmentTitle} href={href}
          {...(file ? { download: attachment.fileName ?? "" } : { target: "_blank", rel: "noopener noreferrer" })}>{title}</a>
        : <span className={s.attachmentTitle}>{title}</span>}
      <span className={s.attachmentMeta}>{attachmentMeta(attachment)}</span>
    </div>
    <button type="button" className={s.attachmentRemove} aria-label={`${title} を削除`} disabled={disabled} onClick={onRemove}><Icon name="x" size={14} /></button>
  </li>;
}

// nod.pen の「Issue詳細｜添付」。web から足せるのはリンクだけで、ファイルは CLI で添付し、ここではダウンロードと削除をする。
// readOnly（アーカイブ済み）のときは追加も削除もできない
export function AttachmentsSection({ attachments, onAddLink, onRemove, readOnly = false }: {
  attachments: IssueAttachment[];
  readOnly?: boolean;
  onAddLink: (input: { url: string; title?: string }) => Promise<unknown>;
  onRemove: (attachmentId: number) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const action = useAsyncAction();
  const reset = () => { setOpen(false); setUrl(""); setTitle(""); setUrlError(null); action.clearError(); };
  async function add() {
    const trimmed = url.trim();
    if (!safeLinkHref(trimmed)) { setUrlError(URL_ERROR); return; }
    setUrlError(null);
    if (await action.run(() => onAddLink({ url: trimmed, title: title.trim() || undefined }), "リンクを追加できませんでした")) reset();
  }
  const remove = (a: IssueAttachment) => void action.run(() => onRemove(a.id), "添付を削除できませんでした");
  const error = urlError ?? action.error;
  return <section className={s.section} aria-label="Attachments">
    <div className={s.attachmentsHeading}><h2 className={s.sectionTitle}>Attachments</h2><span className={s.attachmentCount}>{attachments.length}</span>
      <button type="button" className={s.attachmentAdd} aria-label="リンクを追加" aria-expanded={open} disabled={action.busy || readOnly}
        onClick={() => (open ? reset() : setOpen(true))}><Icon name="plus" size={14} /></button></div>
    <div className={s.attachmentBox}>
      {attachments.length === 0 && !open && <p className={s.attachmentEmpty}>添付はありません</p>}
      {attachments.length > 0 && <ul className={s.attachmentList}>
        {attachments.map(a => <AttachmentRow key={a.id} attachment={a} disabled={action.busy || readOnly} onRemove={() => remove(a)} />)}
      </ul>}
      {open && <form className={s.attachmentForm} onSubmit={event => { event.preventDefault(); if (!action.busy && url.trim()) void add(); }}>
        <input className={s.attachmentInput} data-invalid={urlError ? "true" : undefined} aria-label="URL" aria-invalid={urlError ? true : undefined}
          autoFocus value={url} disabled={action.busy} placeholder="https://…" onChange={e => { setUrl(e.target.value); setUrlError(null); }} />
        {error && <p role="alert" className={s.attachmentError}><Icon name="circle-alert" size={13} />{error}</p>}
        <input className={s.attachmentInput} aria-label="タイトル（任意）" value={title} disabled={action.busy} placeholder="タイトル（任意）" onChange={e => setTitle(e.target.value)} />
        <div className={s.attachmentButtons}><Button disabled={action.busy} onClick={reset}>キャンセル</Button><Button type="submit" variant="primary" disabled={action.busy || !url.trim()}>追加</Button></div>
      </form>}
    </div>
    {!open && action.error && <p role="alert" className={s.error}>{action.error}</p>}
  </section>;
}
