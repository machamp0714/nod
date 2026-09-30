import { type KeyboardEvent, type MouseEvent, useEffect, useRef, useState } from "react";
import type { IssueAttachment } from "../../api/types";
import { attachmentDownloadPath, attachmentMeta, attachmentTitle, attachmentViewPath, formatBytes, mediaAttachments, mediaKind, videoBadge } from "../../lib/attachment";
import { Icon } from "../ui";
import s from "./attachment-media.module.css";

// nod.pen「Issue詳細｜添付メディア（#55）」のサムネイル。画像はその画像を、動画は再生アイコンと拡張子を出す。
// 画像を読み込めなければ、拡大表示の読み込み失敗と同じ image-off アイコンに置き換える
function Thumb({ attachment, onOpen, buttonRef }: { attachment: IssueAttachment; onOpen: () => void; buttonRef: (el: HTMLButtonElement | null) => void }) {
  const title = attachmentTitle(attachment);
  const video = mediaKind(attachment) === "video";
  const [broken, setBroken] = useState(false);
  return <li>
    <button ref={buttonRef} type="button" className={video ? `${s.thumb} ${s.thumbVideo}` : s.thumb} aria-label={`${title} を拡大表示`} title={title} onClick={onOpen}>
      {video
        ? <><Icon name="play" size={20} color="#fff" /><span className={s.badge}>{videoBadge(attachment)}</span></>
        : broken
          ? <span className={s.thumbFailed}><Icon name="image-off" size={20} color="var(--ink3)" /></span>
          : <img className={s.thumbImage} src={attachmentViewPath(attachment.id)} alt="" loading="lazy" onError={() => setBroken(true)} />}
    </button>
  </li>;
}

export function MediaGrid({ items, onOpen, buttonRefs }: {
  items: IssueAttachment[];
  onOpen: (index: number) => void;
  buttonRefs?: { current: (HTMLButtonElement | null)[] };
}) {
  return <ul className={s.grid} aria-label="添付メディア">
    {items.map((a, i) => <Thumb key={a.id} attachment={a} onOpen={() => onOpen(i)} buttonRef={el => { if (buttonRefs) buttonRefs.current[i] = el; }} />)}
  </ul>;
}

function DownloadLink({ attachment }: { attachment: IssueAttachment }) {
  return <a className={s.download} href={attachmentDownloadPath(attachment.id)} download={attachment.fileName ?? ""}>
    <Icon name="download" size={13} />ダウンロード
  </a>;
}

// nod.pen「添付｜拡大表示（#55）」。Esc・背景のクリックで閉じ、←→ で前後の添付に移る
export function MediaLightbox({ items, index, onIndex, onClose }: {
  items: IssueAttachment[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const attachment = items[index];
  const [failed, setFailed] = useState<number | null>(null);
  useEffect(() => {
    // 開発時の StrictMode は effect を2回呼ぶため、開いていなければ開く
    if (!ref.current?.open) ref.current?.showModal();
  }, []);
  if (!attachment) return null;
  const many = items.length > 1;
  const move = (step: number) => onIndex((index + step + items.length) % items.length);
  const title = attachmentTitle(attachment);
  const src = attachmentViewPath(attachment.id);
  function keyDown(event: KeyboardEvent) {
    if (!many || (event.target as HTMLElement).tagName === "VIDEO") return;
    if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); }
    if (event.key === "ArrowRight") { event.preventDefault(); move(1); }
  }
  // 画像・動画・ボタン以外（オーバーレイの余白）を押したら閉じる
  function clickBackdrop(event: MouseEvent) {
    if (event.target === event.currentTarget || (event.target as HTMLElement).dataset.backdrop === "true") onClose();
  }
  return <dialog ref={ref} className={s.lightbox} aria-label={title} onCancel={e => { e.preventDefault(); onClose(); }} onKeyDown={keyDown} onClick={clickBackdrop}>
    <div className={s.bar}>
      <div className={s.info}><span className={s.fileName}>{title}</span><span className={s.meta}>{attachmentMeta(attachment)}</span></div>
      <DownloadLink attachment={attachment} />
      <button type="button" className={s.close} aria-label="閉じる" onClick={onClose}><Icon name="x" size={20} /></button>
    </div>
    <div className={s.stage} data-backdrop="true">
      {many && <button type="button" className={s.nav} aria-label="前の添付" onClick={() => move(-1)}><Icon name="chevron-left" size={20} /></button>}
      <div className={s.media} data-backdrop="true">
        {failed === attachment.id
          ? <div className={s.failed} role="alert">
            <Icon name="image-off" size={36} />
            <p className={s.failedMessage}>プレビューを表示できません</p>
            <p className={s.failedFile}>{[attachment.fileName, attachment.size != null ? formatBytes(attachment.size) : null].filter(Boolean).join(" · ")}</p>
            <DownloadLink attachment={attachment} />
          </div>
          : mediaKind(attachment) === "video"
            ? <video key={attachment.id} className={s.content} src={src} controls preload="metadata" aria-label={title} onError={() => setFailed(attachment.id)} />
            : <img key={attachment.id} className={s.content} src={src} alt={title} onError={() => setFailed(attachment.id)} />}
      </div>
      {many && <button type="button" className={s.nav} aria-label="次の添付" onClick={() => move(1)}><Icon name="chevron-right" size={20} /></button>}
    </div>
    <div className={s.bottom} data-backdrop="true">{many && <span className={s.counter}>{index + 1} / {items.length}</span>}</div>
  </dialog>;
}

// サムネイルの並びと拡大表示。どのサムネイルを開いているかを持ち、閉じたら開いたサムネイルへフォーカスを戻す
export function MediaGallery({ items }: { items: IssueAttachment[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const opener = useRef<number | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const index = open != null && open < items.length ? open : null;
  function openAt(i: number) {
    opener.current = i;
    setOpen(i);
  }
  function close() {
    setOpen(null);
    const from = opener.current;
    opener.current = null;
    // dialog が外れてから戻す（外れる前に focus すると dialog の中へ戻される）
    if (from != null) requestAnimationFrame(() => buttons.current[from]?.focus());
  }
  return <>
    <MediaGrid items={items} onOpen={openAt} buttonRefs={buttons} />
    {index != null && <MediaLightbox items={items} index={index} onIndex={setOpen} onClose={close} />}
  </>;
}

// Issue 詳細の Attachments の中、一覧の上に置くメディアの並び。メディアがなければ出さない
export function AttachmentMediaBlock({ attachments }: { attachments: IssueAttachment[] }) {
  const items = mediaAttachments(attachments);
  if (items.length === 0) return null;
  return <div className={s.inline}><p className={s.label}>メディア</p><MediaGallery items={items} /></div>;
}

// nod.pen「Reviews｜添付メディア（#55）」。変更ファイルの直前に置き、同じ見出しの体裁で折りたためる
export function ReviewMediaSection({ attachments }: { attachments: IssueAttachment[] }) {
  const [open, setOpen] = useState(true);
  const items = mediaAttachments(attachments);
  if (items.length === 0) return null;
  return <section className={s.section} aria-label="添付メディア">
    <div className={s.head}>
      <button type="button" className={s.toggle} aria-expanded={open} aria-label={open ? "添付メディアを閉じる" : "添付メディアを開く"} onClick={() => setOpen(!open)}>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
      </button>
      <h2 className={s.title}>添付メディア</h2>
      <span className={s.count}>{items.length}</span>
    </div>
    {open && <MediaGallery items={items} />}
  </section>;
}
