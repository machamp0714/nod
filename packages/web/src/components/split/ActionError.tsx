import { errorMessage } from "../../api/errors";
import s from "./split.module.css";

// 操作と取得の失敗。文言は H の errorMessage（server のメッセージか「server に接続できません」）
export function ActionError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className={s.error}>
      {errorMessage(error)}
    </p>
  );
}
