import { DEFAULT_ISSUE_COLUMNS, type IssueColumn } from "../../routes/search";
import { AgentStateDot } from "./AgentStateDot";
import { BlockedBy } from "./BlockedBy";
import { Link } from "@tanstack/react-router";
import { formatDueDate, formatEstimate, isOverdue, localToday } from "../../lib/due-date";
import { prLabel } from "../../lib/format";
import type { Issue } from "../../api/types";
import { Icon, QuestionProgress, StatusLabel, WorkspaceBadge } from "../ui";
import s from "./issue-list.module.css";
import type { IssueListRow } from "./types";

// nod.pen「Issues｜見積もり・期限列」：期限超過は赤字と「期限超過」ピルで示す
function DueDateCell({ issue, today }: { issue: Issue; today: string }) {
  const label = formatDueDate(issue.dueDate, today);
  const overdue = isOverdue(issue, today);
  return (
    <span className={s.due}>
      <Icon name="calendar" size={12} color={overdue ? "var(--fail)" : "var(--ink3)"} />
      {label ? <span className={overdue ? s.overdue : undefined} title={issue.dueDate ?? undefined}>{label}</span> : <span className={s.muted}>—</span>}
      {overdue && <span className={s.overduePill}>期限超過</span>}
    </span>
  );
}

export function IssueTable({
  rows,
  columns = [...DEFAULT_ISSUE_COLUMNS],
  hideHeader = false,
  previewId,
  markCurrent = true,
  onPreview,
  showAgentState = false,
  selection,
}: {
  rows: IssueListRow[];
  columns?: IssueColumn[];
  hideHeader?: boolean; // サブグループの表は列見出しを画面に出さない（支援技術には残す）
  previewId?: string;
  markCurrent?: boolean; // 同じ Issue が複数のグループに出るとき、aria-current は最初の1行だけに付ける
  onPreview?: (id: string) => void;
  showAgentState?: boolean; // 委任中タブだけ、タイトルの横に作業状況を出す（design/nod.pen「Issues｜委任中タブ（#53）」）
  // 一括編集の選択（design/nod.pen「Issues｜一括編集（#31）」）。List 表示のときだけ渡す
  // offset はこの表の先頭行の、一覧全体での表示位置（Shift の範囲選択に使う）
  selection?: { ids: ReadonlySet<string>; offset: number; onToggle: (at: number, shift: boolean) => void };
}) {
  const today = localToday();
  // 行がないときは選択の列を出さない（空表示の行は表示中の列だけに広げる）
  const select = rows.length > 0 ? selection : undefined;
  return (
    <div className={s.tableScroll}>
      <table className={s.table}>
      <colgroup>
        {select && <col className={s.colSelect} />}
        {columns.includes("status") && <col className={s.colStatus} />}
        <col className={s.colId} />
        <col />
        {columns.includes("questions") && <col className={s.colQuestions} />}
        {columns.includes("workspace") && <col className={s.colWorkspace} />}
        {columns.includes("pr") && <col className={s.colPr} />}
        {columns.includes("estimate") && <col className={s.colEstimate} />}
        {columns.includes("dueDate") && <col className={s.colDue} />}
      </colgroup>
      <thead className={hideHeader ? s.visuallyHidden : undefined}>
        <tr>
          {/* 選択の列は項目ではないため列見出しにしない。各チェックボックスが「<ID> を選択」の名前を持つ */}
          {select && <td className={s.selectHead} />}
          {columns.includes("status") && <th>Status</th>}
          <th>ID</th>
          <th>Title</th>
          {columns.includes("questions") && <th>未決事項</th>}
          {columns.includes("workspace") && <th>Workspace</th>}
          {columns.includes("pr") && <th>PR</th>}
          {columns.includes("estimate") && <th>見積もり</th>}
          {columns.includes("dueDate") && <th>期限</th>}
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
          rows.map(({ issue, questions, workspaceName }, index) => (
            <tr
              key={issue.id}
              data-issue-row={issue.id}
              className={[issue.id === previewId && s.previewing, select?.ids.has(issue.id) && s.selected].filter(Boolean).join(" ") || undefined}
              aria-current={markCurrent && issue.id === previewId ? "true" : undefined}
              onKeyDown={onPreview && ((event) => {
                // 行の中のリンクやボタンにフォーカスがあるとき、Space でプレビューする（選択のチェックボックスは除く）
                if (event.key !== " " || event.defaultPrevented) return;
                if ((event.target as HTMLElement).matches("input[type=checkbox]")) return;
                event.preventDefault();
                onPreview(issue.id);
              })}
            >
              {select && (
                <td className={s.selectCell}>
                  <input
                    type="checkbox"
                    className={s.checkbox}
                    aria-label={`${issue.id} を選択`}
                    checked={select.ids.has(issue.id)}
                    onChange={() => {}}
                    onClick={(event) => select.onToggle(select.offset + index, event.shiftKey)}
                    onKeyDown={(event) => {
                      // キーボードでも Shift+Space で範囲を選べるようにする
                      if (event.key !== " " || !event.shiftKey) return;
                      event.preventDefault();
                      select.onToggle(select.offset + index, true);
                    }}
                  />
                </td>
              )}
              {columns.includes("status") && (
                <td>
                  <StatusLabel status={issue.status} workspace={issue.workspace} />
                </td>
              )}
              <td className={s.id}>{issue.id}</td>
              <td className={s.titleCell}>
                <Link to="/issues/$issueId" params={{ issueId: issue.id }} className={s.titleLink} title={issue.title}>
                  {issue.title}
                </Link>
                {issue.completionCandidate && (
                  <span className={s.completionPill}>
                    <Icon name="circle-check" size={11} />
                    完了候補
                  </span>
                )}
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
              {columns.includes("estimate") && (
                <td>{formatEstimate(issue.estimate) ?? <span className={s.muted}>—</span>}</td>
              )}
              {columns.includes("dueDate") && (
                <td>
                  <DueDateCell issue={issue} today={today} />
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
