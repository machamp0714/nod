import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import type { AgentState, Status } from "../../api/types";
import { AGENT_STATE_META, BOARD_STATUSES, priorityMeta, type Tone, TONE_COLORS } from "../../lib/meta";
import { DEFAULT_ISSUE_COLUMNS, ISSUE_COLUMNS, type IssueSort, type SortDirection } from "../../routes/search";
import type { IssueGroupBy, IssueGroupKey, IssueLayout, IssueListSearch, IssueTab } from "../../routes/search";
import { AgentAvatar, Icon, type IconName, Segmented, StatusIcon, WorkspaceBadge } from "../ui";
import { AgentStateDot } from "./AgentStateDot";
import { IssueBoard } from "./IssueBoard";
import { countRows, effectiveGrouping, filterRows, groupRows, type RowGroup, sortRows } from "./issue-list";
import s from "./issue-list.module.css";
import { IssueTable } from "./IssueTable";
import { PreviewPane } from "./PreviewPane";
import type { IssueListRow } from "./types";

export interface IssueListProps {
  crumb?: ReactNode;
  title: string;
  intro?: ReactNode;
  actions?: ReactNode; // 見出しの右に置くボタン（View として保存、View の変更など）
  filterBar?: ReactNode; // 絞り込み条件のバー（Issues と Views だけに置く）
  rows: IssueListRow[];
  loading?: boolean;
  error?: string | null;
  search: IssueListSearch;
  onSearchChange: (patch: IssueListSearch) => void;
}

