import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { type KeyboardEvent, useState } from "react";
import { ApiError } from "../api/client";
import { errorMessage } from "../api/errors";
import { useCreateDocument, useDocumentsRoot } from "../api/hooks/document";
import type { DocKind } from "../api/types";
import { Button, Icon } from "../components/ui";
import { KIND_LABELS, normalizeIssueRef } from "../lib/document";
import s from "./documents.module.css";

const route = getRouteApi("/documents/new");
const KINDS = Object.keys(KIND_LABELS) as DocKind[];

function FieldError({ id, message }: { id: string; message: string }) {
  return (
    <p id={id} role="alert" className={s.error}>
      <Icon name="circle-alert" size={13} />
      {message}
    </p>
  );
}

// nod.pen の「Documents｜新規作成」。本文の正本は作られる Markdown ファイルで、server は Documents ディレクトリの下にだけ作る
export function NewDocumentPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const root = useDocumentsRoot();
  const create = useCreateDocument();
  const fromIssue = search.issue ? normalizeIssueRef(search.issue) : null;
  const [path, setPath] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<DocKind>("doc");
  const [body, setBody] = useState("");
  const [issues, setIssues] = useState<string[]>(fromIssue ? [fromIssue] : []);
  const [draftIssue, setDraftIssue] = useState("");
  const [issueError, setIssueError] = useState("");
  const [error, setError] = useState<{ field: "path" | "issues"; message: string } | null>(null);
  const busy = create.isPending;

  // 入力中の Issue ID をチップにする。形が違えばその場で示す
  function commitIssue(): boolean {
    if (!draftIssue.trim()) return true;
    const ref = normalizeIssueRef(draftIssue);
    if (!ref) {
      setIssueError("Issue ID の形で入力してください（例: API-12）");
      return false;
    }
    setIssues((list) => (list.includes(ref) ? list : [...list, ref]));
    setDraftIssue("");
    setIssueError("");
    return true;
  }

  function onIssueKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commitIssue();
    } else if (event.key === "Backspace" && !draftIssue && issues.length) {
      setIssues((list) => list.slice(0, -1));
    }
  }

  function cancel() {
    if (fromIssue) void navigate({ to: "/issues/$issueId", params: { issueId: fromIssue } });
    else void navigate({ to: "/documents" });
  }

  async function submit() {
    if (busy || !path.trim() || !commitIssue()) return;
    setError(null);
    const pending = draftIssue.trim() ? normalizeIssueRef(draftIssue) : null;
    const issueRefs = pending && !issues.includes(pending) ? [...issues, pending] : issues;
    try {
      const doc = await create.mutateAsync({
        path: path.trim(),
        title: title.trim() || undefined,
        kind,
        body: body || undefined,
        issueRefs: issueRefs.length ? issueRefs : undefined,
      });
      void navigate({ to: "/documents/$documentId", params: { documentId: String(doc.id) } });
    } catch (e) {
      const field = e instanceof ApiError && e.code === "NOT_FOUND" ? "issues" : "path";
      const exists = e instanceof ApiError && e.code === "FILE_EXISTS";
      setError({ field, message: exists ? `既に同名のファイルがあります（${path.trim()}）` : errorMessage(e) });
    }
  }

  const docsDir = root.data?.docsDir;
  return (
    <div className={s.page}>
      <nav aria-label="パンくず" className={s.crumbs}>
        <Link to="/documents" className={s.crumbLink}>
          Documents
        </Link>
        <Icon name="chevron-right" size={12} />
        <h1 className={s.crumbCurrent}>新規ドキュメント</h1>
      </nav>
      <form
        className={s.form}
        aria-label="新規ドキュメント"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className={s.field}>
          <label className={s.labelRow} htmlFor="doc-path">
            相対パス
          </label>
          <div className={s.control} data-invalid={error?.field === "path"}>
            {docsDir && (
              <span className={s.prefix} title={docsDir}>
                {docsDir.endsWith("/") ? docsDir : `${docsDir}/`}
              </span>
            )}
            <input
              id="doc-path"
              className={`${s.bare} ${s.mono}`}
              value={path}
              autoFocus
              disabled={busy}
              placeholder="specs/search-api.md"
              aria-invalid={error?.field === "path"}
              aria-describedby={error?.field === "path" ? "doc-path-error" : undefined}
              onChange={(e) => setPath(e.target.value)}
            />
          </div>
          {error?.field === "path" && <FieldError id="doc-path-error" message={error.message} />}
        </div>
        <div className={s.field}>
          <label className={s.labelRow} htmlFor="doc-title">
            タイトル
          </label>
          <div className={s.control}>
            <input
              id="doc-title"
              className={s.bare}
              value={title}
              disabled={busy}
              placeholder="省略するとファイル名"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
        </div>
        <div className={s.field}>
          <label className={s.labelRow} htmlFor="doc-kind">
            種類
          </label>
          <select id="doc-kind" className={s.select} value={kind} disabled={busy} onChange={(e) => setKind(e.target.value as DocKind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <div className={s.field}>
          <label className={s.labelRow} htmlFor="doc-body">
            本文<span className={s.hint}>Markdown</span>
          </label>
          <textarea
            id="doc-body"
            className={s.textarea}
            value={body}
            disabled={busy}
            placeholder={"## 背景\n"}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
        <div className={s.field}>
          <label className={s.labelRow} htmlFor="doc-issues">
            リンク先 Issue<span className={s.hint}>任意</span>
          </label>
          <div className={`${s.control} ${s.chipInput}`} data-invalid={error?.field === "issues" || Boolean(issueError)}>
            {issues.map((id) => (
              <span key={id} className={s.chip}>
                {id}
                <button
                  type="button"
                  className={s.chipRemove}
                  aria-label={`${id} を外す`}
                  disabled={busy}
                  onClick={() => setIssues((list) => list.filter((x) => x !== id))}
                >
                  <Icon name="x" size={11} />
                </button>
              </span>
            ))}
            <input
              id="doc-issues"
              className={s.bare}
              value={draftIssue}
              disabled={busy}
              placeholder="Issue ID を入力…"
              onChange={(e) => {
                setDraftIssue(e.target.value);
                setIssueError("");
              }}
              onKeyDown={onIssueKey}
              onBlur={() => void commitIssue()}
            />
          </div>
          {issueError && <FieldError id="doc-issues-format" message={issueError} />}
          {error?.field === "issues" && <FieldError id="doc-issues-error" message={error.message} />}
        </div>
        <div className={s.footer}>
          <Button disabled={busy} onClick={cancel}>
            キャンセル
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !path.trim()}>
            作成
          </Button>
        </div>
      </form>
    </div>
  );
}
