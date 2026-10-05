import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { errorMessage } from "../api/errors";
import { useCadence, useCreateCycle, useCycles } from "../api/hooks/cycles";
import type { CycleSummary } from "../api/types";
import { CadenceDialog } from "../components/cycles/CadenceDialog";
import { FormDialog } from "../components/planning/FormDialog";
import d from "../components/planning/planning.module.css";
import { Button, Icon, PageError, PageHeader, PageTitle, ProgressBar, Spacer } from "../components/ui";
import { CYCLE_STATE_LABEL, formatCadence, formatCyclePeriod } from "../lib/cycles";
import s from "./projects.module.css";

// Pencil「Cycles｜一覧（NOD-2）」。Cycle は全体で1つの系列なので、開始日の順に1つの表で並べる。見出しの下に周期の要約を出す
export function CyclesPage() {
  const cycles = useCycles();
  const cadence = useCadence();
  const [creating, setCreating] = useState(false);
  const [settingCadence, setSettingCadence] = useState(false);
  const error = cycles.error ?? cadence.error;
  const newButton = (
    <Button icon="plus" onClick={() => setCreating(true)}>
      New cycle
    </Button>
  );
  return (
    <div className={s.page}>
      <PageHeader>
        <PageTitle>Cycles</PageTitle>
        <Spacer />
        <Button icon="repeat" onClick={() => setSettingCadence(true)} disabled={!cycles.data || cadence.isPending}>
          周期の設定
        </Button>
        {newButton}
      </PageHeader>
      {cadence.isSuccess && (
        <p className={d.cadence}>
          <Icon name="repeat" size={13} />
          {formatCadence(cadence.data, cycles.data ?? [])}
        </p>
      )}
      {error ? (
        <PageError message={errorMessage(error)} />
      ) : !cycles.data ? (
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
          <tbody>
            {cycles.data.map((cycle) => (
              <CycleRow key={cycle.id} cycle={cycle} />
            ))}
          </tbody>
        </table>
      )}
      {creating && <NewCycleDialog onClose={() => setCreating(false)} />}
      {settingCadence && cycles.data && (
        <CadenceDialog cadence={cadence.data ?? null} hasCycles={cycles.data.length > 0} onClose={() => setSettingCadence(false)} />
      )}
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

function NewCycleDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateCycle();
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
          { name: name.trim(), startDate, endDate },
          { onSuccess: onClose, onError: (err) => setError(errorMessage(err)) },
        );
      }}
    >
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
