import { type DragEvent, type ReactNode, useState } from "react";
import { BlockedBy } from "./BlockedBy";
import { Link } from "@tanstack/react-router";
import { errorMessage } from "../../api/errors";
import type { Status } from "../../api/types";
import { useBulkUpdateIssues } from "../../api/hooks/issues";
import { useWorkspaces } from "../../api/hooks/shared";
import { bulkFailures } from "../../lib/bulk-selection";
import { formatQuestionCount, prLabel } from "../../lib/format";
import { AGENT_STATE_META, STATUS_META, type Tone, TONE_COLORS } from "../../lib/meta";
import { workspaceColorOf } from "../../lib/workspace-color";
import { AgentAvatar, Icon, type IconName, StatusIcon } from "../ui";
import { canDropOnStatus, groupForBoard } from "./issue-list";
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

// design/nod.pen「Issues｜ボード（Linear 準拠）」（Cjq7Z）：列は幅 340 固定で、あふれた分は Board の中で横にスクロールする。
// Issue が 0 件の列は、右端の Hidden columns（PR46C）にまとめる。
// nameOfStatus は列見出しに Workspace の表示名を使うときに渡す。
// カードを別の列（Hidden columns の行を含む）へドラッグすると status を変える。グループ表示では同じ Board の中だけで受ける
export function IssueBoard({
  rows,
  nameOfStatus = (status) => STATUS_META[status].label,
}: {
  rows: IssueListRow[];
  nameOfStatus?: (status: IssueListRow["issue"]["status"]) => string;
}) {
  const columns = groupForBoard(rows);
  const hidden = columns.filter((column) => column.rows.length === 0);
  const empty = hidden.length === columns.length;
  const [showHidden, setShowHidden] = useState(true);
  const update = useBulkUpdateIssues();
  const [dragging, setDragging] = useState<{ id: string; status: Status } | null>(null);
  const [over, setOver] = useState<Status | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const droppable = (status: Status) => dragging !== null && canDropOnStatus(dragging.status, status);

  // 楽観的更新はせず、保存後の再取得で列が移る。拒否されたら Board の上部に理由を出す
  async function move(id: string, status: Status) {
    setSaving(id);
    setError("");
    try {
      await update.mutateAsync({ ids: [id], status });
    } catch (e) {
      const failure = bulkFailures(e)[0];
      setError(`${id} を ${nameOfStatus(status)} に移せませんでした：${failure ? failure.message : errorMessage(e)}`);
    } finally {
      setSaving(null);
    }
  }

  // 列と Hidden columns の行に付ける、ドロップ先の振る舞い
  const dropTarget = (status: Status) => ({
    "data-droppable": droppable(status) || undefined,
    "data-over": (droppable(status) && over === status) || undefined,
    onDragOver: (e: DragEvent) => {
      if (!droppable(status)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setOver(status);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((current) => (current === status ? null : current));
    },
    onDrop: (e: DragEvent) => {
      if (!dragging || !droppable(status)) return;
      e.preventDefault();
      const { id } = dragging;
      setDragging(null);
      setOver(null);
      void move(id, status);
    },
  });

  return (
    <>
      {error && (
        <div role="alert" className={`${s.bulkError} ${s.boardError}`}>
          <p className={s.bulkErrorHead}>
            <Icon name="circle-alert" size={14} color="var(--fail)" />
            {error}
          </p>
        </div>
      )}
      <div className={s.board}>
        {/* 全列が 0 件のときは、List と同じ空の表示を出す（右の Hidden columns は残す） */}
        {empty && <p className={s.boardEmpty}>該当する Issue はありません</p>}
        {columns.filter((column) => column.rows.length > 0).map((column) => {
          const label = nameOfStatus(column.status);
          return (
            <section key={column.status} className={s.column} aria-label={label} {...dropTarget(column.status)}>
              <header className={s.columnHead}>
                <div className={s.columnHeadRow}>
                  <StatusIcon status={column.status} />
                  <h2 className={s.columnName}>{label}</h2>
                  <span className={s.columnCount}>{column.rows.length}</span>
                </div>
                <p className={s.columnDescription} title={COLUMN_DESCRIPTIONS[column.status]}>{COLUMN_DESCRIPTIONS[column.status]}</p>
              </header>
              {column.rows.map((row) => (
                <BoardCard
                  key={row.issue.id}
                  row={row}
                  saving={saving === row.issue.id}
                  onDragStart={() => setDragging({ id: row.issue.id, status: row.issue.status })}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                />
              ))}
            </section>
          );
        })}
        {hidden.length > 0 && (
          <section className={s.hiddenColumns} aria-label="Hidden columns">
            <button type="button" className={s.hiddenToggle} aria-expanded={showHidden} onClick={() => setShowHidden(!showHidden)}>
              <Icon name={showHidden ? "chevron-down" : "chevron-right"} color="var(--ink2)" />
              Hidden columns
            </button>
            {showHidden && (
              <ul className={s.hiddenRows}>
                {hidden.map((column) => (
                  <li key={column.status} className={s.hiddenRow} title={COLUMN_DESCRIPTIONS[column.status]} {...dropTarget(column.status)}>
                    <StatusIcon status={column.status} />
                    <span className={s.hiddenName}>{nameOfStatus(column.status)}</span>
                    <span className={s.hiddenCount}>0</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </>
  );
}

// Workspace の色の四角（名前は title で読める）
function WorkspaceSwatch({ workspaceKey, name }: { workspaceKey: string; name: string }) {
  const workspaces = useWorkspaces();
  return <span className={s.boardSwatch} style={{ background: workspaceColorOf(workspaces.data, workspaceKey) ?? "transparent" }} title={name} />;
}

// カードのチップ（高さ 24 の円形）
function Chip({ tone, icon, dot, children }: { tone: Tone; icon?: IconName; dot?: boolean; children: ReactNode }) {
  const color = TONE_COLORS[tone];
  return (
    <span className={s.boardChip} style={{ color: color.fg, background: color.bg }}>
      {dot && <span className={s.agentDotMark} style={{ background: color.fg }} aria-hidden="true" />}
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

// 保存中のカードは薄くし、ドラッグできなくする
function BoardCard({ row, saving, onDragStart, onDragEnd }: { row: IssueListRow; saving: boolean; onDragStart: () => void; onDragEnd: () => void }) {
  const { issue, questions, workspaceName } = row;
  return (
    <article
      className={s.boardCard}
      draggable={!saving}
      aria-busy={saving || undefined}
      data-saving={saving || undefined}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", issue.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <div className={s.boardCardTop}>
        <div className={s.boardCardMeta}>
          <WorkspaceSwatch workspaceKey={issue.workspace} name={workspaceName} />
          <span className={s.boardCardId}>{issue.id}</span>
          {issue.prUrl && <span className={s.prLink}>{prLabel(issue.prUrl)}</span>}
          <span className={s.spacer} />
          {issue.assignee ? <AgentAvatar actor={issue.assignee} /> : <span className={s.unassigned} title="未割り当て" />}
        </div>
        <div className={s.boardCardTitleRow}>
          <span className={s.boardCardStatus}>
            <StatusIcon status={issue.status} />
          </span>
          <Link to="/issues/$issueId" params={{ issueId: issue.id }} className={`${s.boardCardTitle} ${s.titleLink}`} title={issue.title} draggable={false}>
            {issue.title}
          </Link>
        </div>
        <BlockedBy ids={issue.blockedBy} />
      </div>
      {(questions.total > 0 || issue.agentState) && (
        <div className={s.boardCardFooter}>
          {questions.total > 0 && (
            <Chip tone={questions.decided < questions.total ? "ask" : "muted"} icon="message-circle">
              未決 {formatQuestionCount(questions)}
            </Chip>
          )}
          {issue.agentState && <Chip tone={AGENT_STATE_META[issue.agentState].tone} dot>{AGENT_STATE_META[issue.agentState].label}</Chip>}
        </div>
      )}
    </article>
  );
}
