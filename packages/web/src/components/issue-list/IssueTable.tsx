import { ISSUE_COLUMNS, type IssueColumn } from "../../routes/search";
import { BlockedBy } from "./BlockedBy";
import { Link } from "@tanstack/react-router";
import { prLabel } from "../../lib/format";
import { QuestionProgress, StatusLabel, WorkspaceBadge } from "../ui";
import s from "./issue-list.module.css";
import type { IssueListRow } from "./types";

export function IssueTable({ rows, columns = [...ISSUE_COLUMNS] }: { rows: IssueListRow[]; columns?: IssueColumn[] }) {
  return (
    <div className={s.tableScroll}>
      <table className={s.table}>
      <colgroup>
        {columns.includes("status") && <col className={s.colStatus} />}
        <col className={s.colId} />
        <col />
        {columns.includes("questions") && <col className={s.colQuestions} />}
        {columns.includes("workspace") && <col className={s.colWorkspace} />}
        {columns.includes("pr") && <col className={s.colPr} />}
      </colgroup>
      <thead>
        <tr>
          {columns.includes("status") && <th>Status</th>}
          <th>ID</th>
          <th>Title</th>
          {columns.includes("questions") && <th>未決事項</th>}
          {columns.includes("workspace") && <th>Workspace</th>}
          {columns.includes("pr") && <th>PR</th>}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={2 + columns.length} className={s.muted}>
              該当する Issue はありません
            </td>
          </tr>
        ) : (
          rows.map(({ issue, questions, workspaceName }) => (
            <tr key={issue.id}>
              {columns.includes("status") && (
                <td>
                  <StatusLabel status={issue.status} />
                </td>
              )}
              <td className={s.id}>{issue.id}</td>
              <td className={s.titleCell}>
                <Link to="/issues/$issueId" params={{ issueId: issue.id }} className={s.titleLink} title={issue.title}>
                  {issue.title}
                </Link>
                <BlockedBy ids={issue.blockedBy} />
              </td>
              {columns.includes("questions") && (
                <td>
                  <QuestionProgress count={questions} />
                </td>
              )}
              {columns.includes("workspace") && (
                <td>
                  <WorkspaceBadge workspaceKey={issue.workspace} name={workspaceName} />
                </td>
              )}
              {columns.includes("pr") && (
                <td>
                  {issue.prUrl ? (
                    <a href={issue.prUrl} target="_blank" rel="noreferrer" className={s.prLink}>
                      {prLabel(issue.prUrl)}
                    </a>
                  ) : (
                    <span className={s.muted}>—</span>
                )}
              </td>
              )}
            </tr>
          ))
        )}
      </tbody>
    </table>
    </div>
  );
}
