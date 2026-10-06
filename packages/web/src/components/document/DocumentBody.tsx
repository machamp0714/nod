import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiError, apiFetch } from "../../api/client";
import { errorMessage } from "../../api/errors";
import { useUpdateDocumentContent } from "../../api/hooks/document";
import { queryKeys } from "../../api/query-keys";
import type { DocumentDetail } from "../../api/types";
import { stripLeadingTitle } from "../../lib/document";
import { shouldStartEditing } from "../../lib/document-edit";
import s from "../../pages/document.module.css";
import { DocumentAssetContext, Markdown } from "../markdown/Markdown";
import { Button, Icon } from "../ui";

// 本文の表示と編集。クリックで textarea（ファイルの全文）に切り替え、blur と Cmd+S で保存、Esc で取り消す（NOD-3）
export function DocumentBody({ doc }: { doc: DocumentDetail }) {
  const queryClient = useQueryClient();
  const update = useUpdateDocumentContent(doc.id);
  // draft が null のときは表示中。base は編集を始めたときの本文と mtime（変更の有無と競合の検知に使う）
  const [draft, setDraft] = useState<string | null>(null);
  const [base, setBase] = useState<{ content: string; mtime: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelling = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const editing = draft !== null;
  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  function startEditing(content = doc.content ?? "") {
    if (doc.content === null || doc.mtime === null) return;
    setBase({ content: doc.content, mtime: doc.mtime });
    setDraft(content);
    setError(null);
  }

  function close() {
    setDraft(null);
    setBase(null);
    setError(null);
  }

  async function save() {
    if (draft === null || base === null || update.isPending) return;
    if (draft === base.content) return close();
    try {
      await update.mutateAsync({ content: draft, mtime: base.mtime });
      close();
    } catch (e) {
      const conflict = e instanceof ApiError && e.status === 409;
      setError(conflict ? "ファイルがほかで変更されています。読み直してください" : `保存できませんでした：${errorMessage(e)}`);
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
        onKeyDown={(e) => {
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
