import { BlockedBy } from "./BlockedBy";
import { Link } from "@tanstack/react-router";
import { formatQuestionCount, prLabel } from "../../lib/format";
import { STATUS_META } from "../../lib/meta";
import { AgentStatePill, Pill, StatusIcon } from "../ui";
import { groupForBoard } from "./issue-list";
import s from "./issue-list.module.css";
import type { IssueListRow } from "./types";

const COLUMN_DESCRIPTIONS: Partial<Record<IssueListRow["issue"]["status"], string>> = {
  needs_clarification: "着手前に未決事項を確認する",
  backlog: "受け入れ済み・着手は後で",
  todo: "着手の対象・ブロック状況を確認",
  in_progress: "作業中・進み具合を確認",
  in_review: "作業報告を確認して承認・差し戻し",
  done: "完了した Issue",
};

export function IssueBoard({ rows }: { rows: IssueListRow[] }) {
  return (
    <div className={s.board}>
      {groupForBoard(rows).map((column) => {
        const label = STATUS_META[column.status].label;
        return (
          <section key={column.status} className={s.column} aria-label={label}>
            <header className={s.columnHead}>
              <div className={s.columnHeadRow}>
                <StatusIcon status={column.status} size={15} />
                <h2 className={s.columnName}>{label}</h2>
                <span className={s.columnCount}>{column.rows.length}</span>
              </div>
              <p className={s.columnDescription}>{COLUMN_DESCRIPTIONS[column.status]}</p>
            </header>
            {column.rows.length === 0 ? (
              <p className={s.empty}>まだありません</p>
            ) : (
              column.rows.map((row) => <BoardCard key={row.issue.id} row={row} />)
            )}
          </section>
        );
      })}
    </div>
  );
}

function BoardCard({ row }: { row: IssueListRow }) {
  const { issue, questions } = row;
  return (
    <article className={s.boardCard}>
      <div className={s.boardCardTop}>
        <span>{issue.id}</span>
        {issue.prUrl && <span className={s.prLink}>{prLabel(issue.prUrl)}</span>}
      </div>
      <Link to="/issues/$issueId" params={{ issueId: issue.id }} className={`${s.boardCardTitle} ${s.titleLink}`} title={issue.title}>
        {issue.title}
      </Link>
      <BlockedBy ids={issue.blockedBy} />
      {(questions.total > 0 || issue.agentState) && (
        <div className={s.boardCardFooter}>
          {questions.total > 0 && (
            <Pill tone={questions.decided < questions.total ? "ask" : "muted"} icon="message-circle">
              未決 {formatQuestionCount(questions)}
            </Pill>
          )}
          {issue.agentState && <AgentStatePill state={issue.agentState} />}
        </div>
      )}
    </article>
  );
}
