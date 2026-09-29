import { useRef, useState } from "react";
import { Button } from "../ui";
import s from "./issue-detail.module.css";
import { useAsyncAction } from "./useAsyncAction";

export function TitleSection({ title, onSave }: { title: string; onSave: (title: string) => Promise<unknown> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const composing = useRef(false);
  const saving = useRef(false);
  const action = useAsyncAction();

  async function save() {
    if (draft === null || !draft.trim() || composing.current || saving.current) return;
    const next = draft.trim();
    if (next === title) {
      setDraft(null);
      action.clearError();
      return;
    }
    saving.current = true;
    try {
      if (await action.run(() => onSave(next), "タイトルを保存できませんでした")) setDraft(null);
    } finally {
      saving.current = false;
    }
  }

  if (draft === null) {
    return (
      <h1 className={s.title}>
        <button className={s.titleButton} type="button" title="タイトルを編集" onClick={() => { action.clearError(); setDraft(title); }}>
          {title}
        </button>
      </h1>
    );
  }

  return (
    <section className={s.form} aria-label="タイトル編集">
      <input
        autoFocus
        className={s.input}
        aria-label="タイトル"
        value={draft}
        disabled={action.busy}
        onChange={(e) => setDraft(e.target.value)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(e) => {
          // IME の変換確定は保存操作として扱わない（Safari の keyCode 229 も含む）。
          if (e.key === "Enter") {
            e.preventDefault();
            if (!e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) void save();
          }
        }}
      />
      {action.error && <p className={s.error} role="alert">{action.error}</p>}
      <div className={s.formActions}>
        <Button disabled={action.busy} onClick={() => { composing.current = false; setDraft(null); action.clearError(); }}>
          タイトル編集をキャンセル
        </Button>
        <Button variant="primary" disabled={action.busy || !draft.trim()} onClick={() => void save()}>
          タイトルを保存
        </Button>
      </div>
    </section>
  );
}
