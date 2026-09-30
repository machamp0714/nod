import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { errorMessage } from "../api/errors";
import { useIssueList } from "../api/hooks/issues";
import { useProjects } from "../api/hooks/projects";
import { useWorkspaces } from "../api/hooks/shared";
import type { ProjectSummary } from "../api/types";
import type { ReactNode } from "react";
import { Button, Icon, PageError, PageHeader, PageTitle, ProgressBar, Segmented, Spacer, ViewBar, WorkspaceBadge } from "../components/ui";
import { formatRelative } from "../lib/format";
import { type Tone, TONE_COLORS } from "../lib/meta";
import { HealthPill } from "../components/projects/HealthPill";
import { filterProjects, type ProjectListItem, withWorkspaces } from "../lib/projects";
import { cleanProjectsSearch, type ProjectTab } from "../routes/search";
import s from "./projects.module.css";

const route = getRouteApi("/projects");

export function ProjectsPage() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: "/projects" });
  const tab = search.tab ?? "active";
  const projects = useProjects();
  const issues = useIssueList({});
  const workspaces = useWorkspaces();
  const error = projects.error ?? issues.error ?? workspaces.error;
  const items =
    projects.data && issues.data ? filterProjects(withWorkspaces(projects.data, issues.data.issues), tab) : undefined;
  const names = new Map((workspaces.data ?? []).map((w) => [w.key, w.name]));
  const workspaceName = (key: string) => names.get(key) ?? key;
  return (
    <div className={s.page}>
      <PageHeader>
        <PageTitle>Projects</PageTitle>
        <Spacer />
        <Button icon="plus" disabled title="準備中">
          New project
        </Button>
      </PageHeader>
      <ViewBar>
        <Segmented<ProjectTab>
          label="Project の絞り込み"
          value={tab}
          onChange={(value) => navigate({ search: cleanProjectsSearch({ tab: value }), replace: true })}
          items={[
            { value: "active", label: "Active" },
            { value: "completed", label: "Completed" },
            { value: "all", label: "All" },
          ]}
        />
      </ViewBar>
      {error ? (
        <PageError message={errorMessage(error)} />
      ) : (
        <table className={s.table}>
          <colgroup>
            <col />
            <col className={s.colWorkspace} />
            <col className={s.colProgress} />
            <col className={s.colHealth} />
            <col className={s.colAgents} />
            <col className={s.colUpdated} />
          </colgroup>
          <thead>
            <tr>
              <th>Name</th>
              <th>Workspace</th>
              <th>Progress</th>
              <th>健全性</th>
              <th>LLM の状況</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {items === undefined ? (
              <tr>
                <td colSpan={6} className={s.muted}>
                  <span role="status">読み込み中…</span>
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={6} className={s.muted}>
                  Project はありません
                </td>
              </tr>
            ) : (
              items.map((project) => <ProjectRow key={project.id} project={project} workspaceName={workspaceName} />)
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ProjectRow({ project, workspaceName }: { project: ProjectListItem; workspaceName: (key: string) => string }) {
  return (
    <tr>
      <td>
        <div className={s.name}>
          <span className={s.iconBox}>
            <Icon name="box" />
          </span>
          <span className={s.nameText}>
            <Link to="/projects/$projectId" params={{ projectId: String(project.id) }} className={s.nameLink}>
              {project.name}
            </Link>
            {project.description && <span className={s.desc}>{project.description}</span>}
          </span>
        </div>
      </td>
      <td>
        <div className={s.workspaces}>
          {project.workspaces.length === 0 ? (
            <span className={s.muted}>—</span>
          ) : (
            project.workspaces.map((key) => <WorkspaceBadge key={key} workspaceKey={key} name={workspaceName(key)} />)
          )}
        </div>
      </td>
      <td>
        <div className={s.progress}>
          <ProgressBar value={project.done} max={project.total} />
          <span>
            {project.done}/{project.total}
          </span>
        </div>
      </td>
      <td>
        <HealthPill health={project.health} />
      </td>
      <td>
        <AgentSummary agents={project.agents} />
      </td>
      <td className={s.muted}>{formatRelative(project.updatedAt)}</td>
    </tr>
  );
}

function ProjectAgentPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  const color = TONE_COLORS[tone];
  return (
    <span className={s.agentPill} style={{ color: color.fg, background: color.bg }}>
      <span className={s.agentDot} aria-hidden="true" />
      {children}
    </span>
  );
}

export function AgentSummary({ agents }: { agents: ProjectSummary["agents"] }) {
  const pills = [
    agents.awaitingInput > 0 && (
      <ProjectAgentPill key="awaiting" tone="ask">
        入力待ち {agents.awaitingInput}
      </ProjectAgentPill>
    ),
    agents.error > 0 && (
      <ProjectAgentPill key="error" tone="fail">
        エラー {agents.error}
      </ProjectAgentPill>
    ),
    agents.awaitingReview > 0 && (
      <ProjectAgentPill key="review" tone="ready">
        レビュー待ち {agents.awaitingReview}
      </ProjectAgentPill>
    ),
    agents.working > 0 && (
      <ProjectAgentPill key="working" tone="accent">
        作業中 {agents.working}
      </ProjectAgentPill>
    ),
  ].filter(Boolean);
  return <div className={s.agents}>{pills.length === 0 ? <span className={s.muted}>—</span> : pills}</div>;
}
