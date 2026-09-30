import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { ISSUE_COLUMNS, type IssueColumn, type IssueGroupBy, type IssueGroupKey, type IssueLayout, type IssueListSearch, type IssueSort } from "../../routes/search";
import { Icon, IconButton, type IconName, Menu, MenuItem } from "../ui";
import s from "./issue-list.module.css";

export const GROUP_NAMES: Record<IssueGroupKey, string> = {
  workspace: "Workspace",
  status: "Status",
  priority: "Priority",
  project: "Project",
  cycle: "Cycle",
  assignee: "担当",
  label: "ラベル",
};
const GROUP_OPTIONS = Object.entries(GROUP_NAMES) as [IssueGroupKey, string][];

// short はコンボボックス（幅 100）に出す短い名前
const SORT_OPTIONS: { value: IssueSort; label: string; short?: string }[] = [
  { value: "default", label: "既定（Status・優先度・ID）", short: "既定" },
  { value: "priority", label: "優先度" },
  { value: "createdAt", label: "作成日時" },
  { value: "updatedAt", label: "更新日時" },
  { value: "title", label: "タイトル" },
  { value: "estimate", label: "見積もり" },
  { value: "dueDate", label: "期限" },
];

const COLUMN_NAMES: Record<IssueColumn, string> = { status: "Status", questions: "未決事項", workspace: "Workspace", pr: "PR", estimate: "見積もり", dueDate: "期限" };

const LAYOUTS: { value: IssueLayout; label: string; icon: IconName }[] = [
  { value: "list", label: "List", icon: "list" },
  { value: "board", label: "Board", icon: "columns-3" },
];

// design/nod.pen「Display Popover」（EMZdB）：View Bar の Display のアイコンボタンから開く、幅 302 のポップオーバー。
// List と Board の切り替え、グループ化、サブグループ、並び順と方向、表示する Issue、リストの表示列をまとめる。
// 値はすべて URL のクエリに書く（onSearchChange）。groupBy と subGroupBy は effectiveGrouping が決めた、表示に使っている値
export function DisplayPopover({
  search,
  layout,
  groupBy,
  subGroupBy,
  columns,
  onSearchChange,
}: {
  search: IssueListSearch;
  layout: IssueLayout;
  groupBy: IssueGroupKey | undefined;
  subGroupBy: IssueGroupKey | undefined;
  columns: readonly IssueColumn[];
  onSearchChange: (patch: IssueListSearch) => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // 開いたときだけ、選択中の表示のタブへフォーカスを移す
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const board = layout === "board";
  const direction = search.direction ?? "asc";

  return (
    <div
      className={s.displayRoot}
      ref={root}
      onBlur={(event) => {
        // Tab でポップオーバーの外へ出たら閉じる
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <IconButton
        ref={trigger}
        icon="sliders-horizontal"
        label="表示設定"
        bordered
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      />
      {open && (
        <div
          id={id}
          role="dialog"
          aria-label="表示設定"
          className={s.displayPopover}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            // 一覧の Escape（選択解除）やプレビューの Escape に渡さず、ポップオーバーだけを閉じる
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            trigger.current?.focus();
          }}
        >
          <div className={s.displaySection}>
            <div role="tablist" aria-label="表示" className={s.layoutTabs}>
              {LAYOUTS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  role="tab"
                  aria-selected={layout === item.value}
                  className={s.layoutTab}
                  onClick={() => onSearchChange({ layout: item.value })}
                >
                  <Icon name={item.icon} />
                  {item.label}
                </button>
              ))}
            </div>
            <div className={s.displayRow}>
              <span className={s.displayLabel}>グループ化</span>
              <DisplaySelect<IssueGroupBy>
                label="グループ化"
                // Board で URL に groupBy=status があるときは「Status」と示し、「なし」を選んで URL から消せるようにする
                value={board && search.groupBy === "status" ? "status" : groupBy ?? "none"}
                options={[
                  { value: "none", label: "なし" },
                  ...GROUP_OPTIONS.map(([value, label]) => ({ value, label, disabled: board && value === "status" })),
                ]}
                onChange={(value) => onSearchChange({ groupBy: value })}
              />
            </div>
            <div className={s.displayRow}>
              <span className={s.displayLabel}>サブグループ</span>
              <DisplaySelect<IssueGroupKey | "none">
                label="サブグループ"
                value={subGroupBy ?? "none"}
                disabled={!groupBy || board}
                options={[
                  { value: "none", label: "なし" },
                  ...GROUP_OPTIONS.map(([value, label]) => ({ value, label, disabled: value === groupBy })),
                ]}
                onChange={(value) => onSearchChange({ subGroupBy: value === "none" ? undefined : value })}
              />
            </div>
            <div className={s.displayRow}>
              <span className={s.displayLabel}>並び順</span>
              <button
                type="button"
                className={s.directionButton}
                aria-label="並び順の方向"
                title={direction === "asc" ? "昇順" : "降順"}
                data-value={direction}
                onClick={() => onSearchChange({ direction: direction === "asc" ? "desc" : "asc" })}
              >
                <Icon name={direction === "asc" ? "arrow-up-narrow-wide" : "arrow-down-wide-narrow"} />
              </button>
              <DisplaySelect<IssueSort> label="並び順" value={search.sort ?? "default"} options={SORT_OPTIONS} onChange={(value) => onSearchChange({ sort: value })} />
            </div>
          </div>
          <div className={s.displaySection}>
            <DisplaySwitch label="完了済み Issue を表示" checked={search.showCompleted !== false} onChange={(checked) => onSearchChange({ showCompleted: checked })} />
            <DisplaySwitch label="子 Issue を表示" checked={search.showChildren !== false} onChange={(checked) => onSearchChange({ showChildren: checked })} />
          </div>
          <fieldset className={`${s.displaySection} ${s.displayColumns}`} disabled={board}>
            <legend className={s.displayLabel} title="ID と Title は常に表示します">リストの表示列</legend>
            <div className={s.columnChips}>
              {ISSUE_COLUMNS.map((column) => (
                <button
                  key={column}
                  type="button"
                  className={s.columnChip}
                  aria-pressed={columns.includes(column)}
                  onClick={() => onSearchChange({ columns: ISSUE_COLUMNS.filter((key) => (key === column ? !columns.includes(key) : columns.includes(key))) })}
                >
                  {COLUMN_NAMES[column]}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      )}
    </div>
  );
}

// 22×14 のスイッチ。行のどこを押しても切り替わる
function DisplaySwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className={s.displayRow}>
      <span className={s.displayLabel}>{label}</span>
      <button type="button" role="switch" aria-checked={checked} className={s.switch} onClick={() => onChange(!checked)} />
    </label>
  );
}

