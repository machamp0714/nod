import s from "./ui.module.css";

export function PageLoading() {
  return (
    <p role="status" className={s.pageState}>
      読み込み中…
    </p>
  );
}

export function PageError({ message }: { message: string }) {
  return (
    <p role="alert" className={`${s.pageState} ${s.pageError}`}>
      読み込めませんでした：{message}
    </p>
  );
}
