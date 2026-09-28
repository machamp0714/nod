import { errorMessage } from "../../api/errors";
import s from "./ui.module.css";

export function LoadingMessage() {
  return (
    <p className={s.loading} role="status">
      読み込み中…
    </p>
  );
}

export function ErrorMessage({ error }: { error: unknown }) {
  return (
    <div className={s.loadError} role="alert">
      <h1 className={s.loadErrorTitle}>読み込めませんでした</h1>
      <p>{errorMessage(error)}</p>
    </div>
  );
}