interface SelectOption<T extends string> {
  value: T;
  label: string;
  short?: string;
  disabled?: boolean;
}

// 値を1つ選ぶコンボボックス（幅 100、高さ 24、角丸 8）。押すと直下に共通の Menu が開く。
// 上下キー、Home、End で項目を移り、Enter と Space で選び、Escape で閉じてボタンへ戻る。今の値は data-value に出す
function DisplaySelect<T extends string>({ label, value, options, disabled = false, onChange }: {
  label: string;
  value: T;
  options: SelectOption<T>[];
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = options.find((option) => option.value === value);
  const items = () => [...(root.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]:not(:disabled)") ?? [])];

  function close(focus: boolean) {
    setOpen(false);
    if (focus) trigger.current?.focus();
  }
  useEffect(() => {
    if (!open) return;
    const enabled = items();
    (enabled.find((item) => item.getAttribute("aria-checked") === "true") ?? enabled[0])?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // IME の変換を確定する Enter や Escape では動かさない
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      // ポップオーバーは閉じず、メニューだけを閉じる
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      // フォーカスをボタンへ戻してから、ブラウザに次の要素へ進めさせる
      close(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const enabled = items();
    const at = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const down = event.key === "ArrowDown";
    const next = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1
      : at === -1 ? (down ? 0 : enabled.length - 1) : (at + (down ? 1 : -1) + enabled.length) % enabled.length;
    enabled[next]?.focus();
  }

  return (
    <span className={s.displaySelectRoot} ref={root}>
      <button
        type="button"
        ref={trigger}
        className={s.displaySelect}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-value={value}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <span className={s.displaySelectValue}>{current?.short ?? current?.label ?? value}</span>
        <Icon name="chevron-down" size={12} color="var(--ink3)" />
      </button>
      {open && (
        <Menu label={label} className={s.displaySelectMenu} onKeyDown={onMenuKeyDown}>
          {options.map((option) => (
            <MenuItem
              key={option.value}
              checked={option.value === value}
              disabled={option.disabled}
              onClick={() => {
                close(true);
                if (option.value !== value) onChange(option.value);
              }}
            >
              <span className={s.displaySelectOption}>{option.label}</span>
              {option.value === value && <Icon name="check" />}
            </MenuItem>
          ))}
        </Menu>
      )}
    </span>
  );
}