// spec の Issue 一覧：見出し、件数カード、タブ、検索、リストとカンバンの切り替え。
// Project 詳細、Issues、Views で共通に使い、表示する Issue の範囲（rows）だけが違う。
export function IssueList({
  crumb,
  title,
  intro,
  actions,
  filterBar,
  rows,
  loading = false,
  error = null,
  search,
  onSearchChange,
}: IssueListProps) {
  const tab = search.tab ?? "all";
  const layout = search.layout ?? "list";
  const q = search.q ?? "";
  const counts = countRows(rows);
  const visible = sortRows(filterRows(rows, { tab, q, showCompleted: search.showCompleted, showChildren: search.showChildren }), search.sort, search.direction);
  const preview = search.preview;
  // プレビュー中は一覧の幅が狭くなるため、Workspace 列を隠す（design/nod.pen「Issues｜プレビュー」）
  // 表示設定の列はユーザーの設定のまま扱い、表に渡す列だけを減らす
  const columns = search.columns ?? [...DEFAULT_ISSUE_COLUMNS];
  const tableColumns = preview ? columns.filter((column) => column !== "workspace") : columns;
  const { groupBy, subGroupBy } = effectiveGrouping(search, layout);
  const groups = groupBy
    ? groupRows(layout === "board" ? visible.filter((r) => BOARD_STATUSES.includes(r.issue.status)) : visible, groupBy, subGroupBy)
    : [];
  // プレビューを閉じたら、開いた要素（なければその行のリンク）へフォーカスを戻す
  const opener = useRef<HTMLElement | null>(null);
  const shown = useRef(preview);
  useEffect(() => {
    const closed = shown.current;
    shown.current = preview;
    if (!closed || preview) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    const row = document.querySelector(`[data-issue-row="${CSS.escape(closed)}"]`);
    const back = opener.current?.isConnected && opener.current.closest(`[data-issue-row="${CSS.escape(closed)}"]`) ? opener.current : row?.querySelector<HTMLElement>("a");
    back?.focus();
  }, [preview]);
  const onPreview = useCallback((id: string) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    onSearchChange({ preview: id });
  }, [onSearchChange]);
  const closePreview = useCallback(() => onSearchChange({ preview: undefined }), [onSearchChange]);
  const titles = useMemo(() => new Map(rows.map((r) => [r.issue.id, r.issue.title])), [rows]);
  const workspaceNames = useMemo(() => new Map(rows.map((r) => [r.issue.workspace, r.workspaceName])), [rows]);
  const delegated = tab === "delegated";
  // ラベルのグループでは同じ行が何度も出るため、描画順で最初の表だけに現在のプレビューを示させる
  let currentShown = false;
  const table = (tableRows: IssueListRow[], hideHeader = false) => {
    const markCurrent = !currentShown && tableRows.some((r) => r.issue.id === preview);
    if (markCurrent) currentShown = true;
    return <IssueTable rows={tableRows} columns={tableColumns} hideHeader={hideHeader} previewId={preview} markCurrent={markCurrent} onPreview={onPreview} showAgentState={delegated} />;
  };
  const toggle = (next: IssueTab) => onSearchChange({ tab: tab === next ? "all" : next });
  // 委任中タブは LLM ごとに見られるよう、グループ化を選んでいなければ担当でまとめる
  const selectTab = (next: IssueTab) =>
    onSearchChange(next === "delegated" && !search.groupBy ? { tab: next, groupBy: "assignee" } : { tab: next });

  return (
    <div className={s.split}>
    <div className={s.page}>
      <header className={s.header}>
        <div className={s.headerText}>
          {crumb && <div className={s.crumb}>{crumb}</div>}
          <h1 className={s.title}>{title}</h1>
        </div>
        {actions && <div className={s.actions}>{actions}</div>}
      </header>
      {intro}

      <div className={s.cards}>
        <CountCard
          label="Ready"
          description="着手できる状態の Issue"
          count={counts.ready}
          tone="ready"
          icon="circle-play"
          pressed={tab === "ready"}
          onClick={() => toggle("ready")}
        />
        <CountCard
          label="Needs Clarification"
          description="未決事項が残っている Issue"
          count={counts.needsClarification}
          tone="ask"
          icon="message-circle-warning"
          pressed={tab === "needs_clarification"}
          onClick={() => toggle("needs_clarification")}
        />
      </div>

      <div className={s.toolbar}>
        <Segmented<IssueTab>
          label="絞り込み"
          value={tab}
          onChange={selectTab}
          items={[
            { value: "all", label: `All ${counts.all}` },
            { value: "ready", label: `Ready ${counts.ready}` },
            { value: "needs_clarification", label: `Needs Clarification ${counts.needsClarification}` },
            { value: "delegated", label: `委任中 ${counts.delegated}` },
          ]}
        />
        <div className={s.spacer} />
        <label className={s.search}>
          <Icon name="search" />
          <input
            className={s.searchInput}
            aria-label="検索"
            placeholder="ID・タイトル・説明で検索"
            value={q}
            onChange={(event) => onSearchChange({ q: event.target.value })}
          />
        </label>
        <label className={s.groupSelect}>
          グループ化
          <select
            aria-label="グループ化"
            // Board で URL に groupBy=status があるときは「Status」と示し、「なし」を選んで URL から消せるようにする
            value={layout === "board" && search.groupBy === "status" ? "status" : groupBy ?? "none"}
            onChange={(event) => onSearchChange({ groupBy: event.target.value as IssueGroupBy })}
          >
            <option value="none">なし</option>
            {GROUP_OPTIONS.map(([value, label]) => (
              <option key={value} value={value} disabled={layout === "board" && value === "status"}>{label}</option>
            ))}
          </select>
        </label>
        <label className={s.groupSelect}>
          サブグループ
          <select
            aria-label="サブグループ"
            value={subGroupBy ?? "none"}
            disabled={!groupBy || layout === "board"}
            onChange={(event) => onSearchChange({ subGroupBy: event.target.value === "none" ? undefined : event.target.value as IssueGroupKey })}
          >
            <option value="none">なし</option>
            {GROUP_OPTIONS.map(([value, label]) => (
              <option key={value} value={value} disabled={value === groupBy}>{label}</option>
            ))}
          </select>
        </label>
        <Segmented<IssueLayout>
          label="表示"
          value={layout}
          onChange={(value) => onSearchChange({ layout: value })}
          items={[
            { value: "list", label: "List", icon: "list" },
            { value: "board", label: "Board", icon: "columns-3" },
          ]}
        />
      </div>
      <details className={s.displaySettings}>
        <summary>表示設定</summary>
        <div className={s.displayOptions}>
          <label className={s.groupSelect}>並び順
            <select aria-label="並び順" value={search.sort ?? "default"} onChange={(event) => onSearchChange({ sort: event.target.value as IssueSort })}>
              <option value="default">既定（Status・優先度・ID）</option>
              <option value="priority">優先度</option>
              <option value="createdAt">作成日時</option>
              <option value="updatedAt">更新日時</option>
              <option value="title">タイトル</option>
              <option value="estimate">見積もり</option>
              <option value="dueDate">期限</option>
            </select>
          </label>
          <label className={s.groupSelect}>方向
            <select aria-label="並び順の方向" value={search.direction ?? "asc"} onChange={(event) => onSearchChange({ direction: event.target.value as SortDirection })}>
              <option value="asc">昇順</option><option value="desc">降順</option>
            </select>
          </label>
          <fieldset className={s.columnSettings}>
            <legend>表示するIssue</legend>
            <label>
              <input type="checkbox" checked={search.showCompleted !== false} onChange={(event) => onSearchChange({ showCompleted: event.target.checked })} />
              完了済みIssueを表示
            </label>
            <label>
              <input type="checkbox" checked={search.showChildren !== false} onChange={(event) => onSearchChange({ showChildren: event.target.checked })} />
              子Issueを表示
            </label>
          </fieldset>
          <fieldset className={s.columnSettings} disabled={layout === "board"}>
            <legend>リストの表示列（ID・Titleは常に表示）</legend>
            {ISSUE_COLUMNS.map((column) => (
              <label key={column}>
                <input type="checkbox" checked={columns.includes(column)} onChange={(event) => onSearchChange({ columns: ISSUE_COLUMNS.filter((key) => key === column ? event.target.checked : columns.includes(key)) })} />
                {{ status: "Status", questions: "未決事項", workspace: "Workspace", pr: "PR", estimate: "見積もり", dueDate: "期限" }[column]}
              </label>
            ))}
          </fieldset>
        </div>
      </details>
      {filterBar}

      {error ? (
        <p role="alert" className={`${s.message} ${s.messageError}`}>
          {error}
        </p>
      ) : loading ? (
        <p role="status" className={s.message}>
          読み込み中…
        </p>
      ) : delegated && counts.delegated === 0 ? (
        <div className={s.emptyDelegated}>
          <Icon name="bot" size={24} color="var(--ink3)" />
          LLM に委任中の Issue はありません
        </div>
      ) : groupBy ? (
        groups.length === 0 ? <p className={s.message}>該当する Issue はありません</p> : (
          groups.map((group) => (
            <section key={group.key} className={s.workspaceGroup} aria-label={`${GROUP_NAMES[groupBy]} ${group.label}`}>
              <GroupHeading by={groupBy} group={group} delegated={delegated} />
              {layout === "board" ? <IssueBoard rows={group.rows} /> : group.subgroups && subGroupBy ? (
                group.subgroups.map((subgroup) => (
                  <section key={subgroup.key} className={s.subgroup} aria-label={`${GROUP_NAMES[subGroupBy]} ${subgroup.label}`}>
                    <GroupHeading by={subGroupBy} group={subgroup} level={3} delegated={delegated} />
                    {table(subgroup.rows, true)}
                  </section>
                ))
              ) : table(group.rows)}
            </section>
          ))
        )
      ) : layout === "list" ? (
        table(visible)
      ) : (
        <IssueBoard rows={visible} />
      )}
    </div>
    {preview && (
      <PreviewPane
        key={preview}
        issueId={preview}
        titles={titles}
        workspaceName={(key) => workspaceNames.get(key) ?? key}
        onClose={closePreview}
      />
    )}
    </div>
  );
}

