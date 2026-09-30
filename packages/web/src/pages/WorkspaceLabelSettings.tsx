import { useId, useState } from "react";
import { ApiError } from "../api/client";
import { errorMessage } from "../api/errors";
import {
  useAddWorkspaceLabel,
  useRemoveWorkspaceLabel,
  useSaveStatusNames,
  useStatusNames,
  useUpdateWorkspaceLabel,
  useWorkspaceLabels,
} from "../api/hooks/workspace-labels";
import type { Workspace, WorkspaceLabel } from "../api/types";
import { Icon } from "../components/ui";
import { STATUS_META, STATUS_ORDER } from "../lib/meta";
import {
  LABEL_COLORS,
  labelColorChoices,
  STATUS_NAME_MAX_LENGTH,
  type StatusNames,
  statusNamesEditState,
} from "../lib/workspace-labels";
import s from "./workspace-settings.module.css";
import { DeleteDialog } from "./WorkspaceSettingsPage";

export function SectionHeader({ id, title, description }: { id: string; title: string; description?: string }) {
  return (
    <div className={s.sectionHeader}>
      <h2 id={id} className={s.sectionTitle}>
        {title}
      </h2>
      {description && <p className={s.description}>{description}</p>}
    </div>
  );
}

export function ErrorLine({ message, indent }: { message: string; indent?: boolean }) {
  return (
    <p role="alert" className={`${s.error} ${indent ? s.errorIndent : ""}`}>
      <Icon name="circle-alert" size={13} />
      {message}
    </p>
  );
}

