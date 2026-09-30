import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { errorMessage } from "../api/errors";
import { useCreateCycle, useCycles } from "../api/hooks/cycles";
import { useWorkspaces } from "../api/hooks/shared";
import type { CycleSummary } from "../api/types";
import { FormDialog } from "../components/planning/FormDialog";
import d from "../components/planning/planning.module.css";
import { Button, Icon, PageError, PageHeader, PageTitle, ProgressBar, Spacer, WorkspaceBadge } from "../components/ui";
import { CYCLE_STATE_LABEL, formatCyclePeriod } from "../lib/cycles";
import s from "./projects.module.css";

// Pencil「Cycles｜一覧（#82）」。Cycle は Workspace ごとなので、Workspace が2つ以上あれば Workspace の見出しでまとめる
export function CyclesPage() {
  const cycles = useCycles();
  const workspaces = useWorkspaces();
  const [creating, setCreating] = useState(false);
  const error = cycles.error ?? workspaces.error;
  const multi = (workspaces.data?.length ?? 0) > 1;
  const groups = (workspaces.data ?? [])
    .map((w) => ({ workspace: w, cycles: (cycles.data ?? []).filter((c) => c.workspace === w.key) }))
    .filter((g) => g.cycles.length > 0);
  const newButton = (
    <Button icon="plus" disabled={!workspaces.data?.length} onClick={() => setCreating(true)}>
      New cycle
    </Button>
  );
  return (
    <div className={s.page}>
      <PageHeader>
        <PageTitle>Cycles</PageTitle>
        <Spacer />
        {newButton}
      </PageHeader>
      {error ? (
        <PageError message={errorMessage(error)} />
      ) : !cycles.data || !workspaces.data ? (
        <p className={s.muted} style={{ padding: 24 }}>
          <span role="status">読み込み中…</span>
        </p>
      ) : cycles.data.length === 0 ? (
        <div className={d.empty}>
          <Icon name="calendar-range" size={22} color="var(--ink3)" />
          Cycle はまだありません
          {newButton}
        </div>
      ) : (
        <table className={s.table}>
          <colgroup>
            <col style={{ width: 240 }} />
            <col style={{ width: 200 }} />
            <col style={{ width: 130 }} />
            <col className={s.colProgress} />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th>名前</th>
              <th>期間</th>
              <th>状態</th>
              <th>進捗</th>
              <th>未完了</th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.workspace.key} aria-label={multi ? `Workspace ${g.workspace.name}` : undefined}>
              {multi && (
                <tr>
                  <th colSpan={5} scope="rowgroup">
                    <WorkspaceBadge workspaceKey={g.workspace.key} name={g.workspace.name} />
                  </th>
                </tr>
              )}
              {g.cycles.map((cycle) => (
                <CycleRow key={cycle.id} cycle={cycle} />
              ))}
            </tbody>
          ))}
        </table>
      )}
      {creating && workspaces.data && <NewCycleDialog workspaces={workspaces.data} onClose={() => setCreating(false)} />}
    </div>
  );
}

function CycleRow({ cycle }: { cycle: CycleSummary }) {
  return (
    <tr>
      <td>
        <div className={s.name}>
          <Icon name="calendar-range" color="var(--ink2)" />
          <Link to="/cycles/$cycleId" params={{ cycleId: String(cycle.id) }} className={s.nameLink}>
            {cycle.name}
          </Link>
        </div>
      </td>
      <td className={d.cell}>{formatCyclePeriod(cycle)}</td>
      <td>
        <CycleStateBadge state={cycle.state} />
      </td>
      <td>
        <div className={s.progress}>
          <ProgressBar value={cycle.done} max={cycle.total} />
          <span>
            {cycle.done}/{cycle.total}
          </span>
        </div>
      </td>
      <td className={d.open}>{cycle.open}</td>
    </tr>
  );
}

export function CycleStateBadge({ state }: { state: CycleSummary["state"] }) {
  return (
    <span className={d.badge} data-state={state}>
      {CYCLE_STATE_LABEL[state]}
    </span>
  );
}

function NewCycleDialog({ workspaces, onClose }: { workspaces: { key: string; name: string }[]; onClose: () => void }) {
  const create = useCreateCycle();
  const [workspace, setWorkspace] = useState(workspaces[0]?.key ?? "");
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog
      title="New cycle"
      submitLabel="作成"
      busy={create.isPending}
      error={error}
      onClose={onClose}
      onSubmit={() => {
        if (!name.trim() || !startDate || !endDate) {
          setError("名前・開始日・終了日を入力してください");
          return;
        }
        setError(null);
        create.mutate(
          { workspace, name: name.trim(), startDate, endDate },
          { onSuccess: onClose, onError: (err) => setError(errorMessage(err)) },
        );
      }}
    >
      {workspaces.length > 1 && (
        <label className={d.field}>
          Workspace
          <select className={d.input} value={workspace} onChange={(event) => setWorkspace(event.target.value)}>
            {workspaces.map((w) => (
              <option key={w.key} value={w.key}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className={d.field}>
        名前
        <input className={d.input} value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <div className={d.row}>
        <label className={d.field}>
          開始日
          <input type="date" className={d.input} value={startDate} onChange={(event) => setStartDate(event.target.value)} />
        </label>
        <label className={d.field}>
          終了日
          <input type="date" className={d.input} value={endDate} onChange={(event) => setEndDate(event.target.value)} />
        </label>
      </div>
    </FormDialog>
  );
}
