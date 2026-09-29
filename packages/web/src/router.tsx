import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { AppLayout } from "./layout/AppLayout";
import { DocumentPage } from "./pages/DocumentPage";
import { InboxPage } from "./pages/InboxPage";
import { IssueDetailPage } from "./pages/IssueDetailPage";
import { IssuesPage } from "./pages/IssuesPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { ProjectDetailPage } from "./pages/ProjectDetailPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { ReviewsPage } from "./pages/ReviewsPage";
import { TriagePage } from "./pages/TriagePage";
import { ViewPage } from "./pages/ViewPage";
import { parseIssueListSearch, parseProjectsSearch, parseSelectedSearch } from "./routes/search";

import { parseInboxSearch } from "./routes/inbox-search";

const rootRoute = createRootRoute({ component: AppLayout, notFoundComponent: NotFoundPage });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/inbox" });
  },
});

const inboxRoute = createRoute({ getParentRoute: () => rootRoute, path: "/inbox", validateSearch: parseInboxSearch, component: InboxPage });
const reviewsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/reviews", validateSearch: parseSelectedSearch, component: ReviewsPage });
const triageRoute = createRoute({ getParentRoute: () => rootRoute, path: "/triage", validateSearch: parseSelectedSearch, component: TriagePage });
const issuesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/issues", validateSearch: parseIssueListSearch, component: IssuesPage });
const issueDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/issues/$issueId", component: IssueDetailPage });
const viewRoute = createRoute({ getParentRoute: () => rootRoute, path: "/views/$viewId", validateSearch: parseIssueListSearch, component: ViewPage });
const projectsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/projects", validateSearch: parseProjectsSearch, component: ProjectsPage });
const projectDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
  validateSearch: parseIssueListSearch,
  component: ProjectDetailPage,
});
const documentRoute = createRoute({ getParentRoute: () => rootRoute, path: "/documents/$documentId", component: DocumentPage });

const routeTree = rootRoute.addChildren([
  indexRoute,
  inboxRoute,
  reviewsRoute,
  triageRoute,
  issuesRoute,
  issueDetailRoute,
  viewRoute,
  projectsRoute,
  projectDetailRoute,
  documentRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
