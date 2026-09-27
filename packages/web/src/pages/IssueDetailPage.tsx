import { getRouteApi } from "@tanstack/react-router";
import { findIssue } from "../fixtures/issues";
import { NotFoundMessage } from "./NotFoundPage";

const route = getRouteApi("/issues/$issueId");

export function IssueDetailPage() {
  const { issueId } = route.useParams();
  const issue = findIssue(issueId);
  if (!issue) return <NotFoundMessage title="Issue が見つかりません" />;
  return <h1>{issue.title}</h1>;
}
