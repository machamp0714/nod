import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { errorMessage } from "../api/errors";
import { useCreateInitiative, useInitiatives } from "../api/hooks/initiatives";
import type { InitiativeSummary } from "../api/types";
import { FormDialog } from "../components/planning/FormDialog";
import d from "../components/planning/planning.module.css";
import { Button, Icon, PageError, PageHeader, PageTitle, ProgressBar, Segmented, Spacer, ViewBar } from "../components/ui";
import { INITIATIVE_STATUS_META } from "../lib/initiatives";
import { filterProjects } from "../lib/projects";
import { cleanProjectsSearch, type ProjectTab } from "../routes/search";
import s from "./projects.module.css";

const route = getRouteApi("/initiatives");

// Pencil「Initiatives｜一覧（#81）」。タブは Projects と同じく Active（planned・started）、Completed、All
export function InitiativesPage() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: "/initiatives" });
  const tab = search.tab ?? "active";
  const initiatives = useInitiatives();
  const [creating, setCreating] = useState(false);
  const items = initiatives.data ? filterProjects(initiatives.data, tab) : undefined;
  return (
    <div className={s.page}>
      <PageHeader>
        <PageTitle>Initiatives</PageTitle>
        <Spacer />
        <Button icon="plus" onClick={() => setCreating(true)}>
          New initiative
        </Button>
      </PageHeader>
      <ViewBar>
        <Segmented<ProjectTab>
          label="Initiative の絞り込み"
          value={tab}
          onChange={(value) => navigate({ search: cleanProjectsSearch({ tab: value }), replace: true })}
          items={[
            { value: "active", label: "Active" },
            { value: "completed", label: "Completed" },
            { value: "all", label: "All" },
          ]}
        />
      </ViewBar>
      {initiatives.error ? (
        <PageError message={errorMessage(initiatives.error)} />
      ) : (
        <table className={s.table}>
          <colgroup>
            <col />
            <col style={{ width: 110 }} />
            <col className={s.colProgress} />
            <col style={{ width: 120 }} />
            <col style={{ width: 90 }} />
          </colgroup>
          <thead>
            <tr>
              <th>名前 / 説明</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Target date</th>
              <th>Projects</th>
            </tr>
          </thead>
          <tbody>
            {items === undefined ? (
              <tr>
                <td colSpan={5} className={s.muted}>
                  <span role="status">読み込み中…</span>
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={5} className={s.muted}>
                  Initiative はありません
                </td>
              </tr>
            ) : (
              items.map((initiative) => <InitiativeRow key={initiative.id} initiative={initiative} />)
            )}
          </tbody>
        </table>
      )}
      {creating && <NewInitiativeDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function InitiativeRow({ initiative }: { initiative: InitiativeSummary }) {
  const status = INITIATIVE_STATUS_META[initiative.status];
  return (
    <tr>
      <td>
        <div className={s.name}>
          <span className={s.iconBox}>
            <Icon name="target" />
          </span>
          <span className={s.nameText}>
            <Link to="/initiatives/$initiativeId" params={{ initiativeId: String(initiative.id) }} className={s.nameLink}>
              {initiative.name}
            </Link>
            {initiative.description && <span className={s.desc}>{initiative.description}</span>}
          </span>
        </div>
      </td>
      <td>
        <span className={d.status}>
          <Icon name={status.icon} color={status.color} />
          {status.label}
        </span>
      </td>
      <td>
        <div className={s.progress}>
          <ProgressBar value={initiative.done} max={initiative.total} />
          <span>
            {initiative.done}/{initiative.total}
          </span>
        </div>
      </td>
      <td className={d.cell}>{initiative.targetDate ?? "—"}</td>
      <td className={d.cell}>{initiative.projectCount}</td>
    </tr>
  );
}

// Pencil にない作成ダイアログは、PM の指示で New cycle ダイアログと同じ構成にする（名前・説明・目標日）
function NewInitiativeDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateInitiative();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog
      title="New initiative"
      submitLabel="作成"
      busy={create.isPending}
      error={error}
      onClose={onClose}
      onSubmit={() => {
        if (!name.trim()) {
          setError("名前を入力してください");
          return;
        }
        setError(null);
        create.mutate(
          { name: name.trim(), description: description.trim() || undefined, targetDate: targetDate || undefined },
          {
            onSuccess: (created) => {
              onClose();
              void navigate({ to: "/initiatives/$initiativeId", params: { initiativeId: String(created.id) } });
            },
            onError: (err) => setError(errorMessage(err)),
          },
        );
      }}
    >
      <label className={d.field}>
        名前
        <input className={d.input} value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className={d.field}>
        説明
        <input className={d.input} value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
      <label className={d.field}>
        目標日
        <input type="date" className={d.input} value={targetDate} onChange={(event) => setTargetDate(event.target.value)} />
      </label>
    </FormDialog>
  );
}
