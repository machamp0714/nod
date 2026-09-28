import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type { View } from "../../api/types";
import { VIEW_COLORS, viewNameError } from "../../lib/views";
import { Button } from "../ui";
import s from "./view-dialog.module.css";

export interface ViewDialogProps {
  title: string;
  submitLabel: string;
  initial: { name: string; color: string | null };
  views: readonly View[]; // 名前の重なりを確かめるための、今ある View の一覧
  selfId: number | null; // 名前を変える View の id。作るときは null
  onSubmit: (value: { name: string; color: string }) => Promise<void>;
  onClose: () => void;
}

// View の作成と名前の変更に使う。開いている間だけ描画し、閉じるときは親が描画をやめる
export function ViewDialog({ title, submitLabel, initial, views, selfId, onSubmit, onClose }: ViewDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [name, setName] = useState(initial.name);
  const [color, setColor] = useState<string>(initial.color ?? VIEW_COLORS[0].value);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // 開発時の StrictMode は effect を2回呼ぶため、開いていなければ開く
    if (!ref.current?.open) ref.current?.showModal();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const invalid = viewNameError(name, views, selfId);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    try {
      await onSubmit({ name: name.trim(), color });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={ref}
      className={s.dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <form className={s.form} onSubmit={(event) => void submit(event)}>
        <h2 id={titleId} className={s.title}>
          {title}
        </h2>
        <label className={s.field}>
          名前
          <input className={s.input} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <fieldset className={s.colors}>
          <legend>色</legend>
          {VIEW_COLORS.map((c) => (
            <label key={c.value} className={s.swatchLabel}>
              <input
                type="radio"
                name="view-color"
                className={s.radio}
                aria-label={c.label}
                checked={color === c.value}
                onChange={() => setColor(c.value)}
              />
              <span className={s.swatch} style={{ background: c.value }} />
            </label>
          ))}
        </fieldset>
        {error && (
          <p role="alert" className={s.error}>
            {error}
          </p>
        )}
        <div className={s.buttons}>
          <Button onClick={onClose}>キャンセル</Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
