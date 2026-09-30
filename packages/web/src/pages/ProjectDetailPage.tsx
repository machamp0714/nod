import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { errorMessage } from "../api/errors";
import { useIssueRows } from "../api/hooks/issues";
import { useProject, useProjects } from "../api/hooks/projects";
import type { DocumentRef, ProjectSummary, ProjectUpdate } from "../api/types";
import { BlockedFilter } from "../components/issue-list/FilterBar";
import { IssueList } from "../components/issue-list/IssueList";
import { ProjectStatusControl } from "../components/projects/ProjectStatusControl";
import { ProjectUpdatesSection } from "../components/projects/ProjectUpdatesSection";
import { Icon, PageError, PageLoading, ProgressBar } from "../components/ui";
import { replacesIssueListHistory, cleanIssueListSearch } from "../routes/search";
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
  const rows = useIssueRows({ project: projectId, blocked: search.blocked });

  if (projects.error) return <PageError message={errorMessage(projects.error)} />;
  if (!projects.data) return <PageLoading />;
  if (!found) return <NotFoundMessage title="Project が見つかりません" />;
  if (detail.error) return <PageError message={errorMessage(detail.error)} />;
  if (!detail.data) return <PageLoading />;
  return (
    <IssueList
      crumb={<Link to="/projects">Projects</Link>}
      title={detail.data.name}
      intro={<ProjectIntro project={detail.data} documents={detail.data.documents} updates={detail.data.updates} />}
      filterBar={<div role="group" aria-label="絞り込み条件">
        <BlockedFilter value={search.blocked} onChange={(blocked) => navigate({ search: (prev) => cleanIssueListSearch({ ...prev, blocked }), replace: true })} />
      </div>}
      rows={rows.rows}
      loading={rows.loading}
      error={rows.error}
      search={search}
      onSearchChange={(patch) => navigate({ search: (prev) => cleanIssueListSearch({ ...prev, ...patch }), replace: replacesIssueListHistory(patch) })}
    />
  );
}

function ProjectIntro({ project, documents, updates }: { project: ProjectSummary; documents: DocumentRef[]; updates: ProjectUpdate[] }) {
  return (
    <section className={p.intro} aria-label="Project の概要">
      <ProjectStatusControl key={project.id} project={project} />
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
      <ProjectUpdatesSection key={`updates-${project.id}`} projectId={project.id} updates={updates} />
    </section>
  );
}
