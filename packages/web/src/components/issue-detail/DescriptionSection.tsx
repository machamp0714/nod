import { useState } from "react";
import { descriptionInput } from "../../lib/issue-edit";
import { toggleTaskAt } from "../../lib/task-list";
import { Markdown } from "../markdown/Markdown";
import { Button } from "../ui";
import s from "./issue-detail.module.css";
import { useAsyncAction } from "./useAsyncAction";

export function DescriptionSection({
  description,
  onSave,
  readOnly = false,
}: {
  description: string | null;
  onSave: (description: string | null) => Promise<unknown>;
  readOnly?: boolean;
}) {
  // draft が null のときは表示中、文字列のときは編集中
  const [draft, setDraft] = useState<string | null>(null);
  const action = useAsyncAction();

  async function save(text: string) {
    if (await action.run(() => onSave(descriptionInput(text)), "保存できませんでした")) setDraft(null);
  }

  // 表示中にタスクリストのチェックボックスを押したら、その項目の [ ] / [x] を書き換えて保存する。
  // 保存と読み直しが終わるまでは書き換えた説明を表示し、押したチェックがすぐ反映されるようにする
  const [toggled, setToggled] = useState<string | null>(null);
  const shown = toggled ?? description;

  async function toggleTask(offset: number, checked: boolean) {
    if (shown === null) return;
    const next = toggleTaskAt(shown, offset, checked);
    if (next === null) return;
    setToggled(next);
    await action.run(() => onSave(next), "保存できませんでした");
    setToggled(null);
  }

  function cancel() {
    setDraft(null);
    action.clearError();
  }

  return (
    <section className={s.section} aria-label="説明">
      <header className={s.sectionHead}>
        <h2 className={s.sectionTitle}>説明</h2>
        <span className={s.spacer} />
        {draft === null && !readOnly && (
          <Button
            icon="square-pen"
            disabled={action.busy}
            onClick={() => {
              action.clearError();
              setDraft(description ?? "");
            }}
          >
            編集
          </Button>
        )}
      </header>
      {draft === null ? (
        shown ? (
          <>
            <Markdown breaks onToggleTask={readOnly ? undefined : (offset, checked) => void toggleTask(offset, checked)} taskDisabled={action.busy}>
              {shown}
            </Markdown>
            {action.error && (
              <p className={s.error} role="alert">
                {action.error}
              </p>
            )}
          </>
        ) : (
          <p className={s.muted}>説明はありません</p>
        )
      ) : (
        <div className={s.form}>
          <textarea
            disabled={action.busy}
            className={s.textarea}
            aria-label="説明"
            rows={12}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          {action.error && (
            <p className={s.error} role="alert">
              {action.error}
            </p>
          )}
          <div className={s.formActions}>
            <Button onClick={cancel} disabled={action.busy}>
              キャンセル
            </Button>
            <Button variant="primary" icon="check" onClick={() => void save(draft)} disabled={action.busy}>
              保存
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
