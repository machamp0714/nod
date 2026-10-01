import { DEFAULT_ISSUE_COLUMNS, type IssueColumn } from "../../routes/search";
import { AgentStateDot } from "./AgentStateDot";
import { BlockedBy } from "./BlockedBy";
import { Link } from "@tanstack/react-router";
import { formatDueDate, formatEstimate, isOverdue, localToday } from "../../lib/due-date";
import { formatDateTime, formatOpenQuestions, formatUpdated, prLabel } from "../../lib/format";
import type { Issue } from "../../api/types";
import { useStatusNames } from "../../api/hooks/workspace-labels";
import { priorityMeta, TONE_COLORS } from "../../lib/meta";
import { statusName } from "../../lib/workspace-labels";
import { AgentAvatar, Button, Icon, LabelChip, QuestionProgress, StatusIcon, WorkspaceBadge } from "../ui";
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

// nod.pen「11 Issues」（O7KCp3）の行頭の優先度アイコン（14）。Urgent は $fail、High〜Low は $ink2、優先度なしは薄く出す。
// 名前は支援技術とツールチップに出す
function PriorityCell({ priority }: { priority: number }) {
  const meta = priorityMeta(priority);
  const color = priority === 0 ? "var(--ink3)" : meta.tone === "muted" ? "var(--ink2)" : TONE_COLORS[meta.tone].fg;
  return (
    <span className={s.priorityCell} title={meta.label}>
      <Icon name={meta.icon} size={14} color={color} />
      <span className={s.visuallyHidden}>{meta.label}</span>
    </span>
  );
}

// nod.pen「11 Issues」（O7KCp3）の行：Status はアイコン（14）だけを出す。名前は支援技術とツールチップに出す
function StatusCell({ issue }: { issue: Issue }) {
  const names = useStatusNames();
  const name = statusName(issue.status, names.data, issue.workspace);
  return (
    <span className={s.statusCell} title={name}>
      <StatusIcon status={issue.status} />
      <span className={s.visuallyHidden}>{name}</span>
    </span>
  );
}

