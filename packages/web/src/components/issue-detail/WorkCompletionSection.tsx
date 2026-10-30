import { useState } from "react";
import type { Issue } from "../../api/types";
import { Button } from "../ui";
import { useAsyncAction } from "./useAsyncAction";
import s from "./issue-detail.module.css";

export function WorkCompletionSection({ issue, onStart, onComplete }: {
  issue: Issue;
  onStart: () => Promise<unknown>;
  onComplete: (summary: string) => Promise<unknown>;
}) {
  const [summary, setSummary] = useState("");
  const action = useAsyncAction();
  if (issue.archivedAt !== null || (issue.status !== "in_progress" && issue.status !== "in_review")) return null;
  return <section className={s.section} aria-label="作業の完了">
    <header className={s.sectionHead}>
      <h2 className={s.sectionTitle}>作業の完了</h2>
      <span className={s.spacer} />
      {issue.status === "in_review" && <Button disabled={action.busy} onClick={() => void action.run(onStart, "再開できませんでした")}>修正を再開</Button>}
    </header>
    <p className={s.notice}>PR を含む作業は merge と完了条件を確認してから完了します。PR が不要なら、完了条件を満たした時点で報告できます。</p>
    <form className={s.form} onSubmit={event => {
      event.preventDefault();
      if (!summary.trim() || action.busy) return;
      void action.run(() => onComplete(summary), "完了できませんでした");
    }}>
      <label htmlFor={`completion-${issue.id}`}>完了報告</label>
      <textarea id={`completion-${issue.id}`} className={s.textarea} value={summary} onChange={event => setSummary(event.target.value)} disabled={action.busy} required />
      <div className={s.formActions}><Button type="submit" disabled={action.busy || !summary.trim()}>報告して完了</Button></div>
      {action.error && <p className={s.error} role="alert">{action.error}</p>}
    </form>
  </section>;
}
