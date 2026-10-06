import { getRouteApi, Link } from "@tanstack/react-router";
import { useState } from "react";
import { errorMessage, isNotFoundError } from "../api/errors";
import { useDocument, useDocumentsRoot, useLinkDocument, useUnlinkDocument } from "../api/hooks/document";
import type { DocumentDetail } from "../api/types";
import { DocumentBody } from "../components/document/DocumentBody";
import { Button, ErrorMessage, Icon, LoadingMessage, PageHeader, Pill, StatusIcon, StatusLabel } from "../components/ui";
import { workspaceOfIssueId } from "../lib/workspace-labels";
import { displayPath, documentDate, KIND_LABELS, KIND_TONES, normalizeIssueRef, parseDocumentId } from "../lib/document";
import s from "./document.module.css";
import { NotFoundMessage } from "./NotFoundPage";

const route = getRouteApi("/documents/$documentId");

// nod.pen の「Document表示｜関連Issue」。リンクは Issue 詳細の Documents と同じ document_links を双方から操作する
function LinkedIssues({ doc }: { doc: DocumentDetail }) {
  const link = useLinkDocument(doc.id);
  const unlink = useUnlinkDocument(doc.id);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const busy = link.isPending || unlink.isPending;
  const close = () => {
    setAdding(false);
    setDraft("");
    setError("");
  };
  async function add() {
    const ref = normalizeIssueRef(draft);
    if (!ref) {
      setError("Issue ID の形で入力してください（例: API-12）");
      return;
    }
    try {
      await link.mutateAsync({ issueRef: ref });
      close();
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function remove(issueRef: string) {
    setError("");
    try {
      await unlink.mutateAsync({ issueRef });
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <section className={s.links} aria-label="関連 Issue">
      <div className={s.linksHead}>
        <h2 className={s.linksTitle}>関連 Issue</h2>
        <span className={s.count}>{doc.issues.length}</span>
      </div>
      {(doc.issues.length > 0 || adding) && (
        <ul className={s.linkList}>
          {doc.issues.map((issue) => (
            <li key={issue.id} className={s.linkRow}>
              <StatusIcon status={issue.status} />
              <span className={s.issueId}>{issue.id}</span>
              <Link to="/issues/$issueId" params={{ issueId: issue.id }} className={s.issueTitle}>
                {issue.title}
              </Link>
              {issue.archived && <Pill tone="muted">アーカイブ済み</Pill>}
              <span className={s.issueStatus}>
                <StatusLabel status={issue.status} workspace={workspaceOfIssueId(issue.id)} />
              </span>
              {/* アーカイブ済みの Issue とのリンクはサーバーが 409 で拒むため、先に止める */}
              <button
                type="button"
                className={s.iconButton}
                aria-label={`${issue.id} のリンクを解除`}
                title={issue.archived ? "アーカイブ済みの Issue からは解除できません" : undefined}
                disabled={busy || issue.archived}
                onClick={() => void remove(issue.id)}
              >
                <Icon name="x" size={14} />
              </button>
            </li>
          ))}
          {adding && (
            <li className={s.addRow}>
              <form
                className={s.addForm}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!busy) void add();
                }}
              >
                <Icon name="plus" size={14} />
                <input
                  className={s.addInput}
                  aria-label="リンクする Issue ID"
                  placeholder="Issue ID を入力（例: API-8）"
                  autoFocus
                  value={draft}
                  disabled={busy}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setError("");
                  }}
                  onKeyDown={(e) => e.key === "Escape" && close()}
                />
                <Button type="submit" variant="primary" disabled={busy || !draft.trim()}>
                  リンク
                </Button>
                <Button disabled={busy} onClick={close}>
                  キャンセル
                </Button>
              </form>
            </li>
          )}
        </ul>
      )}
      {error && (
        <p role="alert" className={s.error}>
          <Icon name="circle-alert" size={13} />
          {error}
        </p>
      )}
      {!adding && (
        <button type="button" className={s.addButton} disabled={busy} onClick={() => setAdding(true)}>
          <Icon name="plus" size={13} />
          Issue をリンク
        </button>
      )}
    </section>
  );
}

// spec：web が表示のたびにファイルを読む。見つからないときはタイトルと「ファイルが見つかりません」を表示する。
export function DocumentPage() {
  const { documentId } = route.useParams();
  const id = parseDocumentId(documentId);
  const query = useDocument(id);
  const root = useDocumentsRoot();
  if (id === null) return <NotFoundMessage title="Document が見つかりません" />;
  if (query.isPending) return <LoadingMessage />;
  if (query.isError) {
    return isNotFoundError(query.error) ? <NotFoundMessage title="Document が見つかりません" /> : <ErrorMessage error={query.error} />;
  }
  const doc = query.data;
  return (
    <div className={s.page}>
      <PageHeader as="nav" label="パンくず">
        <Link to="/documents" className={s.crumbLink}>
          Documents
        </Link>
        <Icon name="chevron-right" size={12} color="var(--ink3)" />
        <span className={s.path} title={doc.path}>
          {displayPath(doc.path, root.data?.docsDir)}
        </span>
      </PageHeader>
      <div className={s.content}>
        <header className={s.header}>
          <h1 className={s.title}>{doc.title}</h1>
          <div className={s.meta}>
            <Pill tone={KIND_TONES[doc.kind]}>{KIND_LABELS[doc.kind]}</Pill>
            <span title={doc.createdAt}>作成日: {documentDate(doc.createdAt)}</span>
          </div>
        </header>
        <LinkedIssues doc={doc} />
        <DocumentBody doc={doc} />
      </div>
    </div>
  );
}
