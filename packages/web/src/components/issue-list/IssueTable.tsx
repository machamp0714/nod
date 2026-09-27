import { Link } from "@tanstack/react-router";
import { prLabel } from "../../lib/format";
import { QuestionProgress, StatusLabel, WorkspaceBadge } from "../ui";
import s from "./issue-list.module.css";
import type { IssueListRow } from "./types";

export function IssueTable({ rows }: { rows: IssueListRow[] }) {
  return (
    <table className={s.table}>
      <colgroup>
        <col className={s.colStatus} />
        <col className={s.colId} />
        <col />
        <col className={s.colQuestions} />
        <col className={s.colWorkspace} />
        <col className={s.colPr} />
      </colgroup>
      <thead>
        <tr>
          <th>Status</th>
          <th>ID</th>
          <th>Title</th>
          <th>未決事項</th>
          <th>Workspace</th>
          <th>PR</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={6} className={s.muted}>
              該当する Issue はありません
            </td>
          </tr>
        ) : (
          rows.map(({ issue, questions, workspaceName }) => (
            <tr key={issue.id}>
              <td>
                <StatusLabel status={issue.status} />
              </td>
              <td className={s.id}>{issue.id}</td>
              <td className={s.titleCell}>
                <Link to="/issues/$issueId" params={{ issueId: issue.id }} className={s.titleLink} title={issue.title}>
                  {issue.title}
                </Link>
              </td>
              <td>
                <QuestionProgress count={questions} />
              </td>
              <td>
                <WorkspaceBadge workspaceKey={issue.workspace} name={workspaceName} />
              </td>
              <td>
                {issue.prUrl ? (
                  <a href={issue.prUrl} target="_blank" rel="noreferrer" className={s.prLink}>
                    {prLabel(issue.prUrl)}
                  </a>
                ) : (
                  <span className={s.muted}>—</span>
                )}
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