const GROUP_NAMES: Record<IssueGroupKey, string> = {
  workspace: "Workspace",
  status: "Status",
  priority: "Priority",
  project: "Project",
  assignee: "担当",
  label: "ラベル",
};
const GROUP_OPTIONS = Object.entries(GROUP_NAMES) as [IssueGroupKey, string][];
const AGENT_STATES = Object.keys(AGENT_STATE_META) as AgentState[];

// design/nod.pen「11 Issues」のグループ行：アイコン、名前、件数
// サブグループの見出しは「Issues｜サブグループ」の行（1段下げ、白地、weight 500）
// 委任中タブの担当の見出しは「Issues｜委任中タブ（#53）」：アバター、LLM 名、件数、作業状況の内訳（0件は出さない）
function GroupHeading({ by, group, level = 2, delegated = false }: { by: IssueGroupKey; group: RowGroup; level?: 2 | 3; delegated?: boolean }) {
  const empty = group.key === "";
  const Heading = level === 2 ? "h2" : "h3";
  if (delegated && by === "assignee" && !empty) {
    const breakdown = AGENT_STATES.map((state) => [state, group.rows.filter((r) => r.issue.agentState === state).length] as const)
      .filter(([, n]) => n > 0);
    return (
      <Heading className={level === 2 ? s.groupHeading : s.subgroupHeading}>
        <AgentAvatar actor={group.key} />
        <span className={`${s.groupLabel} ${s.agentName}`}>{group.label}</span>
        <span className={s.groupCount} aria-label={`${group.rows.length} 件`}>{group.rows.length}</span>
        {breakdown.length > 0 && (
          <span className={s.breakdown} aria-label="作業状況の内訳">
            {breakdown.map(([state, n]) => (
              <AgentStateDot key={state} state={state}>{`${AGENT_STATE_META[state].label} ${n}`}</AgentStateDot>
            ))}
          </span>
        )}
      </Heading>
    );
  }
  return (
    <Heading className={level === 2 ? s.groupHeading : s.subgroupHeading}>
      {by === "workspace" ? (
        <WorkspaceBadge workspaceKey={group.key} name={group.workspaceName ?? group.key} />
      ) : (
        <>
          {by === "status" && <StatusIcon status={group.key as Status} />}
          {by === "priority" && <Icon name={priorityMeta(Number(group.key)).icon} size={14} color={TONE_COLORS[priorityMeta(Number(group.key)).tone].fg} />}
          {by === "project" && <Icon name={empty ? "minus" : "box"} size={14} color="var(--ink3)" />}
          {by === "assignee" && <Icon name={empty ? "minus" : "circle-user"} size={14} color="var(--ink3)" />}
          {by === "label" && <Icon name={empty ? "minus" : "tag"} size={14} color="var(--ink3)" />}
          <span className={s.groupLabel}>{group.label}</span>
        </>
      )}
      <span className={s.groupCount} aria-label={`${group.rows.length} 件`}>{group.rows.length}</span>
    </Heading>
  );
}

function CountCard({
  label,
  description,
  count,
  tone,
  icon,
  pressed,
  onClick,
}: {
  label: string;
  description: string;
  count: number;
  tone: Tone;
  icon: IconName;
  pressed: boolean;
  onClick: () => void;
}) {
  const color = TONE_COLORS[tone];
  return (
    <button type="button" className={s.card} aria-pressed={pressed} aria-label={`${label} ${count}`} onClick={onClick}>
      <span className={s.badge} style={{ background: color.bg, color: color.fg }}>
        <Icon name={icon} size={16} />
      </span>
      <span className={s.cardText}>
        <span className={s.cardTop}>
          <span className={s.cardCount} style={{ color: color.fg }}>
            {count}
          </span>
          <span className={s.cardLabel}>{label}</span>
        </span>
        <span className={s.cardDesc}>{description}</span>
      </span>
    </button>
  );
}
