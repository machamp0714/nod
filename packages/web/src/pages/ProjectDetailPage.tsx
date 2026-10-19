import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useRef } from "react";
import { errorMessage } from "../api/errors";
import { usePageDisplay } from "../api/hooks/page-displays";
import { useIssueRows } from "../api/hooks/issues";
import { useProject, useProjects } from "../api/hooks/projects";
import type { DocumentRef, Milestone, ProjectDetail, ProjectSummary } from "../api/types";
import { BlockedFilter } from "../components/issue-list/FilterBar";
import { IssueList } from "../components/issue-list/IssueList";
import { HealthPill } from "../components/projects/HealthPill";
import { MilestonesSection } from "../components/projects/MilestonesSection";
import { ProjectFlowPage, ProjectViewSwitch } from "../components/projects/ProjectFlow";
import { ProjectStatusControl } from "../components/projects/ProjectStatusControl";
import { ProjectUpdatesSection } from "../components/projects/ProjectUpdatesSection";
import { Icon, PageError, PageLoading, ProgressBar, type StatusTones } from "../components/ui";
import { withoutPageDisplay } from "../lib/page-display";
import { replacesIssueListHistory, cleanProjectIssuesSearch } from "../routes/search";
import { NotFoundMessage } from "./NotFoundPage";
import p from "./project-detail.module.css";

const route = getRouteApi("/projects/$projectId");

// design/nod.pen「Project詳細｜一覧（正本）」（DOM7I）：完了のチェックを ready 色にし、ほかの Status は既存の色のまま
const PROJECT_STATUS_TONES: StatusTones = { done: "ready" };

export function ProjectDetailPage() {
  const { projectId } = route.useParams();
  const url = route.useSearch();
  const navigate = useNavigate({ from: "/projects/$projectId" });
  const projects = useProjects();
  const found = projects.data?.some((project) => String(project.id) === projectId) ?? false;
  const detail = useProject(Number(projectId), found);
  // 一覧にない ID なら、useIssueRows は API を呼ばない
  // 保存した表示設定（#218）と URL を合わせた状態。blocked は保存しないので URL の値のまま
  const page = usePageDisplay({ key: `project:${projectId}`, sameValueColumn: "project" }, url);
  const search = page.search;
  // 一覧とフローの切り替えは URL（view=flow）だけに置き、ページの表示設定には保存しない
  const view = url.view === "flow" ? "flow" : "list";
  const rows = useIssueRows({ project: projectId, blocked: search.blocked }, view === "list");
  const switched = useRef(false);

  if (projects.error) return <PageError message={errorMessage(projects.error)} />;
  if (!projects.data) return <PageLoading />;
  if (!found) return <NotFoundMessage title="Project が見つかりません" />;
  if (detail.error) return <PageError message={errorMessage(detail.error)} />;
  if (!detail.data) return <PageLoading />;
  if (!page.ready) return <PageLoading />;
  const crumb = <Link to="/projects">Projects</Link>;
  const intro = <ProjectIntro project={detail.data} documents={detail.data.documents} milestones={detail.data.milestones} initiatives={detail.data.initiatives} />;
  // design/nod.pen「Project詳細｜一覧（正本）」（DOM7I）：進捗報告は Issue 一覧の後に置く
  const updates = <ProjectUpdatesSection key={`updates-${detail.data.id}`} projectId={detail.data.id} updates={detail.data.updates} />;
  // 切り替えは履歴に積み、戻る・進むで復元できるようにする。一覧の設定は URL にそのまま残す
  const viewSwitch = (
    <ProjectViewSwitch
      value={view}
      focusOnMount={switched}
      onChange={(next) => navigate({ search: (prev) => cleanProjectIssuesSearch({ ...prev, view: next === "flow" ? "flow" : undefined }) })}
    />
  );
  // design/nod.pen「Project詳細｜フロー」（R4bvo）：一覧の絞り込みを使わず、Project 全体の依存関係を示す
  if (view === "flow") {
    return <ProjectFlowPage crumb={crumb} title={detail.data.name} intro={intro} viewSwitch={viewSwitch} afterContent={updates} projectId={detail.data.id} />;
  }
  return (
    <IssueList
      crumb={crumb}
      title={detail.data.name}
      intro={intro}
      afterContent={updates}
      viewSwitch={viewSwitch}
      filterBar={<div role="group" aria-label="絞り込み条件">
        <BlockedFilter value={search.blocked} onChange={(blocked) => navigate({ search: (prev) => cleanProjectIssuesSearch({ ...prev, blocked }), replace: true })} />
      </div>}
      rows={rows.rows}
      loading={rows.loading}
      error={rows.error}
      search={search}
      sameValueColumn="project"
      onSearchChange={(patch) => {
        page.save(patch);
        navigate({ search: (prev) => cleanProjectIssuesSearch({ ...prev, ...patch }), replace: replacesIssueListHistory(patch) });
      }}
      onResetDisplay={() => {
        page.reset();
        navigate({ search: (prev) => withoutPageDisplay(prev), replace: true });
      }}
      resetDisplayDisabled={page.resetDisabled}
      statusTones={PROJECT_STATUS_TONES}
    />
  );
}

function ProjectIntro({
  project,
  documents,
  milestones,
  initiatives,
}: {
  project: ProjectSummary;
  documents: DocumentRef[];
  milestones: Milestone[];
  initiatives: ProjectDetail["initiatives"];
}) {
  return (
    <section className={p.intro} aria-label="Project の概要">
      <div className={p.meta}>
        <ProjectStatusControl key={project.id} project={project} />
        {initiatives.map((initiative) => (
          <Link
            key={initiative.id}
            to="/initiatives/$initiativeId"
            params={{ initiativeId: String(initiative.id) }}
            className={p.initiativeChip}
          >
            <Icon name="target" size={12} color="var(--ink3)" />
            <span className={p.chipKey}>Initiative</span>
            <span className={p.chipValue}>{initiative.name}</span>
          </Link>
        ))}
      </div>
      {project.description && <p className={p.description}>{project.description}</p>}
      <div className={p.progress}>
        <span className={p.health} aria-label="現在の健全性">
          <HealthPill health={project.health} />
        </span>
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
      <MilestonesSection key={`milestones-${project.id}`} projectId={project.id} milestones={milestones} />
    </section>
  );
}
