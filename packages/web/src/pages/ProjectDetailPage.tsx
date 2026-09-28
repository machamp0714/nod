import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { errorMessage } from "../api/errors";
import { useIssueRows } from "../api/hooks/issues";
import { useProject, useProjects } from "../api/hooks/projects";
import type { DocumentRef, ProjectSummary } from "../api/types";
import { IssueList } from "../components/issue-list/IssueList";
import { Icon, PageError, PageLoading, ProgressBar } from "../components/ui";
import { cleanIssueListSearch } from "../routes/search";
import { NotFoundMessage } from "./NotFoundPage";
import p from "./project-detail.module.css";

const route = getRouteApi("/projects/$projectId");

export function ProjectDetailPage() {
  const { projectId } = route.useParams();
  const search = route.useSearch();
  const navigate = useNavigate({ from: "/projects/$projectId" });
  const projects = useProjects();
  const found = projects.data?.some((project) => String(project.id) === projectId) ?? false;
  const detail = useProject(Number(projectId), found);
  // 一覧にない ID なら、useIssueRows は API を呼ばない
  const rows = useIssueRows({ project: projectId });

  if (projects.error) return <PageError message={errorMessage(projects.error)} />;
  if (!projects.data) return <PageLoading />;
  if (!found) return <NotFoundMessage title="Project が見つかりません" />;
  if (detail.error) return <PageError message={errorMessage(detail.error)} />;
  if (!detail.data) return <PageLoading />;
  return (
    <IssueList
      crumb={<Link to="/projects">Projects</Link>}
      title={detail.data.name}
      intro={<ProjectIntro project={detail.data} documents={detail.data.documents} />}
      rows={rows.rows}
      loading={rows.loading}
      error={rows.error}
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
