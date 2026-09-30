import { type FormEvent, type ReactNode, useEffect, useId, useRef } from "react";
import { Button } from "../ui";
import s from "./planning.module.css";

// Pencil「Cycles｜新規作成」「Cycle詳細｜移動の確認」のダイアログ。開いている間だけ描画し、閉じるときは親が描画をやめる
export function FormDialog({
  title,
  submitLabel,
  busy,
  error,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    // 開発時の StrictMode は effect を2回呼ぶため、開いていなければ開く
    if (!ref.current?.open) ref.current?.showModal();
  }, []);
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
      <form
        className={s.form}
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (!busy) onSubmit();
        }}
      >
        <div className={s.body}>
          <h2 id={titleId} className={s.dialogTitle}>
            {title}
          </h2>
          {children}
          {error && (
            <p role="alert" className={s.error}>
              {error}
            </p>
          )}
        </div>
        <div className={s.footer}>
          <Button onClick={onClose}>キャンセル</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
