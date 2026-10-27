import { useState } from "react";
import type { Sprint } from "@nod/core";
import { errorMessage } from "../../api/errors";
import { useWorkspaces } from "../../api/hooks/shared";
import { useSprints } from "../../api/hooks/sprints";
import { useSprintCommand } from "../../api/hooks/sprint-planning";
import { FormDialog } from "../planning/FormDialog";
import s from "../planning/planning.module.css";

export function SprintCreateDialog({ onCreated, onClose }: { onCreated: (sprint: Sprint) => void; onClose: () => void }) {
  const workspaces = useWorkspaces();
  const sprints = useSprints();
  const [workspaceKey, setWorkspaceKey] = useState("");
  const [name, setName] = useState("");
  const [startDate, setStart] = useState("");
  const [endDate, setEnd] = useState("");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [replansSprintId, setReplans] = useState("");
  const [days, setDays] = useState([1, 2, 3, 4, 5]);
  const save = useSprintCommand<Sprint>();
  const selected = workspaces.data?.find(w => w.key === workspaceKey);
  return <FormDialog title="Sprintを作成" submitLabel={save.isPending ? "作成中…" : "作成"} busy={save.isPending} error={save.error ? `${errorMessage(save.error)}。入力は保持しています。作成から再試行できます。` : null} onClose={onClose} onSubmit={() => {
    void save.run("/sprints", { expectedVersion: 0, workspaceKey, startDate, endDate, timezone, workingDays: days, ...(name.trim() ? { name } : {}), ...(replansSprintId ? { replansSprintId } : {}) }).then(onCreated, () => {});
  }}>
    <p>作成前にWorkspace設定でSprint運用を有効にしてください。作成だけでは開始しません。</p>
    <label className={s.field}>Workspace<select aria-label="Workspace" required className={s.input} value={workspaceKey} onChange={e => { setWorkspaceKey(e.target.value); setReplans(""); }} disabled={save.isPending}><option value="">選択してください</option>{workspaces.data?.map(w => <option key={w.id} value={w.key}>{w.name}</option>)}</select></label>
    <label className={s.field}>名前（省略時は共通番号）<input className={s.input} value={name} onChange={e => setName(e.target.value)} disabled={save.isPending} /></label>
    <div className={s.row}>
      <label className={s.field}>開始日<input required type="date" className={s.input} value={startDate} onChange={e => setStart(e.target.value)} disabled={save.isPending} /></label>
      <label className={s.field}>終了日<input required type="date" className={s.input} value={endDate} onChange={e => setEnd(e.target.value)} disabled={save.isPending} /></label>
    </div>
    <label className={s.field}>タイムゾーン<input required className={s.input} value={timezone} onChange={e => setTimezone(e.target.value)} disabled={save.isPending} /></label>
    <fieldset disabled={save.isPending}><legend>稼働曜日</legend>{["日", "月", "火", "水", "木", "金", "土"].map((day, i) => <label key={i} style={{ marginRight: 8 }}><input type="checkbox" checked={days.includes(i)} onChange={e => setDays(e.target.checked ? [...days, i].sort() : days.filter(d => d !== i))} />{day}</label>)}</fieldset>
    <label className={s.field}>中止期間の再計画元<select className={s.input} value={replansSprintId} onChange={e => setReplans(e.target.value)} disabled={save.isPending}><option value="">なし</option>{sprints.data?.filter(sprint => sprint.phase === "canceled" && sprint.workspaceId === selected?.id).map(sprint => <option key={sprint.id} value={sprint.id}>{sprint.name}</option>)}</select></label>
  </FormDialog>;
}
