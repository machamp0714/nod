import { getRouteApi, Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { ApiError } from "../api/client";
import { errorMessage } from "../api/errors";
import { useAddInitiativeProject, useInitiative, useInitiatives, useRemoveInitiativeProject, useUpdateInitiative } from "../api/hooks/initiatives";
import { useIssueList } from "../api/hooks/issues";
import { useProjects } from "../api/hooks/projects";
import { useWorkspaces } from "../api/hooks/shared";
import type { InitiativeDetail, InitiativeStatus } from "../api/types";
import { FormDialog } from "../components/planning/FormDialog";
import d from "../components/planning/planning.module.css";
import { Button, Icon, PageError, PageHeader, PageLoading, ProgressBar, WorkspaceBadge } from "../components/ui";
import { INITIATIVE_STATUS_META, INITIATIVE_STATUSES } from "../lib/initiatives";
import { withWorkspaces } from "../lib/projects";
import { NotFoundMessage } from "./NotFoundPage";
import { AgentSummary } from "./ProjectsPage";
import s from "./initiative-detail.module.css";

const route = getRouteApi("/initiatives/$initiativeId");

// Pencil「Initiative詳細（#81）」。概要（状態・目標日・合算の進捗）と配下 Project の表
export function InitiativeDetailPage() {
  const { initiativeId } = route.useParams();
  const initiatives = useInitiatives();
  const found = initiatives.data?.some((i) => String(i.id) === initiativeId) ?? false;
  const detail = useInitiative(Number(initiativeId), found);
  if (initiatives.error) return <PageError message={errorMessage(initiatives.error)} />;
  if (!initiatives.data) return <PageLoading />;
  if (!found) return <NotFoundMessage title="Initiative が見つかりません" />;
  if (detail.error) return <PageError message={errorMessage(detail.error)} />;
  if (!detail.data) return <PageLoading />;
  return <InitiativeDetail initiative={detail.data} />;
}

function InitiativeDetail({ initiative }: { initiative: InitiativeDetail }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className={s.page}>
      <PageHeader>
        <Link to="/initiatives" className={s.crumb}>
          Initiatives
        </Link>
        <Icon name="chevron-right" size={12} color="var(--ink3)" />
        <span className={s.headerTitle}>{initiative.name}</span>
      </PageHeader>
      <div className={s.content}>
        <section className={s.overview} aria-label="Initiative の概要">
          {/* Pencil b8IOOd の見出し行（ps5GZ）。右端の「編集」で名前・説明を直す（#154） */}
          <div className={s.titleRow}>
            <h1 className={s.title}>{initiative.name}</h1>
            <Button icon="pencil" onClick={() => setEditing(true)}>
              編集
            </Button>
          </div>
          <Overview key={initiative.id} initiative={initiative} />
          {initiative.description && <p className={s.description}>{initiative.description}</p>}
        </section>
        <InitiativeProjects initiative={initiative} />
      </div>
      {editing && <EditInitiativeDialog initiative={initiative} onClose={() => setEditing(false)} />}
    </div>
  );
}

// Pencil「Initiative を編集」（YLl9f）。名前・説明だけを直す（状態・目標日は概要の Meta で変える）。
// 名前の空・重複は名前の欄の下に出し、それ以外の失敗はダイアログの下に出す
function EditInitiativeDialog({ initiative, onClose }: { initiative: InitiativeDetail; onClose: () => void }) {
  const update = useUpdateInitiative(initiative.id);
  const [name, setName] = useState(initiative.name);
  const [description, setDescription] = useState(initiative.description ?? "");
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nameErrorId = useId();
  return (
    <FormDialog
      title="Initiative を編集"
      submitLabel="保存"
      busy={update.isPending}
      error={error}
      onClose={onClose}
      onSubmit={() => {
        const trimmed = name.trim();
        setError(null);
        if (!trimmed) {
          setNameError("名前を入力してください");
          return;
        }
        setNameError(null);
        update.mutate(
          // 説明は字下げ・末尾の改行も本文なので trim せずに送る。空白だけなら説明なしにする
          { name: trimmed, description: description.trim() ? description : null },
          {
            onSuccess: onClose,
            onError: (err) => {
              if (err instanceof ApiError && err.code === "INITIATIVE_EXISTS") setNameError(`同じ名前の Initiative「${trimmed}」があります`);
              else setError(errorMessage(err));
            },
          },
        );
      }}
    >
      <label className={d.field}>
        名前
        <input
          className={`${d.input} ${nameError ? s.inputError : ""}`}
          value={name}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? nameErrorId : undefined}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {nameError && (
        <p id={nameErrorId} className={d.error}>
          <Icon name="circle-alert" size={13} />
          {nameError}
        </p>
      )}
      <label className={d.field}>
        説明
        <textarea className={`${d.input} ${s.textarea}`} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
    </FormDialog>
  );
}

