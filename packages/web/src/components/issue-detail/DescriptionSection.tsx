import { useState } from "react";
import { descriptionInput } from "../../lib/issue-edit";
import { Markdown } from "../markdown/Markdown";
import { Button } from "../ui";
import s from "./issue-detail.module.css";
import { useAsyncAction } from "./useAsyncAction";

export function DescriptionSection({
  description,
  onSave,
}: {
  description: string | null;
  onSave: (description: string | null) => Promise<unknown>;
}) {
  // draft が null のときは表示中、文字列のときは編集中
  const [draft, setDraft] = useState<string | null>(null);
  const action = useAsyncAction();

  async function save(text: string) {
    if (await action.run(() => onSave(descriptionInput(text)), "保存できませんでした")) setDraft(null);
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
        {draft === null && (
          <Button icon="square-pen" onClick={() => setDraft(description ?? "")}>
            編集
          </Button>
        )}
      </header>
      {draft === null ? (
        description ? (
          <Markdown>{description}</Markdown>
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
