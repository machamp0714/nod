import type { IssueDetail } from "../../api/types";
import { awaitingQuestions } from "../../lib/awaiting-input";
import { executionLocation } from "../../lib/execution-location";
import { Icon } from "../ui";
import s from "./issue-detail.module.css";

export function AwaitingInputBanner({ issue, onAnswer, busy, readOnly = false }: {
  issue: IssueDetail;
  readOnly?: boolean;
  onAnswer: (questionId: number) => void;
  busy: boolean;
}) {
  const questions = awaitingQuestions(issue);
  const first = questions[0];
  if (!first) return null;
  const location = executionLocation(issue.branch, issue.worktree);
  return (
    <section className={s.awaitingBanner} aria-label="回答待ち">
      <Icon name="message-circle-warning" size={16} color="var(--ask)" />
      <div className={s.awaitingText}>
        {first.askedBy} が回答を待っています（{location ? <>{location.branchLabel}{location.worktree && <> · {location.worktree}</>}</> : "実行場所未記録"}）: {first.question}
        {questions.length > 1 && <span className={s.awaitingCount}>ほか {questions.length - 1} 件</span>}
      </div>
      <button type="button" className={s.awaitingAnswer} disabled={busy || readOnly} onClick={() => onAnswer(first.id)}>回答する</button>
    </section>
  );
}
