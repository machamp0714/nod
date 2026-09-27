import type { ReactNode } from "react";
import { type Tone, TONE_COLORS } from "../../lib/meta";
import type { IssueLayout, IssueListSearch, IssueTab } from "../../routes/search";
import { Icon, type IconName, Segmented } from "../ui";
import { IssueBoard } from "./IssueBoard";
import { countRows, filterRows, sortRows } from "./issue-list";
import s from "./issue-list.module.css";
import { IssueTable } from "./IssueTable";
import type { IssueListRow } from "./types";

export interface IssueListProps {
  crumb?: ReactNode;
  title: string;
  intro?: ReactNode;
  rows: IssueListRow[];
  search: IssueListSearch;
  onSearchChange: (patch: IssueListSearch) => void;
}

// spec の Issue 一覧：見出し、件数カード、タブ、検索、リストとカンバンの切り替え。
// Project 詳細、Issues、Views で共通に使い、表示する Issue の範囲（rows）だけが違う。
export function IssueList({ crumb, title, intro, rows, search, onSearchChange }: IssueListProps) {
  const tab = search.tab ?? "all";
  const layout = search.layout ?? "list";
  const q = search.q ?? "";
  const counts = countRows(rows);
  const visible = sortRows(filterRows(rows, { tab, q }));
  const toggle = (next: IssueTab) => onSearchChange({ tab: tab === next ? "all" : next });

  return (
    <div className={s.page}>
      <header className={s.header}>
        {crumb && <div className={s.crumb}>{crumb}</div>}
        <h1 className={s.title}>{title}</h1>
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
            placeholder="タイトルか ID で検索"
            value={q}
            onChange={(event) => onSearchChange({ q: event.target.value })}
          />
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

      {layout === "list" ? <IssueTable rows={visible} /> : <IssueBoard rows={visible} />}
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
