import { useId, useState } from "react";
import { ApiError } from "../api/client";
import { errorMessage } from "../api/errors";
import { useAddTemplate, useRemoveTemplate, useTemplates, useUpdateTemplate } from "../api/hooks/templates";
import type { Template } from "../api/types";
import { Icon } from "../components/ui";
import { formatTemplateUpdated, templateAddState, templateEditState } from "../lib/templates";
import s from "./workspace-settings.module.css";
import { ErrorLine, SectionHeader } from "./WorkspaceLabelSettings";
import { DeleteDialog } from "./WorkspaceSettingsPage";

function existsMessage(name: string): string {
  return `同じ名前のテンプレート「${name}」がすでにあります。本文を変えるには編集してください`;
}

// テンプレートは全 Workspace 共通。Web からも追加・本文の編集・削除ができる（nod.pen「Workspace設定｜テンプレート Web 管理（#160）」）。
// 名前は変えられない（定期Issue が名前で参照するため）
export function TemplatesSection({ onSaved }: { onSaved: (message: string) => void }) {
  const titleId = useId();
  const templates = useTemplates();
  const remove = useRemoveTemplate();
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
      <SectionHeader id={titleId} title="テンプレート" description="Issue の説明の雛形。すべての Workspace で共通です。LLM は編集できません。" />
      {templates.error ? (
        <ErrorLine message={errorMessage(templates.error)} />
      ) : (
        templates.data && (
          <div className={s.labelList}>
            {templates.data.length === 0 && <p className={s.templateEmpty}>テンプレートはありません</p>}
            {templates.data.length > 0 && (
              <ul className={s.labelRows} aria-label="テンプレートの一覧">
                {templates.data.map((template) =>
                  editing === template.name ? (
                    // 保存済みの本文が変わったら（別の場所での更新を含む）下書きを作り直す。作業規約・定期Issue と同じ
                    <TemplateEditRow
                      key={`${template.name}:${template.updatedAt}`}
                      template={template}
                      onDone={() => {
                        setEditing(null);
                        onSaved("保存しました");
                      }}
                      onCancel={() => setEditing(null)}
                    />
                  ) : (
                    <li key={template.name} className={s.labelRow}>
                      <span className={s.templateIcon}>
                        <Icon name="file-text" size={14} />
                      </span>
                      <span className={`${s.labelName} ${s.grow}`}>{template.name}</span>
                      <span className={s.labelUsage}>{formatTemplateUpdated(template.updatedAt)}</span>
                      <span className={s.rowButtons}>
                        <button type="button" className={s.smallButton} aria-label={`${template.name} を編集`} onClick={() => setEditing(template.name)}>
                          編集
                        </button>
                        <button
                          type="button"
                          className={`${s.smallButton} ${s.smallDanger}`}
                          aria-label={`${template.name} を削除`}
                          onClick={() => setRemoving(template.name)}
                        >
                          削除
                        </button>
                      </span>
                    </li>
                  ),
                )}
              </ul>
            )}
            <TemplateAddForm existing={templates.data} onAdded={() => onSaved("追加しました")} />
          </div>
        )
      )}
      {error && <ErrorLine message={error} />}
      {removing !== null && (
        <DeleteDialog
          className={s.templateDialog}
          title={`テンプレート『${removing}』を削除しますか？`}
          message="定期Issue で使っている場合、その起票は失敗します"
          confirmLabel="削除"
          busy={remove.isPending}
          onConfirm={() => void confirmRemove(removing)}
          onClose={() => setRemoving(null)}
        />
      )}
    </section>
  );
}

function TemplateEditRow({ template, onDone, onCancel }: { template: Template; onDone: () => void; onCancel: () => void }) {
  const [body, setBody] = useState(template.body);
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateTemplate();
  const state = templateEditState(body, template.body);

  async function submit() {
    setError(null);
    try {
      await update.mutateAsync({ name: template.name, body });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <li className={`${s.labelRow} ${s.templateRowEditing}`}>
      <form
        className={s.templateForm}
        aria-label={`${template.name} を編集`}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className={s.templateHead}>
          <span className={s.templateIcon}>
            <Icon name="file-text" size={14} />
          </span>
          <span className={s.labelName}>{template.name}</span>
          <span className={s.templateBadge}>名前は変更できません</span>
        </div>
        <textarea
          className={`${s.templateBody} ${s.templateBodyEdit}`}
          aria-label={`${template.name} の本文`}
          placeholder="本文（Markdown）"
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        {error && <ErrorLine message={error} />}
        <div className={s.templateButtons}>
          <button type="button" className={s.smallButton} onClick={onCancel}>
            キャンセル
          </button>
          <button type="submit" className={`${s.smallButton} ${s.smallPrimary}`} disabled={!state.canSave || update.isPending}>
            保存
          </button>
        </div>
      </form>
    </li>
  );
}

function TemplateAddForm({ existing, onAdded }: { existing: Template[]; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<{ message: string; name: boolean } | null>(null);
  const add = useAddTemplate();
  const state = templateAddState(name, body, existing);

  async function submit() {
    if (state.duplicated) {
      setError({ message: existsMessage(state.name), name: true });
      return;
    }
    setError(null);
    try {
      await add.mutateAsync({ name: state.name, body });
      setName("");
      setBody("");
      onAdded();
    } catch (err) {
      const exists = err instanceof ApiError && err.code === "TEMPLATE_EXISTS";
      setError({ message: exists ? existsMessage(state.name) : errorMessage(err), name: exists });
    }
  }

  return (
    <form
      className={s.templateAdd}
      aria-label="テンプレートを追加"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <input
        className={`${s.input} ${s.templateNameInput} ${error?.name ? s.inputInvalid : ""}`}
        aria-label="テンプレート名"
        aria-invalid={error?.name ?? false}
        placeholder="テンプレート名"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          setError(null);
        }}
      />
      <textarea
        className={s.templateBody}
        aria-label="本文"
        placeholder="本文（Markdown）"
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      {error && <ErrorLine message={error.message} />}
      <div className={s.templateButtons}>
        <button type="submit" className={`${s.smallButton} ${s.smallPrimary}`} disabled={!state.canSave || add.isPending}>
          追加
        </button>
      </div>
    </form>
  );
}
