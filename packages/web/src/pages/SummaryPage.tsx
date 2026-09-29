import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useSummary } from "../api/hooks/analytics";
import { useProjects } from "../api/hooks/projects";
import { useWorkspaces } from "../api/hooks/shared";
import { useStatusNames } from "../api/hooks/workspace-labels";
import { errorMessage } from "../api/errors";
import type { SummaryItem } from "../api/types";
import { Icon, PageError, PageLoading } from "../components/ui";
import { agentColor, agentInitial } from "../lib/color";
import {
  actorLabel,
  CARD_ORDER,
  cleanSummarySearch,
  SECTION_ORDER,
  SUMMARY_EXPANDED_LIMIT,
  SUMMARY_PAGE,
  SUMMARY_PERIODS,
  type SummaryGroup,
  type SummaryGroupView,
  summaryGroups,
  summaryNote,
  summaryQueryString,
  type SummarySearch,
  summaryTime,
  workspaceKeyOf,
} from "../lib/summary";
import { workspaceColorOf } from "../lib/workspace-color";
import { statusName } from "../lib/workspace-labels";
import s from "./summary.module.css";

const route = getRouteApi("/summary");

// nod.pen の sNVQa（Summary｜最近の動き）に合わせる。読み取り専用
export function SummaryPage() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: "/summary" });
  // 「他 N 件を表示」で広げた区分。条件を変えたら畳む
  const [expanded, setExpanded] = useState<ReadonlySet<SummaryGroup>>(new Set());
  const summary = useSummary(summaryQueryString(search, expanded.size ? SUMMARY_EXPANDED_LIMIT : SUMMARY_PAGE));
  const update = (next: SummarySearch) => {
    setExpanded(new Set());
    void navigate({ search: cleanSummarySearch(next), replace: true });
  };
  return (
    <div className={s.page}>
      <header className={s.header}>
        <h1 className={s.title}>最近の動き</h1>
        <span className={s.spacer} />
        <FilterBar search={search} onChange={update} />
      </header>
      <div className={s.content}>
        {summary.error ? (
          <PageError message={errorMessage(summary.error)} />
        ) : !summary.data ? (
          <PageLoading />
        ) : summary.data.totals.total === 0 ? (
          <div className={s.empty}>
            <Icon name="activity" size={24} color="var(--ink3)" />
            <span className={s.emptyText}>この期間の動きはありません</span>
          </div>
        ) : (
          <SummaryBody
            groups={summaryGroups(summary.data, expanded)}
            onExpand={(group) => setExpanded(new Set([...expanded, group]))}
            capped={expanded.size > 0}
          />
        )}
      </div>
    </div>
  );
}

function FilterBar({ search, onChange }: { search: SummarySearch; onChange: (next: SummarySearch) => void }) {
  const workspaces = useWorkspaces();
  const projects = useProjects();
  const since = search.since ?? "24h";
  return (
    <div className={s.filters}>
      <div role="group" aria-label="期間" className={s.segmented}>
        {SUMMARY_PERIODS.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={value === since}
            className={`${s.segment} ${value === since ? s.segmentActive : ""}`}
            onClick={() => onChange({ ...search, since: value })}
          >
            {value}
          </button>
        ))}
      </div>
      <SelectChip label="Workspace" value={search.workspace ?? ""} onChange={(v) => onChange({ ...search, workspace: v || undefined })}>
        <option value="">すべて</option>
        {(workspaces.data ?? []).map((w) => <option key={w.key} value={w.key}>{w.name}</option>)}
      </SelectChip>
      <SelectChip label="Project" value={search.project ?? ""} onChange={(v) => onChange({ ...search, project: v || undefined })}>
        <option value="">すべて</option>
        {(projects.data ?? []).map((p) => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
      </SelectChip>
      <button
        type="button"
        role="switch"
        aria-checked={search.archived === true}
        className={s.toggle}
        onClick={() => onChange({ ...search, archived: search.archived ? undefined : true })}
      >
        <span className={s.switch} data-on={search.archived === true}>
          <span className={s.knob} />
        </span>
        アーカイブを含む
      </button>
    </div>
  );
}

// ラベルつきの選択。Analytics と同じ見た目で、操作はネイティブの select に任せる
function SelectChip({ label, value, onChange, children }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className={s.select}>
      <span className={s.selectLabel}>{label}</span>
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
      <Icon name="chevron-down" size={12} color="var(--ink3)" />
    </label>
  );
}

function SummaryBody({ groups, onExpand, capped }: {
  groups: Map<SummaryGroup, SummaryGroupView>;
  onExpand: (group: SummaryGroup) => void;
  capped: boolean;
}) {
  return (
    <>
      <div className={s.counts}>
        {CARD_ORDER.map((group) => {
          const g = groups.get(group)!;
          return (
            <section key={group} className={s.count} aria-label={g.label}>
              <span className={s.countLabel}>{g.label}</span>
              <span className={s.countValue} data-alert={group === "blocker" && g.total > 0}>{g.total}</span>
              <span className={s.countSub}>人 {g.human} / LLM {g.llm}</span>
            </section>
          );
        })}
      </div>
      {SECTION_ORDER.map((group) => groups.get(group)!).filter((g) => g.total > 0).map((g) => (
        <section key={g.group} className={s.section} aria-label={`${g.label}の一覧`}>
          <div className={s.sectionHead}>
            <h2 className={s.sectionTitle}>{g.label}</h2>
            <span className={s.sectionCount}>{g.total}</span>
          </div>
          {g.items.map((item, n) => <Row key={`${n}-${item.kind}-${item.issueId}`} item={item} />)}
          {g.more > 0 && (
            <div className={s.more}>
              {capped && g.items.length > SUMMARY_PAGE ? (
                <span className={s.moreNote}>ほか {g.more} 件（{SUMMARY_EXPANDED_LIMIT} 件まで表示）</span>
              ) : (
                <button type="button" className={s.moreButton} onClick={() => onExpand(g.group)}>
                  他 {g.more} 件を表示
                </button>
              )}
            </div>
          )}
        </section>
      ))}
    </>
  );
}

function Row({ item }: { item: SummaryItem }) {
  const workspaces = useWorkspaces();
  const names = useStatusNames();
  const workspace = workspaceKeyOf(item.issueId);
  const note = summaryNote(item, (status) => statusName(status, names.data, workspace));
  return (
    <div className={s.row} data-kind={item.kind}>
      <time className={s.time} dateTime={item.at} title={new Date(item.at).toLocaleString()}>{summaryTime(item.at, new Date())}</time>
      <Link to="/issues/$issueId" params={{ issueId: item.issueId }} className={s.issue}>
        <span className={s.swatch} style={{ background: workspaceColorOf(workspaces.data, workspace) ?? "transparent" }} />
        <span className={s.issueId}>{item.issueId}</span>
        <span className={s.issueTitle}>{item.title}</span>
        {item.archived && <span className={s.archived}>アーカイブ済み</span>}
      </Link>
      <span className={s.actor}>
        <span className={s.badge}>
          <span className={s.avatar} style={{ background: agentColor(item.actor) }}>{agentInitial(item.actor)}</span>
          {actorLabel(item)}
        </span>
      </span>
      <span className={s.note} title={note}>{note}</span>
    </div>
  );
}
