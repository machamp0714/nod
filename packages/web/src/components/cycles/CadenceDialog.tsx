import { useId, useState } from "react";
import { errorMessage } from "../../api/errors";
import { useClearCadence, useSetCadence } from "../../api/hooks/cycles";
import type { CycleCadence } from "../../api/types";
import { localToday } from "../../lib/due-date";
import { DeleteDialog } from "../../pages/WorkspaceSettingsPage";
import { FormDialog } from "../planning/FormDialog";
import d from "../planning/planning.module.css";
import { Button } from "../ui";

const WEEKS = [1, 2, 3, 4] as const;

// Pencil「Cycles｜周期の設定・編集・削除（NOD-2）」の (a)〜(c)。最初の開始日は Cycle が1つもないときだけ出す。
// 設定済みなら「周期を外す」を出し、確認を挟んで外す
export function CadenceDialog({ cadence, hasCycles, onClose }: { cadence: CycleCadence | null; hasCycles: boolean; onClose: () => void }) {
  const save = useSetCadence();
  const clear = useClearCadence();
  const [weeks, setWeeks] = useState(cadence?.weeks ?? 2);
  const [autoCarryOver, setAutoCarryOver] = useState(cadence?.autoCarryOver ?? true);
  const [anchorDate, setAnchorDate] = useState(() => localToday());
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const weeksId = useId();
  const anchorId = useId();
  const [clearError, setClearError] = useState<string | null>(null);
  return (
    <>
      <FormDialog
        title="周期の設定"
        submitLabel="保存"
        busy={save.isPending}
        error={error}
        onClose={onClose}
        onSubmit={() => {
          if (!hasCycles && !anchorDate) {
            setError("最初の開始日を入力してください");
            return;
          }
          setError(null);
          save.mutate(
            { weeks, autoCarryOver, ...(hasCycles ? {} : { anchorDate }) },
            { onSuccess: onClose, onError: (err) => setError(errorMessage(err)) },
          );
        }}
        footerStart={
          cadence && (
            <Button variant="danger" className={d.plain} onClick={() => setClearing(true)}>
              周期を外す
            </Button>
          )
        }
      >
        {/* 補足を名前に含めないよう、label は見出しだけを包む */}
        <div className={d.field}>
          <label htmlFor={weeksId}>周期</label>
          <select id={weeksId} className={d.input} style={{ width: 160 }} value={weeks} onChange={(event) => setWeeks(Number(event.target.value))}>
            {WEEKS.map((w) => (
              <option key={w} value={String(w)}>
                {w}週間
              </option>
            ))}
          </select>
          <span className={d.hint}>
            {cadence
              ? "週数の変更は、次に作る Cycle から反映します。作成済みの Cycle は変わりません"
              : "今日を含む Cycle と次の1つを自動で作ります。名前は「Cycle N」の連番です"}
          </span>
        </div>
        {!hasCycles && (
          <div className={d.field}>
            <label htmlFor={anchorId}>最初の開始日</label>
            <input id={anchorId} type="date" className={d.input} style={{ width: 160 }} value={anchorDate} onChange={(event) => setAnchorDate(event.target.value)} />
            <span className={d.hint}>最初の Cycle はこの日に始まります。過去の日付なら、今日を含む区間から作ります</span>
          </div>
        )}
        <div className={d.switchRow}>
          <button
            type="button"
            role="switch"
            aria-checked={autoCarryOver}
            aria-label="自動持ち越し"
            className={d.switch}
            onClick={() => setAutoCarryOver(!autoCarryOver)}
          >
            <span className={d.knob} />
          </button>
          <span className={d.switchText}>
            未完了の Issue を次の Cycle へ自動で持ち越す
            <span className={d.hint}>終了した Cycle の done・canceled 以外の Issue を、今日の Cycle へ移します</span>
          </span>
        </div>
      </FormDialog>
      {clearing && (
        <DeleteDialog
          title="周期を外しますか？"
          message={
            clearError ?? "以後、Cycle は自動で作られず、未完了の自動持ち越しも止まります。作成済みの Cycle と Issue の所属はそのまま残ります。"
          }
          confirmLabel="外す"
          busy={clear.isPending}
          onClose={() => setClearing(false)}
          onConfirm={() =>
            clear.mutate(undefined, {
              onSuccess: onClose,
              onError: (err) => setClearError(`外せませんでした：${errorMessage(err)}`),
            })
          }
        />
      )}
    </>
  );
}
