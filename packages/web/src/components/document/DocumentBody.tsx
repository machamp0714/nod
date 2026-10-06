import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiError, apiFetch } from "../../api/client";
import { errorMessage } from "../../api/errors";
import { uploadDocumentAsset, useUpdateDocumentContent } from "../../api/hooks/document";
import { queryKeys } from "../../api/query-keys";
import type { DocumentDetail } from "../../api/types";
import { stripLeadingTitle } from "../../lib/document";
import { shouldStartEditing } from "../../lib/document-edit";
import { imageMarkdown, insertAt, replacePlaceholder, uploadPlaceholder } from "../../lib/document-paste";
import s from "../../pages/document.module.css";
import { DocumentAssetContext, Markdown } from "../markdown/Markdown";
import { Button, Icon } from "../ui";

// 貼り付け・ドロップされたもののうち画像だけ。画像とテキストの両方があれば画像だけを扱う
const imagesOf = (data: DataTransfer | null) => Array.from(data?.files ?? []).filter((f) => f.type.startsWith("image/"));
// dragover の時点では files が空なので、ファイルを運んでいるかを types で見る
const carriesFiles = (data: DataTransfer | null) => data?.types.includes("Files") ?? false;

// 本文の表示と編集。クリックで textarea（ファイルの全文）に切り替え、blur と Cmd+S で保存、Esc で取り消す（NOD-3）
export function DocumentBody({ doc }: { doc: DocumentDetail }) {
  const queryClient = useQueryClient();
  const update = useUpdateDocumentContent(doc.id);
  // draft が null のときは表示中。base は編集を始めたときの本文と mtime（変更の有無と競合の検知に使う）
  const [draft, setDraft] = useState<string | null>(null);
  const [base, setBase] = useState<{ content: string; mtime: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelling = useRef(false);
  // 送信中の印。isPending は描画の後にしか変わらないため、Cmd+S の連打や Cmd+S の直後の blur で二重に送らないよう ref で持つ
  const saving = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 進行中のアップロード（貼り付け・ドロップ1回ごと）の数。0 でない間は保存しない（仮の文字列をファイルに書かない）
  const uploads = useRef(0);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const editing = draft !== null;
  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  function startEditing(content = doc.content ?? "") {
    if (doc.content === null || doc.mtime === null) return;
    setBase({ content: doc.content, mtime: doc.mtime });
    setDraft(content);
    setError(null);
    setUploadError(null);
  }

  function close() {
    setDraft(null);
    setBase(null);
    setError(null);
    setUploadError(null);
  }

  async function save() {
    // アップロード中は blur でも Cmd+S でも送らない。終わった後の blur・Cmd+S で保存する
    if (draft === null || base === null || saving.current || uploads.current > 0) return;
    if (draft === base.content) return close();
    saving.current = true;
    try {
      await update.mutateAsync({ content: draft, mtime: base.mtime });
      close();
    } catch (e) {
      const conflict = e instanceof ApiError && e.status === 409;
      setError(conflict ? "ファイルがほかで変更されています。読み直してください" : `保存できませんでした：${errorMessage(e)}`);
    } finally {
      saving.current = false;
    }
  }

  function onBlur() {
    if (cancelling.current) {
      cancelling.current = false;
      return close();
    }
    // 失敗の後は blur で送り直さない（「読み直す」を押すときの blur で 409 を繰り返さない）。送り直すのは Cmd+S
    if (error) return;
    void save();
  }

  // 画像を順に1つずつ送り、仮の文字列を ![](images/x.png) に置き換える。失敗したら仮の文字列を消す
  async function uploadImages(files: File[], pasted: boolean, placeholders: string[]) {
    uploads.current += 1;
    try {
      for (const [i, file] of files.entries()) {
        const p = placeholders[i] as string;
        try {
          const { path } = await uploadDocumentAsset(doc.id, file, pasted);
          setDraft((d) => (d === null ? d : replacePlaceholder(d, p, imageMarkdown(path))));
        } catch (e) {
          setDraft((d) => (d === null ? d : replacePlaceholder(d, p, "")));
          setUploadError(`画像を保存できませんでした：${errorMessage(e)}`);
        }
      }
    } finally {
      uploads.current -= 1;
    }
  }

  // 編集中: カーソル位置に仮の文字列を入れる
  function insertImages(files: File[], pasted: boolean, at: number) {
    const placeholders = files.map(() => uploadPlaceholder());
    setDraft((d) => (d === null ? d : insertAt(d, at, placeholders.join("\n"))));
    setUploadError(null);
    void uploadImages(files, pasted, placeholders);
  }

  // 表示中: 編集に入り、本文の末尾に改行を1つ挟んで仮の文字列を足す。保存は通常どおり blur・Cmd+S
  function appendImages(files: File[], pasted: boolean) {
    if (doc.content === null || doc.mtime === null) return;
    const placeholders = files.map(() => uploadPlaceholder());
    const body = doc.content.endsWith("\n") ? doc.content : `${doc.content}\n`;
    startEditing(`${body}${placeholders.join("\n")}\n`);
    void uploadImages(files, pasted, placeholders);
  }

  // 表示中の貼り付けは、本文の div がフォーカスを持たないため document で受ける
  useEffect(() => {
    if (editing || doc.content === null) return;
    const onPaste = (e: ClipboardEvent) => {
      // ほかの入力（関連 Issue の入力欄など）への貼り付けは邪魔しない
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest("input, textarea, [contenteditable]:not([contenteditable='false'])")) return;
      const files = imagesOf(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      appendImages(files, true);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  });

  // ファイルを読み直し、下書きを最新の内容と mtime で置き換える（編集中の内容は破棄する）
  async function reload() {
    let d: DocumentDetail;
    try {
      d = await apiFetch<DocumentDetail>(`/documents/${doc.id}`);
    } catch (e) {
      setError(`読み直せませんでした：${errorMessage(e)}`);
      return;
    }
    queryClient.setQueryData(queryKeys.document(doc.id), d);
    if (d.content === null || d.mtime === null) return close();
    setBase({ content: d.content, mtime: d.mtime });
    setDraft(d.content);
    setError(null);
    textareaRef.current?.focus();
  }

  if (doc.content === null) {
    return (
      <div className={s.missing} role="status">
        <Icon name="circle-alert" />
        ファイルが見つかりません
      </div>
    );
  }
  if (draft === null) {
    return (
      // 本文のクリックで編集に入る（キーボードで入る手段は spec の範囲外）
      <div
        className={s.body}
        onClick={(e) => {
          if (shouldStartEditing(e.target as Element, window.getSelection())) startEditing();
        }}
        onDragOver={(e) => {
          if (carriesFiles(e.dataTransfer)) e.preventDefault();
        }}
        onDrop={(e) => {
          const files = imagesOf(e.dataTransfer);
          if (files.length === 0) return;
          e.preventDefault();
          appendImages(files, false);
        }}
      >
        <DocumentAssetContext.Provider value={doc.id}>
          <Markdown>{stripLeadingTitle(doc.content, doc.title)}</Markdown>
        </DocumentAssetContext.Provider>
      </div>
    );
  }
  return (
    <div className={s.body}>
      <textarea
        ref={textareaRef}
        className={s.editor}
        aria-label="本文"
        value={draft}
        readOnly={update.isPending}
        rows={Math.max(12, draft.split("\n").length + 1)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={onBlur}
        onPaste={(e) => {
          const files = imagesOf(e.clipboardData);
          if (files.length === 0) return; // 画像がなければ通常の貼り付け
          e.preventDefault(); // 画像とテキストが両方あれば画像だけを扱う
          insertImages(files, true, e.currentTarget.selectionStart);
        }}
        onDragOver={(e) => {
          if (carriesFiles(e.dataTransfer)) e.preventDefault();
        }}
        onDrop={(e) => {
          const files = imagesOf(e.dataTransfer);
          if (files.length === 0) return;
          e.preventDefault();
          insertImages(files, false, e.currentTarget.selectionStart);
        }}
        onKeyDown={(e) => {
          // 日本語の変換中の Esc（変換の取り消し）や Enter で下書きを捨てたり保存したりしない
          if (e.nativeEvent.isComposing) return;
          if (e.key.toLowerCase() === "s" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            setError(null);
            void save();
          } else if (e.key === "Escape") {
            cancelling.current = true;
            e.currentTarget.blur();
          }
        }}
      />
      {uploadError && (
        <div className={s.editError}>
          <p role="alert" className={s.error}>
            <Icon name="circle-alert" size={13} />
            {uploadError}
          </p>
        </div>
      )}
      {error && (
        <div className={s.editError}>
          <p role="alert" className={s.error}>
            <Icon name="circle-alert" size={13} />
            {error}
          </p>
          {/* 失敗（409 を含む）の後は下書きを残し、読み直す手段を出す。押すときの blur は error があるため送り直さない */}
          <Button title="編集中の内容は破棄されます" onClick={() => void reload()}>
            読み直す
          </Button>
        </div>
      )}
    </div>
  );
}
