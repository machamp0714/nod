import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { IssueList } from "../components/issue-list/IssueList";
import { ISSUE_ROWS } from "../fixtures/issue-rows";
import { findView } from "../fixtures/views";
import { cleanIssueListSearch } from "../routes/search";
import { NotFoundMessage } from "./NotFoundPage";

const route = getRouteApi("/views/$viewId");

export function ViewPage() {
  const { viewId } = route.useParams();
  const search = route.useSearch();
  const navigate = useNavigate({ from: "/views/$viewId" });
  const view = findView(Number(viewId));
  if (!view) return <NotFoundMessage title="View が見つかりません" />;
  // A ではダミーの絞り込みとして workspace だけを見る。E で GET /api/issues の条件に置き換える。
  const rows = ISSUE_ROWS.filter((row) => !view.filter.workspace || view.filter.workspace.includes(row.issue.workspace));
  return (
    <IssueList
      crumb="Views"
      title={view.name}
      rows={rows}
      search={search}
      onSearchChange={(patch) => navigate({ search: (prev) => cleanIssueListSearch({ ...prev, ...patch }), replace: true })}
    />
  );
}
