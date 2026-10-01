import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type { View } from "../../api/types";
import type { FilterChip } from "../../lib/issue-filter";
import { type DisplayItem, displaySummary } from "../../lib/view-display";
import { VIEW_COLORS, viewNameError } from "../../lib/views";
import { Button } from "../ui";
import s from "./view-dialog.module.css";

// 保存ダイアログの「保存する内容」。絞り込み条件のチップ、表示設定（既定と違うもの）、保存しないものの注記
export interface ViewSaveSummary {
  chips: readonly FilterChip[];
  display: readonly DisplayItem[];
  note: string | null;
}

export interface ViewDialogProps {
  title: string;
  submitLabel: string;
  initial: { name: string; color: string | null };
  views: readonly View[] | undefined; // 名前の重なりを確かめるための、今ある View の一覧
  selfId: number | null; // 名前を変える View の id。作るときは null
  summary?: ViewSaveSummary; // 今の画面を View として保存するときだけ渡す
  onSubmit: (value: { name: string; color: string }) => Promise<void>;
  onClose: () => void;
}

// View の作成と名前の変更に使う。開いている間だけ描画し、閉じるときは親が描画をやめる。
// summary があるときは design/nod.pen「View として保存｜ダイアログ」（D6fZTr、幅 440）。保存する内容と、保存しないものの注記を出す（#175）
export function ViewDialog({ title, submitLabel, initial, views, selfId, summary, onSubmit, onClose }: ViewDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const summaryId = useId();
  const noteId = useId();
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
      className={summary ? `${s.dialog} ${s.dialogWide}` : s.dialog}
      aria-labelledby={titleId}
      aria-describedby={summary?.note ? noteId : undefined}
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
        {summary && (
          <section className={s.summary} aria-labelledby={summaryId}>
            <h3 id={summaryId} className={s.summaryHeading}>保存する内容</h3>
            <dl className={s.summaryRows}>
              <div className={s.summaryRow}>
                <dt className={s.summaryKey}>絞り込み</dt>
                <dd className={s.summaryValue}>
                  {summary.chips.length ? (
                    <span className={s.chips}>
                      {summary.chips.map((chip) => (
                        <span key={chip.key} className={s.chip}>
                          <span className={s.chipName}>{chip.name}</span>
                          <span className={s.chipValue}>{chip.values}</span>
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className={s.summaryEmpty}>条件なし（すべての Issue）</span>
                  )}
                </dd>
              </div>
              <div className={s.summaryRow}>
                <dt className={s.summaryKey}>表示</dt>
                <dd className={s.summaryValue}>
                  {summary.display.length ? (
                    displaySummary(summary.display)
                  ) : (
                    <span className={s.summaryEmpty}>既定の表示</span>
                  )}
                </dd>
              </div>
            </dl>
          </section>
        )}
        {summary?.note && <p id={noteId} className={s.note}>{summary.note}</p>}
        {error && (
          <p role="alert" className={s.error}>
            {error}
          </p>
        )}
        <div className={s.buttons}>
          <Button onClick={onClose}>キャンセル</Button>
          <Button type="submit" variant="primary" disabled={saving || views === undefined}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
