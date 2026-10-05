import { useState } from "react";
import { errorMessage } from "../../api/errors";
import { useUpdateCycle } from "../../api/hooks/cycles";
import type { Cycle } from "../../api/types";
import { FormDialog } from "../planning/FormDialog";
import d from "../planning/planning.module.css";

// Pencil「Cycles｜周期の設定・編集・削除（NOD-2）」の (d)。変わった項目だけ送り、重なり・重複のエラーはダイアログ内に出す
export function EditCycleDialog({ cycle, onClose }: { cycle: Pick<Cycle, "id" | "name" | "startDate" | "endDate">; onClose: () => void }) {
  const update = useUpdateCycle(cycle.id);
  const [name, setName] = useState(cycle.name);
  const [startDate, setStartDate] = useState(cycle.startDate);
  const [endDate, setEndDate] = useState(cycle.endDate);
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog
      title="Cycle を編集"
      submitLabel="保存"
      busy={update.isPending}
      error={error}
      onClose={onClose}
      onSubmit={() => {
        if (!name.trim() || !startDate || !endDate) {
          setError("名前・開始日・終了日を入力してください");
          return;
        }
        const patch = {
          ...(name.trim() !== cycle.name ? { name: name.trim() } : {}),
          ...(startDate !== cycle.startDate ? { startDate } : {}),
          ...(endDate !== cycle.endDate ? { endDate } : {}),
        };
        if (Object.keys(patch).length === 0) {
          onClose();
          return;
        }
        setError(null);
        update.mutate(patch, { onSuccess: onClose, onError: (err) => setError(errorMessage(err)) });
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
      <span className={d.hint}>所属する Issue は変わりません</span>
    </FormDialog>
  );
}
