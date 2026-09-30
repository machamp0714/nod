import { useId, useState } from "react";
import { type MilestoneInput, useCreateMilestone, useDeleteMilestone, useUpdateMilestone } from "../../api/hooks/projects";
import type { Milestone } from "../../api/types";
import { hasText } from "../../lib/issue-edit";
import { DeleteDialog } from "../../pages/WorkspaceSettingsPage";
import { useAsyncAction } from "../issue-detail/useAsyncAction";
import { Button, Icon } from "../ui";
import s from "./milestones.module.css";

// Pencil「Project詳細｜健全性・Milestone」の Milestones（jz3TP）と状態（yo7H6）。
// 進捗は Project と同じ定義（canceled とアーカイブ済みを除く総数、done の数）
export function MilestonesSection({ projectId, milestones }: { projectId: number; milestones: Milestone[] }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<Milestone | null>(null);
  const create = useCreateMilestone(projectId);
  const update = useUpdateMilestone();
  const remove = useDeleteMilestone();
  const deleteAction = useAsyncAction();

  return (
    <section className={s.section} aria-label="Milestones">
      <div className={s.head}>
        <h2 className={s.heading}>Milestones</h2>
        <span className={s.count}>{milestones.length}</span>
        <button type="button" className={s.add} aria-label="Milestone を追加" disabled={adding} onClick={() => setAdding(true)}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      {milestones.length === 0 && !adding ? (
        <p className={s.empty}>Milestone はありません</p>
      ) : (
        milestones.length > 0 && (
          <ul className={s.list}>
            {milestones.map((m) =>
              editing === m.id ? (
                <li key={m.id} className={s.editing}>
                  <MilestoneForm
                    label={`Milestone「${m.name}」の編集`}
                    initial={m}
                    onCancel={() => setEditing(null)}
                    onSave={(input) => update.mutateAsync({ id: m.id, ...input })}
                    onSaved={() => setEditing(null)}
                  />
                </li>
              ) : (
                <li key={m.id} className={s.row} aria-label={`Milestone ${m.name}`}>
                  <span className={s.name}>
                    <Icon name="flag" size={13} />
                    <span className={s.nameText}>{m.name}</span>
                  </span>
                  <span className={s.date}>{m.targetDate ?? "—"}</span>
                  <span className={s.progress}>
                    <span
                      className={s.bar}
                      role="progressbar"
                      aria-label={`${m.name} の進捗`}
                      aria-valuemin={0}
                      aria-valuemax={m.total}
                      aria-valuenow={m.done}
                    >
                      <span className={s.fill} style={{ width: `${m.total ? (m.done / m.total) * 100 : 0}%` }} />
                    </span>
                    <span className={s.ratio}>
                      {m.done}/{m.total}
                    </span>
                  </span>
                  <span className={s.description}>{m.description}</span>
                  <span className={s.buttons}>
                    <Button size="sm" aria-label={`${m.name} を編集`} onClick={() => setEditing(m.id)}>
                      編集
                    </Button>
                    <Button size="sm" variant="danger" aria-label={`${m.name} を削除`} onClick={() => setDeleting(m)}>
                      削除
                    </Button>
                  </span>
                </li>
              ),
            )}
          </ul>
        )
      )}
      {adding && (
        <MilestoneForm
          label="Milestone の追加"
          onCancel={() => setAdding(false)}
          onSave={(input) => create.mutateAsync(input)}
          onSaved={() => setAdding(false)}
        />
      )}
      {deleting && (
        <DeleteDialog
          title={`Milestone「${deleting.name}」を削除しますか？`}
          message={deleteAction.error ?? "Issue の Milestone は外れます。Issue 自体は残ります。"}
          busy={deleteAction.busy}
          onClose={() => setDeleting(null)}
          onConfirm={() =>
            void deleteAction.run(() => remove.mutateAsync(deleting.id), "削除できませんでした").then((ok) => ok && setDeleting(null))
          }
        />
      )}
    </section>
  );
}

// 追加と編集のフォーム（jhLDq・IeMiM・o8l41）。失敗したら入力を残して理由を出す
function MilestoneForm({
  label,
  initial,
  onSave,
  onSaved,
  onCancel,
}: {
  label: string;
  initial?: Milestone;
  onSave: (input: MilestoneInput) => Promise<unknown>;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [targetDate, setTargetDate] = useState(initial?.targetDate ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const action = useAsyncAction();
  const id = useId();

  async function submit() {
    const input = { name, targetDate: targetDate || null, description: description || null };
    if (await action.run(() => onSave(input), "保存できませんでした")) onSaved();
  }

  return (
    <form
      className={s.form}
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        if (!action.busy && hasText(name)) void submit();
      }}
    >
      <label className={s.field} htmlFor={`${id}-name`}>
        <span className={s.label}>名前</span>
        <input
          id={`${id}-name`}
          className={`${s.input} ${action.error ? s.inputError : ""}`}
          value={name}
          disabled={action.busy}
          aria-invalid={action.error ? true : undefined}
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className={s.field} htmlFor={`${id}-date`}>
        <span className={s.label}>目標日</span>
        <input
          id={`${id}-date`}
          type="date"
          className={`${s.input} ${s.date}`}
          value={targetDate}
          disabled={action.busy}
          onChange={(event) => setTargetDate(event.target.value)}
        />
      </label>
      <label className={s.field} htmlFor={`${id}-description`}>
        <span className={s.label}>説明</span>
        <input
          id={`${id}-description`}
          className={s.input}
          value={description}
          disabled={action.busy}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      {action.error && (
        <p className={s.error} role="alert">
          <Icon name="circle-alert" size={13} />
          {action.error}
        </p>
      )}
      <div className={s.footer}>
        <Button onClick={onCancel}>キャンセル</Button>
        {action.busy ? (
          <Button className={s.saving} icon="loader-circle" disabled>
            保存中…
          </Button>
        ) : (
          <Button variant="primary" type="submit" disabled={!hasText(name)}>
            保存
          </Button>
        )}
      </div>
    </form>
  );
}
