import { getRouteApi } from "@tanstack/react-router";
import { findDocument } from "../fixtures/documents";
import { NotFoundMessage } from "./NotFoundPage";

const route = getRouteApi("/documents/$documentId");

export function DocumentPage() {
  const { documentId } = route.useParams();
  const doc = findDocument(Number(documentId));
  if (!doc) return <NotFoundMessage title="Document が見つかりません" />;
  return <h1>{doc.title}</h1>;
}
