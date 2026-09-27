import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import type { DocumentRef, ProjectSummary } from "../api/types";
import { IssueList } from "../components/issue-list/IssueList";
import { Icon, ProgressBar } from "../components/ui";
import { findDocument, PROJECT_DOCUMENTS } from "../fixtures/documents";
import { ISSUE_ROWS } from "../fixtures/issue-rows";
import { findProject } from "../fixtures/project-summaries";
import { cleanIssueListSearch } from "../routes/search";
import { NotFoundMessage } from "./NotFoundPage";
import p from "./project-detail.module.css";

const route = getRouteApi("/projects/$projectId");

export function ProjectDetailPage() {
  const { projectId } = route.useParams();
  const search = route.useSearch();
  const navigate = useNavigate({ from: "/projects/$projectId" });
  const project = findProject(Number(projectId));
  if (!project) return <NotFoundMessage title="Project が見つかりません" />;
  const rows = ISSUE_ROWS.filter((row) => row.issue.project?.id === project.id);
  const documents = (PROJECT_DOCUMENTS[project.id] ?? [])
    .map((id) => findDocument(id))
    .filter((doc): doc is DocumentRef => doc !== undefined);
  return (
    <IssueList
      crumb={<Link to="/projects">Projects</Link>}
      title={project.name}
      intro={<ProjectIntro project={project} documents={documents} />}
      rows={rows}
      search={search}
      onSearchChange={(patch) => navigate({ search: (prev) => cleanIssueListSearch({ ...prev, ...patch }), replace: true })}
    />
  );
}

function ProjectIntro({ project, documents }: { project: ProjectSummary; documents: DocumentRef[] }) {
  return (
    <section className={p.intro} aria-label="Project の概要">
      {project.description && <p className={p.description}>{project.description}</p>}
      <div className={p.progress}>
        <ProgressBar value={project.done} max={project.total} />
        <span>
          {project.done}/{project.total} 完了
        </span>
      </div>
      <div>
        <h2 className={p.heading}>Documents</h2>
        {documents.length === 0 ? (
          <p className={p.muted}>Document はありません</p>
        ) : (
          <ul className={p.docs}>
            {documents.map((doc) => (
              <li key={doc.id}>
                <Link to="/documents/$documentId" params={{ documentId: String(doc.id) }} className={p.doc}>
                  <Icon name="file-text" />
                  {doc.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
