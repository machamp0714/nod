import type { ReactNode } from "react";
import { ApiError } from "../../api/client";
import { Button } from "../ui";
import s from "./sprint-planning.module.css";

// 編集開始時の版を守り、競合後も入力を消さない。最新の保存内容を見てから基点版を更新する。
export function SprintEditConflict({ error, onContinue, children }: { error: unknown; onContinue: () => void; children: ReactNode }) {
  if (!(error instanceof ApiError) || error.code !== "STALE_REVISION") return null;
  return <section className={s.section} aria-label="最新の保存内容"><h3>最新の保存内容</h3>{children}
    <Button onClick={onContinue}>最新の版を確認して入力を維持</Button>
  </section>;
}
