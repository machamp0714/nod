import type { IssueQuery, Status } from "../../api/types";
import { describeFilter, type FilterOption, type FilterOptions, toggleValue, withoutKey } from "../../lib/issue-filter";
import { STATUS_META, STATUS_ORDER } from "../../lib/meta";
import { Icon } from "../ui";
import s from "./filter-bar.module.css";

const STATUS_OPTIONS: FilterOption[] = STATUS_ORDER.map((status) => ({ value: status, label: STATUS_META[status].label }));

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
  const chips = describeFilter(filter, {
    workspace: (key) => nameOf(options.workspaces, key),
    project: (ref) => nameOf(options.projects, ref),
    status: (status) => STATUS_META[status].label,
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
            options={STATUS_OPTIONS}
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