function Overview({ initiative }: { initiative: InitiativeDetail }) {
  const statusId = useId();
  const dateId = useId();
  const update = useUpdateInitiative(initiative.id);
  const [targetDate, setTargetDate] = useState(initiative.targetDate ?? "");
  const saveDate = (value: string) => {
    if ((value || null) !== initiative.targetDate) update.mutate({ targetDate: value || null });
  };
  return (
    <div className={s.meta}>
      <span className={s.field}>
        <label htmlFor={statusId} className={s.label}>
          Status
        </label>
        <select
          id={statusId}
          className={s.control}
          value={initiative.status}
          disabled={update.isPending}
          onChange={(event) => {
            const status = event.target.value as InitiativeStatus;
            if (status !== initiative.status) update.mutate({ status });
          }}
        >
          {INITIATIVE_STATUSES.map((status) => (
            <option key={status} value={status}>
              {INITIATIVE_STATUS_META[status].label}
            </option>
          ))}
        </select>
      </span>
      <span className={s.field}>
        <label htmlFor={dateId} className={s.label}>
          目標日
        </label>
        <input
          id={dateId}
          type="date"
          className={s.control}
          value={targetDate}
          disabled={update.isPending}
          onChange={(event) => setTargetDate(event.target.value)}
          onBlur={(event) => saveDate(event.target.value)}
        />
      </span>
      <span className={s.progressText}>
        Issue {initiative.done}/{initiative.total} 完了
      </span>
      {update.isPending && <span role="status" className={s.muted}>保存中…</span>}
      {update.error && (
        <span role="alert" className={s.error}>
          {errorMessage(update.error)}
        </span>
      )}
    </div>
  );
}

function InitiativeProjects({ initiative }: { initiative: InitiativeDetail }) {
  const projects = useProjects();
  const issues = useIssueList({});
  const workspaces = useWorkspaces();
  const add = useAddInitiativeProject(initiative.id);
  const remove = useRemoveInitiativeProject(initiative.id);
  const linked = new Set(initiative.projects.map((p) => p.id));
  const candidates = (projects.data ?? []).filter((p) => !linked.has(p.id));
  const rows = withWorkspaces(initiative.projects, issues.data?.issues ?? []);
  const names = new Map((workspaces.data ?? []).map((w) => [w.key, w.name]));
  const error = add.error ?? remove.error;
  return (
    <section className={s.projects} aria-label="配下の Project">
      <div className={s.projectsHead}>
        <h2 className={s.sectionTitle}>Projects</h2>
        <span className={s.count}>{initiative.projects.length}</span>
        <span className={s.spacer} />
        <label className={s.addProject}>
          <Icon name="plus" size={13} color="var(--ink2)" />
          <select
            aria-label="Project を追加"
            value=""
            disabled={add.isPending || candidates.length === 0}
            onChange={(event) => {
              if (event.target.value) add.mutate({ project: event.target.value });
            }}
          >
            <option value="">Project を追加…</option>
            {candidates.map((p) => (
              <option key={p.id} value={String(p.id)}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <p role="alert" className={s.error}>
          {errorMessage(error)}
        </p>
      )}
      {rows.length === 0 ? (
        <p className={s.empty}>この Initiative に Project はありません。「Project を追加」から紐づけます</p>
      ) : (
        <ul className={s.table}>
          {rows.map((project) => (
            <li key={project.id} className={s.row}>
              <span className={s.name}>
                <Link to="/projects/$projectId" params={{ projectId: String(project.id) }} className={s.nameLink}>
                  {project.name}
                </Link>
                {project.description && <span className={s.desc}>{project.description}</span>}
              </span>
              <span className={s.workspace}>
                {project.workspaces.length === 0 ? (
                  <span className={s.muted}>—</span>
                ) : (
                  project.workspaces.map((key) => <WorkspaceBadge key={key} workspaceKey={key} name={names.get(key) ?? key} />)
                )}
              </span>
              <span className={s.progress}>
                <ProgressBar value={project.done} max={project.total} />
                <span>
                  {project.done}/{project.total}
                </span>
              </span>
              <span className={s.agents}>
                <AgentSummary agents={project.agents} />
              </span>
              <button
                type="button"
                className={s.remove}
                aria-label={`${project.name} の紐付けを外す`}
                disabled={remove.isPending}
                onClick={() => remove.mutate({ project: String(project.id) })}
              >
                <Icon name="x" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
