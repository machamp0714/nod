import { getRouteApi } from "@tanstack/react-router";
import { isNotFoundError } from "../api/errors";
import { useDocument } from "../api/hooks/document";
import { Markdown } from "../components/markdown/Markdown";
import { ErrorMessage, Icon, LoadingMessage, Pill } from "../components/ui";
import { KIND_LABELS, parseDocumentId, stripLeadingTitle } from "../lib/document";
import s from "./document.module.css";
import { NotFoundMessage } from "./NotFoundPage";

const route = getRouteApi("/documents/$documentId");

// spec：web が表示のたびにファイルを読む。見つからないときはタイトルと「ファイルが見つかりません」を表示する。
export function DocumentPage() {
  const { documentId } = route.useParams();
  const id = parseDocumentId(documentId);
  const query = useDocument(id);
  if (id === null) return <NotFoundMessage title="Document が見つかりません" />;
  if (query.isPending) return <LoadingMessage />;
  if (query.isError) {
    return isNotFoundError(query.error) ? <NotFoundMessage title="Document が見つかりません" /> : <ErrorMessage error={query.error} />;
  }
  const doc = query.data;
  return (
    <div className={s.page}>
      <header className={s.header}>
        <Pill tone="muted" icon="file-text">
          {KIND_LABELS[doc.kind]}
        </Pill>
        <h1 className={s.title}>{doc.title}</h1>
        <p className={s.path}>{doc.path}</p>
      </header>
      {doc.content === null ? (
        <div className={s.missing} role="status">
          <Icon name="circle-alert" />
          ファイルが見つかりません
        </div>
      ) : (
        <div className={s.body}>
          <Markdown>{stripLeadingTitle(doc.content, doc.title)}</Markdown>
        </div>
      )}
    </div>
  );
}
