import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { AppLayout } from "./layout/AppLayout";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { DocumentPage } from "./pages/DocumentPage";
import { DocumentsPage } from "./pages/DocumentsPage";
import { InboxPage } from "./pages/InboxPage";
import { IssueDetailPage } from "./pages/IssueDetailPage";
import { IssuesPage } from "./pages/IssuesPage";
import { MyIssuesPage } from "./pages/MyIssuesPage";
import { NewDocumentPage } from "./pages/NewDocumentPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { CycleDetailPage } from "./pages/CycleDetailPage";
import { CyclesPage } from "./pages/CyclesPage";
import { InitiativeDetailPage } from "./pages/InitiativeDetailPage";
import { InitiativesPage } from "./pages/InitiativesPage";
import { ProjectDetailPage } from "./pages/ProjectDetailPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { ReviewsPage } from "./pages/ReviewsPage";
import { TriagePage } from "./pages/TriagePage";
import { ViewPage } from "./pages/ViewPage";
import { WorkspaceSettingsPage } from "./pages/WorkspaceSettingsPage";
import {
  parseDocumentsSearch,
  parseIssueListSearch,
  parseNewDocumentSearch,
  parseProjectsSearch,
  parseSelectedSearch,
} from "./routes/search";

import { parseInboxSearch } from "./routes/inbox-search";
import { parseAnalyticsSearch } from "./lib/analytics";
import { parseSummarySearch } from "./lib/summary";
import { SummaryPage } from "./pages/SummaryPage";

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
const myIssuesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/my-issues", validateSearch: parseIssueListSearch, component: MyIssuesPage });
const issueDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/issues/$issueId", component: IssueDetailPage });
const viewRoute = createRoute({ getParentRoute: () => rootRoute, path: "/views/$viewId", validateSearch: parseIssueListSearch, component: ViewPage });
const projectsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/projects", validateSearch: parseProjectsSearch, component: ProjectsPage });
const projectDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
  validateSearch: parseIssueListSearch,
  component: ProjectDetailPage,
});
const initiativesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/initiatives", validateSearch: parseProjectsSearch, component: InitiativesPage });
const initiativeDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/initiatives/$initiativeId", component: InitiativeDetailPage });
const cyclesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/cycles", component: CyclesPage });
const cycleDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cycles/$cycleId",
  validateSearch: parseIssueListSearch,
  component: CycleDetailPage,
});
const documentsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/documents", validateSearch: parseDocumentsSearch, component: DocumentsPage });
const newDocumentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/documents/new",
  validateSearch: parseNewDocumentSearch,
  component: NewDocumentPage,
});
const analyticsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/analytics", validateSearch: parseAnalyticsSearch, component: AnalyticsPage });
const summaryRoute = createRoute({ getParentRoute: () => rootRoute, path: "/summary", validateSearch: parseSummarySearch, component: SummaryPage });
const documentRoute = createRoute({ getParentRoute: () => rootRoute, path: "/documents/$documentId", component: DocumentPage });

const workspaceSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces/$workspaceKey/settings",
  component: WorkspaceSettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  inboxRoute,
  reviewsRoute,
  triageRoute,
  issuesRoute,
  myIssuesRoute,
  issueDetailRoute,
  viewRoute,
  projectsRoute,
  projectDetailRoute,
  initiativesRoute,
  initiativeDetailRoute,
  cyclesRoute,
  cycleDetailRoute,
  documentsRoute,
  newDocumentRoute,
  documentRoute,
  workspaceSettingsRoute,
  analyticsRoute,
  summaryRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
