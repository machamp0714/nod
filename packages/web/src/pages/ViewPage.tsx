import { getRouteApi } from "@tanstack/react-router";
import { findView } from "../fixtures/views";
import { NotFoundMessage } from "./NotFoundPage";

const route = getRouteApi("/views/$viewId");

export function ViewPage() {
  const { viewId } = route.useParams();
  const view = findView(Number(viewId));
  if (!view) return <NotFoundMessage title="View が見つかりません" />;
  return <h1>{view.name}</h1>;
}
