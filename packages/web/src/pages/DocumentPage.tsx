import { getRouteApi } from "@tanstack/react-router";
import type { DocKind } from "../api/types";
import { Icon, Pill } from "../components/ui";
import { DOCUMENT_BODIES, findDocument } from "../fixtures/documents";
import s from "./document.module.css";
import { NotFoundMessage } from "./NotFoundPage";

const route = getRouteApi("/documents/$documentId");

const KIND_LABELS: Record<DocKind, string> = { spec: "Spec", plan: "Plan", doc: "Doc" };

// spec：web が表示のたびにファイルを読む。見つからないときはタイトルと「ファイルが見つかりません」を表示する。
// A は本文を Markdown の記法のまま出す。G で GET /api/documents/:id と Markdown の描画に置き換える。
export function DocumentPage() {
  const { documentId } = route.useParams();
  const id = Number(documentId);
  const doc = findDocument(id);
  if (!doc) return <NotFoundMessage title="Document が見つかりません" />;
  const body = DOCUMENT_BODIES[id] ?? null;
  return (
    <div className={s.page}>
      <header className={s.header}>
        <Pill tone="muted" icon="file-text">
          {KIND_LABELS[doc.kind]}
        </Pill>
        <h1 className={s.title}>{doc.title}</h1>
        <p className={s.path}>{doc.path}</p>
      </header>
      {body === null ? (
        <div className={s.missing} role="status">
          <Icon name="circle-alert" />
          ファイルが見つかりません
        </div>
      ) : (
        <div className={s.body}>{body}</div>
      )}
    </div>
  );
}
