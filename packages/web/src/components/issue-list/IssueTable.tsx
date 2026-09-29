import { ISSUE_COLUMNS, type IssueColumn } from "../../routes/search";
import { AgentStateDot } from "./AgentStateDot";
import { BlockedBy } from "./BlockedBy";
import { Link } from "@tanstack/react-router";
import { prLabel } from "../../lib/format";
import { Icon, QuestionProgress, StatusLabel, WorkspaceBadge } from "../ui";
import s from "./issue-list.module.css";
import type { IssueListRow } from "./types";

export function IssueTable({
  rows,
  columns = [...ISSUE_COLUMNS],
  hideHeader = false,
  previewId,
  onPreview,
  showAgentState = false,
}: {
  rows: IssueListRow[];
  columns?: IssueColumn[];
  hideHeader?: boolean; // サブグループの表は列見出しを画面に出さない（支援技術には残す）
  previewId?: string;
  onPreview?: (id: string) => void;
  showAgentState?: boolean; // 委任中タブだけ、タイトルの横に作業状況を出す（design/nod.pen「Issues｜委任中タブ（#53）」）
}) {
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
      <thead className={hideHeader ? s.visuallyHidden : undefined}>
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
            <tr
              key={issue.id}
              className={issue.id === previewId ? s.previewing : undefined}
              aria-current={issue.id === previewId ? "true" : undefined}
              onKeyDown={onPreview && ((event) => {
                // 行の中のリンクやボタンにフォーカスがあるとき、Space でプレビューする
                if (event.key !== " " || event.defaultPrevented) return;
                event.preventDefault();
                onPreview(issue.id);
              })}
            >
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
                {showAgentState && issue.agentState && <AgentStateDot state={issue.agentState} />}
                <BlockedBy ids={issue.blockedBy} />
                {onPreview && (
                  <button type="button" className={s.previewButton} aria-label={`${issue.id} をプレビュー`} onClick={() => onPreview(issue.id)}>
                    <Icon name="eye" size={13} />
                    プレビュー
                  </button>
                )}
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