export function IssueTable({
  rows,
  columns = [...DEFAULT_ISSUE_COLUMNS],
  previewId,
  markCurrent = true,
  onPreview,
  showAgentState = false,
  selection,
}: {
  rows: IssueListRow[];
  columns?: IssueColumn[];
  previewId?: string;
  markCurrent?: boolean; // 同じ Issue が複数のグループに出るとき、aria-current は最初の1行だけに付ける
  onPreview?: (id: string) => void;
  showAgentState?: boolean; // 委任中タブだけ、タイトルの横に作業状況を出す（design/nod.pen「Issues｜委任中タブ（#53）」）
  // 一括編集の選択（design/nod.pen「Issues｜一括編集（#31）」）。List 表示のときだけ渡す
  // offset はこの表の先頭行の、一覧全体での表示位置（Shift の範囲選択に使う）
  selection?: { ids: ReadonlySet<string>; offset: number; onToggle: (at: number, shift: boolean) => void };
}) {
  const today = localToday();
  const now = new Date();
  // 行がないときは選択の列を出さない（空表示の行は表示中の列だけに広げる）
  const select = rows.length > 0 ? selection : undefined;
  const priority = columns.includes("priority");
  // 行の左端の余白（12）は先頭のセルが持つため、先頭になる列の幅にその分を足す
  const lead = (first: boolean, className: string | undefined) => (first ? `${className} ${s.colLead}` : className);
  // 列の順は nod.pen の行に合わせる（#196）：優先度、ID、Status、タイトル（ラベル）、Project、Workspace、担当、更新日時。
  // 表示設定で足す 未決事項・PR・見積もり・期限 は Workspace と担当の間に置く（「Issues｜見積もり・期限列」I1mAzW）
  return (
    <div className={s.tableScroll}>
      <table className={s.table}>
      <colgroup>
        {select && <col className={lead(true, s.colSelect)} />}
        {priority && <col className={lead(!select, s.colPriority)} />}
        <col className={lead(!select && !priority, s.colId)} />
        {columns.includes("status") && <col className={s.colStatus} />}
        <col />
        {columns.includes("project") && <col className={s.colProject} />}
        {columns.includes("workspace") && <col className={s.colWorkspace} />}
        {columns.includes("questions") && <col className={s.colQuestions} />}
        {columns.includes("pr") && <col className={s.colPr} />}
        {columns.includes("estimate") && <col className={s.colEstimate} />}
        {columns.includes("dueDate") && <col className={s.colDue} />}
        {columns.includes("assignee") && <col className={s.colAssignee} />}
        <col className={s.colUpdated} />
      </colgroup>
      {/* design/nod.pen「11 Issues」に列見出しの行はない。画面に出さず、支援技術には残す */}
      <thead className={s.visuallyHidden}>
        <tr>
          {/* 選択の列は項目ではないため列見出しにしない。各チェックボックスが「<ID> を選択」の名前を持つ */}
          {select && <td />}
          {priority && <th>優先度</th>}
          <th>ID</th>
          {columns.includes("status") && <th>Status</th>}
          <th>Title</th>
          {columns.includes("project") && <th>Project</th>}
          {columns.includes("workspace") && <th>Workspace</th>}
          {columns.includes("questions") && <th>未決事項</th>}
          {columns.includes("pr") && <th>PR</th>}
          {columns.includes("estimate") && <th>見積もり</th>}
          {columns.includes("dueDate") && <th>期限</th>}
          {columns.includes("assignee") && <th>担当</th>}
          <th>更新日時</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={3 + columns.length} className={s.muted}>
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
                <td>
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
              {priority && (
                <td>
                  <PriorityCell priority={issue.priority} />
                </td>
              )}
              <td className={s.id}>{issue.id}</td>
              {columns.includes("status") && (
                <td>
                  <StatusCell issue={issue} />
                </td>
              )}
              <td className={s.titleCell}>
                {/* 行の高さ 44 を保つため、題名の横に1行で並べる。幅が足りないときは題名を省略記号で切る */}
                <div className={s.titleRow}>
                  <Link to="/issues/$issueId" params={{ issueId: issue.id }} className={s.titleLink} title={issue.title}>
                    {issue.title}
                  </Link>
                  {/* 並びは 題名、作業状況、未決、完了候補（design/nod.pen「11 Issues｜行：未決ピル」a21Zf）。
                      未決事項の列を出しているときは列で示し、ピルは出さない（「11 Issues｜行：未決事項・PR の列を出したとき」w4l2KK） */}
                  {showAgentState && issue.agentState && <AgentStateDot state={issue.agentState} />}
                  {!columns.includes("questions") && formatOpenQuestions(questions) && <span className={s.openPill}>{formatOpenQuestions(questions)}</span>}
                  {issue.completionCandidate && (
                    <span className={s.completionPill}>
                      <Icon name="circle-check" size={11} />
                      完了候補
                    </span>
                  )}
                  <BlockedBy ids={issue.blockedBy} />
                  {onPreview && (
                    <Button size="sm" icon="eye" className={s.previewButton} aria-label={`${issue.id} をプレビュー`} onClick={() => onPreview(issue.id)}>
                      プレビュー
                    </Button>
                  )}
                  {issue.labels.length > 0 && (
                    <span className={s.rowLabels}>
                      {issue.labels.map((label) => (
                        <LabelChip key={label} workspace={issue.workspace} name={label} />
                      ))}
                    </span>
                  )}
                </div>
              </td>
              {columns.includes("project") && (
                <td>
                  {issue.project && (
                    <span className={s.projectCell} title={issue.project.name}>
                      <Icon name="box" size={12} color="var(--ink3)" />
                      <span className={s.projectName}>{issue.project.name}</span>
                    </span>
                  )}
                </td>
              )}
              {columns.includes("workspace") && (
                <td>
                  <WorkspaceBadge workspaceKey={issue.workspace} name={workspaceName} />
                </td>
              )}
              {columns.includes("questions") && (
                <td>
                  <QuestionProgress count={questions} />
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
              {columns.includes("assignee") && (
                <td>
                  <span className={s.assigneeCell}>
                    {/* アバターの頭文字を担当の名前に混ぜない。支援技術には名前だけを出す */}
                    {issue.assignee ? <span className={s.avatarWrap} aria-hidden="true"><AgentAvatar actor={issue.assignee} /></span> : <span className={s.unassigned} title="未割り当て" />}
                    <span className={s.visuallyHidden}>{issue.assignee ?? "未割り当て"}</span>
                  </span>
                </td>
              )}
              <td className={s.updated} title={formatDateTime(issue.updatedAt)}>
                {formatUpdated(issue.updatedAt, now)}
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
    </div>
  );
}
