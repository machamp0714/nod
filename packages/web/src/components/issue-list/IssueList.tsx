import type { ReactNode } from "react";
import { BOARD_STATUSES, type Tone, TONE_COLORS } from "../../lib/meta";
import { ISSUE_COLUMNS, type IssueSort, type SortDirection } from "../../routes/search";
import type { IssueGroupBy, IssueLayout, IssueListSearch, IssueTab } from "../../routes/search";
import { Icon, type IconName, Segmented, WorkspaceBadge } from "../ui";
import { IssueBoard } from "./IssueBoard";
import { countRows, filterRows, sortRows, groupRowsByWorkspace } from "./issue-list";
import s from "./issue-list.module.css";
import { IssueTable } from "./IssueTable";
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
  const visible = sortRows(filterRows(rows, { tab, q }), search.sort, search.direction);
  const columns = search.columns ?? [...ISSUE_COLUMNS];
  const grouped = search.groupBy === "workspace";
  const groups = grouped
    ? groupRowsByWorkspace(layout === "board" ? visible.filter((r) => BOARD_STATUSES.includes(r.issue.status)) : visible)
    : [];
  const toggle = (next: IssueTab) => onSearchChange({ tab: tab === next ? "all" : next });

  return (
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
          onChange={(value) => onSearchChange({ tab: value })}
          items={[
            { value: "all", label: `All ${counts.all}` },
            { value: "ready", label: `Ready ${counts.ready}` },
            { value: "needs_clarification", label: `Needs Clarification ${counts.needsClarification}` },
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
            value={search.groupBy ?? "none"}
            onChange={(event) => onSearchChange({ groupBy: event.target.value as IssueGroupBy })}
          >
            <option value="none">なし</option>
            <option value="workspace">Workspace</option>
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
            </select>
          </label>
          <label className={s.groupSelect}>方向
            <select aria-label="並び順の方向" value={search.direction ?? "asc"} onChange={(event) => onSearchChange({ direction: event.target.value as SortDirection })}>
              <option value="asc">昇順</option><option value="desc">降順</option>
            </select>
          </label>
          <fieldset className={s.columnSettings} disabled={layout === "board"}>
            <legend>リストの表示列（ID・Titleは常に表示）</legend>
            {ISSUE_COLUMNS.map((column) => (
              <label key={column}>
                <input type="checkbox" checked={columns.includes(column)} onChange={(event) => onSearchChange({ columns: ISSUE_COLUMNS.filter((key) => key === column ? event.target.checked : columns.includes(key)) })} />
                {{ status: "Status", questions: "未決事項", workspace: "Workspace", pr: "PR" }[column]}
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
      ) : grouped ? (
        groups.length === 0 ? <p className={s.message}>該当する Issue はありません</p> : (
          groups.map((group) => (
            <section key={group.key} className={s.workspaceGroup} aria-label={`Workspace ${group.key}`}>
              <h2 className={s.groupHeading}>
                <WorkspaceBadge workspaceKey={group.key} name={group.name} />
                <span>{group.key} · {group.rows.length} 件</span>
              </h2>
              {layout === "list" ? <IssueTable rows={group.rows} columns={columns} /> : <IssueBoard rows={group.rows} />}
            </section>
          ))
        )
      ) : layout === "list" ? (
        <IssueTable rows={visible} columns={columns} />
      ) : (
        <IssueBoard rows={visible} />
      )}
    </div>
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