// nod.pen の Color Select：選んだ色の丸と下向きの矢印。選択肢は色名で読み上げる
function ColorSelect({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  return (
    <span className={s.colorSelect}>
      <span className={s.swatch} style={{ background: value }} aria-hidden="true" />
      <Icon name="chevron-down" size={12} />
      <select className={s.colorNative} aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {labelColorChoices(value).map((c) => (
          <option key={c.value} value={c.value}>
            {c.name}
          </option>
        ))}
      </select>
    </span>
  );
}

function duplicateMessage(err: unknown, name: string): string {
  return err instanceof ApiError && err.code === "LABEL_EXISTS" ? `同じ名前のラベル「${name.trim()}」がすでにあります` : errorMessage(err);
}

export function LabelsSection({ workspace, onSaved }: { workspace: Workspace; onSaved: (message: string) => void }) {
  const titleId = useId();
  const labels = useWorkspaceLabels(workspace.key);
  const remove = useRemoveWorkspaceLabel(workspace.key);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function confirmRemove(name: string) {
    setError(null);
    try {
      await remove.mutateAsync(name);
      setRemoving(null);
      onSaved("削除しました");
    } catch (err) {
      setRemoving(null);
      setError(errorMessage(err));
    }
  }

  return (
    <section className={s.section} aria-labelledby={titleId}>
      <SectionHeader id={titleId} title="ラベル" description="この Workspace の Issue に付けるラベルの色と説明。LLM は編集できません。" />
      {labels.error ? (
        <ErrorLine message={errorMessage(labels.error)} />
      ) : (
        <div className={s.labelList}>
          {labels.data?.length === 0 && <p className={s.labelEmpty}>ラベルの定義はありません</p>}
          {labels.data && labels.data.length > 0 && (
            <ul className={s.labelRows} aria-label="ラベルの定義">
              {labels.data.map((label) =>
                editing === label.name ? (
                  <LabelEditRow
                    key={label.name}
                    workspace={workspace}
                    label={label}
                    onDone={() => {
                      setEditing(null);
                      onSaved("保存しました");
                    }}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <li key={label.name} className={s.labelRow}>
                    <span className={s.swatch} style={{ background: label.color }} aria-hidden="true" />
                    <span className={s.labelName}>{label.name}</span>
                    <span className={s.labelDescription}>{label.description}</span>
                    <span className={s.labelUsage}>{label.issueCount} 件</span>
                    <span className={s.rowButtons}>
                      <button type="button" className={s.smallButton} aria-label={`${label.name} を編集`} onClick={() => setEditing(label.name)}>
                        編集
                      </button>
                      <button
                        type="button"
                        className={`${s.smallButton} ${s.smallDanger}`}
                        aria-label={`${label.name} を削除`}
                        onClick={() => setRemoving(label.name)}
                      >
                        削除
                      </button>
                    </span>
                  </li>
                ),
              )}
            </ul>
          )}
          <LabelAddRow workspace={workspace} existing={labels.data ?? []} onAdded={() => onSaved("追加しました")} />
        </div>
      )}
      {error && <ErrorLine message={error} />}
      {removing !== null && (
        <DeleteDialog
          title={`ラベル「${removing}」の定義を削除しますか？`}
          message="定義を削除します。Issue のラベルは残ります"
          busy={remove.isPending}
          onConfirm={() => void confirmRemove(removing)}
          onClose={() => setRemoving(null)}
        />
      )}
    </section>
  );
}

function LabelAddRow({ workspace, existing, onAdded }: { workspace: Workspace; existing: WorkspaceLabel[]; onAdded: () => void }) {
  const [color, setColor] = useState(LABEL_COLORS[0]!.value);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<{ message: string; name: boolean } | null>(null);
  const add = useAddWorkspaceLabel(workspace.key);

  async function submit() {
    const trimmed = name.trim();
    if (existing.some((l) => l.name === trimmed)) {
      setError({ message: `同じ名前のラベル「${trimmed}」がすでにあります`, name: true });
      return;
    }
    setError(null);
    try {
      await add.mutateAsync({ name, color, description });
      setName("");
      setDescription("");
      setColor(LABEL_COLORS[0]!.value);
      onAdded();
    } catch (err) {
      setError({ message: duplicateMessage(err, name), name: err instanceof ApiError && (err.code === "LABEL_EXISTS" || err.code === "INVALID_ARGS") });
    }
  }

  return (
    <form
      className={s.labelAdd}
      aria-label="ラベルを追加"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className={s.labelInputs}>
        <ColorSelect value={color} onChange={setColor} label="新しいラベルの色" />
        <input
          className={`${s.input} ${s.nameInput} ${error?.name ? s.inputInvalid : ""}`}
          aria-label="ラベル名"
          aria-invalid={error?.name ?? false}
          placeholder="ラベル名"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
        />
        <input
          className={`${s.input} ${s.grow}`}
          aria-label="説明"
          placeholder="説明（任意）"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <button type="submit" className={`${s.smallButton} ${s.smallPrimary}`} disabled={!name.trim() || add.isPending}>
          追加
        </button>
      </div>
      {error && <ErrorLine message={error.message} indent />}
    </form>
  );
}

function LabelEditRow({
  workspace,
  label,
  onDone,
  onCancel,
}: {
  workspace: Workspace;
  label: WorkspaceLabel;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [color, setColor] = useState(label.color);
  const [name, setName] = useState(label.name);
  const [description, setDescription] = useState(label.description);
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateWorkspaceLabel(workspace.key);

  async function submit() {
    setError(null);
    try {
      await update.mutateAsync({ name: label.name, newName: name, color, description });
      onDone();
    } catch (err) {
      setError(duplicateMessage(err, name));
    }
  }

  return (
    <li className={`${s.labelRow} ${s.labelRowEditing}`}>
      <form
        className={s.labelEditForm}
        aria-label={`${label.name} を編集`}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className={s.labelInputs}>
          <ColorSelect value={color} onChange={setColor} label={`${label.name} の色`} />
          <input
            className={`${s.input} ${s.editNameInput} ${error ? s.inputInvalid : ""}`}
            aria-label="ラベル名"
            aria-invalid={error !== null}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <input className={`${s.input} ${s.grow}`} aria-label="説明" value={description} onChange={(event) => setDescription(event.target.value)} />
          <span className={s.rowButtons}>
            <button type="button" className={s.smallButton} onClick={onCancel}>
              キャンセル
            </button>
            <button type="submit" className={`${s.smallButton} ${s.smallPrimary}`} disabled={!name.trim() || update.isPending}>
              保存
            </button>
          </span>
        </div>
        {error && <ErrorLine message={error} indent />}
      </form>
    </li>
  );
}

export function StatusNamesSection({ workspace, onSaved }: { workspace: Workspace; onSaved: () => void }) {
  const titleId = useId();
  const all = useStatusNames();
  const saved = all.data?.[workspace.key];
  if (all.error) {
    return (
      <section className={s.section} aria-labelledby={titleId}>
        <SectionHeader id={titleId} title="ステータスの表示名" />
        <ErrorLine message={errorMessage(all.error)} />
      </section>
    );
  }
  if (!all.data) return null;
  // 保存済みの表示名が変わったら（別の場所での更新を含む）下書きを作り直す
  return <StatusNamesForm key={JSON.stringify(saved ?? {})} titleId={titleId} workspace={workspace} saved={saved ?? {}} onSaved={onSaved} />;
}

function StatusNamesForm({
  titleId,
  workspace,
  saved,
  onSaved,
}: {
  titleId: string;
  workspace: Workspace;
  saved: StatusNames;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<StatusNames>(saved);
  const [error, setError] = useState<string | null>(null);
  const save = useSaveStatusNames(workspace.key);
  const state = statusNamesEditState(draft, saved);

  async function submit() {
    setError(null);
    try {
      await save.mutateAsync(state.normalized);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section className={s.section} aria-labelledby={titleId}>
      <SectionHeader id={titleId} title="ステータスの表示名" description="表示名だけを変えます。状態の意味や遷移は変わりません。" />
      <div className={s.statusRows}>
        {STATUS_ORDER.map((status) => (
          <label key={status} className={s.statusRow}>
            <span className={s.statusKey}>{status}</span>
            <input
              className={`${s.input} ${s.grow} ${state.tooLong.includes(status) ? s.inputInvalid : ""}`}
              aria-label={`${status} の表示名`}
              aria-invalid={state.tooLong.includes(status)}
              placeholder={STATUS_META[status].label}
              value={draft[status] ?? ""}
              onChange={(event) => setDraft({ ...draft, [status]: event.target.value })}
            />
          </label>
        ))}
      </div>
      {state.tooLong.length > 0 && <ErrorLine message={`表示名は ${STATUS_NAME_MAX_LENGTH} 文字以内で入力してください`} />}
      {state.duplicated !== null && <ErrorLine message={`表示名「${state.duplicated}」が複数のステータスで重なっています`} />}
      {error && <ErrorLine message={error} />}
      <div className={s.footerEnd}>
        <button type="button" className={s.smallButton} disabled={state.empty || save.isPending} onClick={() => setDraft({})}>
          既定に戻す
        </button>
        <button
          type="button"
          className={`${s.smallButton} ${s.smallPrimary}`}
          aria-label="表示名を保存"
          disabled={!state.canSave || save.isPending}
          onClick={() => void submit()}
        >
          保存
        </button>
      </div>
    </section>
  );
}
