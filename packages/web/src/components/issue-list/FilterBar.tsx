import type { IssueQuery, Status } from "../../api/types";
import {
  describeFilter,
  type FilterOption,
  type FilterOptions,
  type MilestoneFilterOption,
  NO_CYCLE,
  NO_MILESTONE,
  toggleValue,
  withoutKey,
} from "../../lib/issue-filter";
import { useStatusNames } from "../../api/hooks/workspace-labels";
import { STATUS_ORDER } from "../../lib/meta";
import { singleWorkspace, statusName } from "../../lib/workspace-labels";
import { Icon } from "../ui";
import s from "./filter-bar.module.css";


function nameOf(options: readonly FilterOption[], value: string): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

// nod.pen の 11 Issues の Filters の行。今の条件をチップで並べ、「Filter」のパネルで足し引きする
export function FilterBar({
  filter,
  options,
  onChange,
}: {
  filter: IssueQuery;
  options: FilterOptions;
  onChange: (next: IssueQuery) => void;
}) {
  // Workspace を1つに絞ったときだけ、Status の選択肢とチップにその Workspace の表示名を使う
  const statusNames = useStatusNames();
  const nameOfStatus = (status: Status) => statusName(status, statusNames.data, singleWorkspace(filter.workspace));
  const statusOptions: FilterOption[] = STATUS_ORDER.map((status) => ({ value: status, label: nameOfStatus(status) }));
  const chips = describeFilter(filter, {
    workspace: (key) => nameOf(options.workspaces, key),
    project: (ref) => nameOf(options.projects, ref),
    milestone: (ref) => nameOf(options.milestones, ref),
    status: nameOfStatus,
  });
  return (
    <div className={s.bar} role="group" aria-label="絞り込み条件">
      {chips.map((chip) => (
        <span key={chip.key} className={s.chip}>
          <span className={s.chipName}>{chip.name}</span>
          <span className={s.chipName}>is</span>
          <span className={s.chipValue}>{chip.values}</span>
          <button
            type="button"
            className={s.chipRemove}
            aria-label={`${chip.name} の条件を外す`}
            onClick={() => onChange(withoutKey(filter, chip.key))}
          >
            <Icon name="x" size={12} />
          </button>
        </span>
      ))}
      <CycleFilter value={filter.cycle} options={options.cycles} onChange={(cycle) => onChange({ ...filter, cycle })} />
      <details className={s.menu}>
        <summary className={s.add}>
          <Icon name="plus" size={12} />
          Filter
        </summary>
        <div className={s.panel}>
          <BlockedFilter value={filter.blocked} onChange={(blocked) => onChange({ ...filter, blocked })} />
          <CheckGroup
            label="Workspace"
            options={options.workspaces}
            selected={filter.workspace}
            onToggle={(value) => onChange({ ...filter, workspace: toggleValue(filter.workspace, value) })}
          />
          <CheckGroup
            label="Status"
            options={statusOptions}
            selected={filter.status}
            onToggle={(value) => onChange({ ...filter, status: toggleValue(filter.status, value as Status) })}
          />
          <label className={s.field}>
            <span className={s.groupName}>Project</span>
            <select
              className={s.select}
              aria-label="Project"
              value={filter.project ?? ""}
              onChange={(event) => onChange({ ...filter, project: event.target.value || undefined })}
            >
              <option value="">すべて</option>
              {options.projects.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <MilestoneGroup
            options={options.milestones}
            selected={filter.milestone}
            onChange={(milestone) => onChange({ ...filter, milestone })}
          />
          <CheckGroup
            label="Label"
            options={options.labels.map((label) => ({ value: label, label }))}
            selected={filter.label}
            onToggle={(value) => onChange({ ...filter, label: toggleValue(filter.label, value) })}
          />
        </div>
      </details>
      <span className={s.spacer} />
      <ArchivedFilter value={filter.archived === true} onChange={(archived) => onChange({ ...filter, archived: archived || undefined })} />
    </div>
  );
}

// Pencil「Issues｜Cycle フィルタ・グループ（#82）」の Cycle Select。チップの並びに常に置き、「すべて」で条件を外す
export function CycleFilter({ value, options, onChange }: { value: string | undefined; options: readonly FilterOption[]; onChange: (value: string | undefined) => void }) {
  // 一覧にない ID（消された Cycle など）でも、今の条件を選択肢に出して外せるようにする
  const list = value && value !== NO_CYCLE && !options.some((o) => o.value === value) ? [...options, { value, label: `Cycle ${value}` }] : options;
  return <label className={`${s.inlineSelect} ${value ? s.inlineSelectActive : ""}`}>
    <Icon name="calendar-range" size={12} color="var(--ink3)" />
    <span className={s.inlineSelectName}>Cycle</span>
    <select className={s.inlineSelectValue} aria-label="Cycle" value={value ?? ""}
      onChange={(event) => onChange(event.target.value || undefined)}>
      <option value="">すべて</option>
      {list.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      <option value={NO_CYCLE}>Cycle なし</option>
    </select>
  </label>;
}

// Pencil「Issues｜アーカイブ絞り込み」。既定はアーカイブ済みを含めず、「アーカイブ済みのみ」でアーカイブ一覧にする
export function ArchivedFilter({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  return <label className={`${s.inlineSelect} ${value ? s.inlineSelectActive : ""}`}>
    <span className={s.inlineSelectName}>アーカイブ</span>
    <select className={s.inlineSelectValue} aria-label="アーカイブ" value={value ? "only" : "exclude"}
      onChange={(event) => onChange(event.target.value === "only")}>
      <option value="exclude">含めない</option><option value="only">アーカイブ済みのみ</option>
    </select>
  </label>;
}

// Pencil「Issues｜Milestoneフィルタ」のメニュー（L76FT）。1つだけ選び、同じ名前は Project の名前で見分ける
function MilestoneGroup({
  options,
  selected,
  onChange,
}: {
  options: readonly MilestoneFilterOption[];
  selected: string | undefined;
  onChange: (value: string) => void;
}) {
  const items = [...options.map((o) => ({ ...o, icon: "flag" as const })), { value: NO_MILESTONE, label: "Milestone なし", project: "", icon: "circle-dashed" as const }];
  return (
    <fieldset className={s.milestones}>
      <legend className={s.groupName}>Milestone</legend>
      {items.map((o) => (
        <label key={o.value} className={`${s.milestoneOption} ${selected === o.value ? s.milestoneSelected : ""}`}>
          <input
            type="radio"
            name="milestone"
            className={s.visuallyHidden}
            checked={selected === o.value}
            onChange={() => onChange(o.value)}
          />
          <Icon name={o.icon} size={13} />
          <span className={s.milestoneName}>{o.label}</span>
          {o.project && <span className={s.milestoneProject}>{o.project}</span>}
          {selected === o.value && <Icon name="check" size={13} />}
        </label>
      ))}
    </fieldset>
  );
}

function CheckGroup({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: readonly FilterOption[];
  selected: readonly string[] | undefined;
  onToggle: (value: string) => void;
}) {
  return (
    <fieldset className={s.group}>
      <legend className={s.groupName}>{label}</legend>
      {options.length === 0 ? (
        <span className={s.none}>選べる値はありません</span>
      ) : (
        options.map((o) => (
          <label key={o.value} className={s.option}>
            <input type="checkbox" checked={selected?.includes(o.value) ?? false} onChange={() => onToggle(o.value)} />
            {o.label}
          </label>
        ))
      )}
    </fieldset>
  );
}

export function BlockedFilter({ value, onChange }: { value: boolean | undefined; onChange: (value: boolean | undefined) => void }) {
  return <label className={s.field}>
    <span className={s.groupName}>ブロック</span>
    <select className={s.select} aria-label="ブロック" value={value === undefined ? "all" : String(value)}
      onChange={(event) => onChange(event.target.value === "all" ? undefined : event.target.value === "true")}>
      <option value="all">すべて</option><option value="true">ブロック中</option><option value="false">ブロックなし</option>
    </select>
  </label>;
}
