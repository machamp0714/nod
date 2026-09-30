import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../api/errors";
import { useCycles } from "../../api/hooks/cycles";
import { useProjectChoices } from "../../api/hooks/issue-detail";
import { useMilestones } from "../../api/hooks/projects";
import { type BulkUpdateInput, useBulkUpdateIssues } from "../../api/hooks/issues";
import type { Issue, Status } from "../../api/types";
import { BULK_SELECT_LIMIT, type BulkFailure, bulkFailures, cycleMenu, labelMenu, milestoneMenu } from "../../lib/bulk-selection";
import { CYCLE_STATE_LABEL } from "../../lib/cycles";
import { KNOWN_ASSIGNEES } from "../../lib/issue-edit";
import { priorityMeta, STATUS_ORDER } from "../../lib/meta";
import { Icon, type IconName } from "../ui";
import d from "../planning/planning.module.css";
import s from "./issue-list.module.css";

// 一括編集で選べる状態。needs_clarification は手で変えられず、Triage は Triage 画面で判断するため出さない
const BULK_STATUSES = STATUS_ORDER.filter((status) => status !== "needs_clarification" && status !== "triage");
const PRIORITIES = [1, 2, 3, 4, 0];

type MenuKey = "status" | "priority" | "assignee" | "project" | "labels" | "estimate" | "dueDate" | "cycle" | "milestone";

// design/nod.pen「Issues｜一括編集（#31）」の一括操作バー。項目を選ぶとすぐに選択中の全 Issue へ適用する。
// 1件でも失敗したら何も変わらないため、失敗した Issue と理由をバーの上に出し、選択はそのまま残す
export function BulkActionBar({
  selected,
  labels,
  nameOfStatus,
  onClear,
  onUpdated,
}: {
  selected: Issue[];
  labels: readonly string[]; // 一覧に出ているラベル（追加の候補）
  nameOfStatus: (status: Status) => string; // 一覧と同じステータスの表示名
  onClear: () => void;
  onUpdated: (count: number) => void;
}) {
  const update = useBulkUpdateIssues();
  const projects = useProjectChoices();
  const cycles = cycleMenu(selected, useCycles().data ?? []);
  const milestones = milestoneMenu(selected, useMilestones().data ?? []);
  const [open, setOpen] = useState<MenuKey | null>(null);
  const [failures, setFailures] = useState<BulkFailure[]>([]);
  const [error, setError] = useState("");
  const [refocus, setRefocus] = useState<MenuKey | null>(null);
  const running = useRef(false);
  const barRef = useRef<HTMLDivElement>(null);
  const selectionKey = selected.map((i) => i.id).join(",");
  useEffect(() => {
    setFailures([]);
    setError("");
  }, [selectionKey]);
  // 失敗したらメニューを閉じ、開いていたボタンへフォーカスを戻す（適用中は無効なので、使えるようになってから）
  const busy = update.isPending;
  // 上限を超えた選択はサーバーで拒否されるため、送る前に知らせて項目を選べなくする（選択解除は使える）
  const overLimit = selected.length > BULK_SELECT_LIMIT;
  const disabled = busy || overLimit;
  useEffect(() => {
    if (!refocus || busy) return;
    barRef.current?.querySelector<HTMLButtonElement>(`[data-menu="${refocus}"]`)?.focus();
    setRefocus(null);
  }, [refocus, busy]);

  async function apply(patch: BulkUpdateInput) {
    if (running.current || overLimit) return;
    running.current = true;
    setFailures([]);
    setError("");
    try {
      await update.mutateAsync({ ids: selected.map((i) => i.id), ...patch });
      setOpen(null);
      onUpdated(selected.length);
    } catch (e) {
      const list = bulkFailures(e);
      if (list.length > 0) setFailures(list);
      else setError(`更新できませんでした：${errorMessage(e)}`);
      setRefocus(open);
      setOpen(null);
    } finally {
      running.current = false;
    }
  }

  const menu = (key: MenuKey) => ({ menuKey: key, open: open === key, onToggle: () => setOpen(open === key ? null : key), onClose: () => setOpen(null) });
  return (
    <div className={s.bulkDock}>
      {failures.length > 0 && (
        <div role="alert" className={s.bulkError}>
          <p className={s.bulkErrorHead}>
            <Icon name="circle-alert" size={14} color="var(--fail)" />
            {failures.length}件を更新できませんでした。何も変更していません
          </p>
          <ul className={s.bulkFailures}>
            {failures.map((f) => (
              <li key={f.id}>
                <span className={s.bulkFailureId}>{f.id}</span>
                <span>{f.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {overLimit && (
        <div role="alert" className={s.bulkError}>
          <p className={s.bulkErrorHead}>
            <Icon name="circle-alert" size={14} color="var(--fail)" />
            {`選択が一括編集の上限 ${BULK_SELECT_LIMIT} 件を超えています（${selected.length} 件）。${BULK_SELECT_LIMIT} 件以下にしてください`}
          </p>
        </div>
      )}
      {error && (
        <div role="alert" className={s.bulkError}>
          <p className={s.bulkErrorHead}>
            <Icon name="circle-alert" size={14} color="var(--fail)" />
            {error}
          </p>
        </div>
      )}
      <div ref={barRef} className={s.bulkBar} role="toolbar" aria-label="一括操作" aria-busy={busy}>
        <span className={s.bulkCount}>
          <span className={s.bulkCountCheck} aria-hidden="true">
            <Icon name="check" size={10} />
          </span>
          {selected.length} 件選択
        </span>
        <span className={s.bulkDivider} />
        <Dropdown icon="circle-dot" label="Status" disabled={disabled} {...menu("status")}>
          <Menu label="Status を変更" items={BULK_STATUSES.map((status: Status) => ({ key: status, label: nameOfStatus(status), run: () => apply({ status }) }))} />
        </Dropdown>
        <Dropdown icon="signal-high" label="優先度" disabled={disabled} {...menu("priority")}>
          <Menu label="優先度を変更" items={PRIORITIES.map((priority) => ({ key: String(priority), label: priorityMeta(priority).label, run: () => apply({ priority }) }))} />
        </Dropdown>
        <Dropdown icon="circle-user" label="担当" disabled={disabled} {...menu("assignee")}>
          <Menu
            label="担当を変更"
            items={[
              ...KNOWN_ASSIGNEES.map((assignee) => ({ key: assignee, label: assignee, run: () => apply({ assignee }) })),
              { key: "", label: "担当なし", run: () => apply({ assignee: null }) },
            ]}
          />
        </Dropdown>
        <Dropdown icon="box" label="Project" disabled={disabled} {...menu("project")}>
          <Menu
            label="Project を変更"
            items={[
              ...projects.map((p) => ({ key: String(p.id), label: p.name, run: () => apply({ projectRef: String(p.id) }) })),
              { key: "", label: "Project なし", run: () => apply({ projectRef: null }) },
            ]}
          />
        </Dropdown>
        <Dropdown icon="tag" label="ラベル" disabled={disabled} {...menu("labels")}>
          <LabelMenu selected={selected} labels={labels} onAdd={(label) => apply({ addLabels: [label] })} onRemove={(label) => apply({ removeLabels: [label] })} />
        </Dropdown>
        <Dropdown icon="gauge" label="見積もり" disabled={disabled} {...menu("estimate")}>
          <ValueForm
            label="見積もり（ポイント）"
            type="number"
            min={1}
            max={100}
            onSet={(value) => apply({ estimate: Number(value) })}
            onClear={() => apply({ estimate: null })}
          />
        </Dropdown>
        <Dropdown icon="calendar" label="期限" disabled={disabled} {...menu("dueDate")}>
          <ValueForm label="期限" type="date" onSet={(value) => apply({ dueDate: value })} onClear={() => apply({ dueDate: null })} />
        </Dropdown>
        {/* Pencil Q2vFJ（#154）。Workspace・Project が混ざる選択では無効にし、理由を title で出す */}
        <Dropdown icon="calendar-range" label="Cycle" disabled={disabled || !!cycles.disabled} title={cycles.disabled} {...menu("cycle")}>
          {cycles.disabled === undefined && (
            <ChoiceMenu
              label="Cycle を変更"
              items={cycles.cycles.map((c) => ({
                key: String(c.id),
                icon: "calendar-range",
                label: c.name,
                badge: <span className={d.badge} data-state={c.state}>{CYCLE_STATE_LABEL[c.state]}</span>,
                run: () => apply({ cycleRef: String(c.id) }),
              }))}
              empty="この Workspace に終了していない Cycle はありません"
              none={{ label: "Cycle なし", run: () => apply({ cycleRef: null }) }}
            />
          )}
        </Dropdown>
        <Dropdown icon="flag" label="Milestone" disabled={disabled || !!milestones.disabled} title={milestones.disabled} {...menu("milestone")}>
          {milestones.disabled === undefined && (
            <ChoiceMenu
              label="Milestone を変更"
              head={milestones.project.name}
              items={milestones.milestones.map((m) => ({ key: String(m.id), icon: "flag", label: m.name, run: () => apply({ milestoneRef: String(m.id) }) }))}
              empty="この Project に Milestone はありません"
              none={{ label: "Milestone なし", run: () => apply({ milestoneRef: null }) }}
            />
          )}
        </Dropdown>
        <span className={s.bulkDivider} />
        <button type="button" className={s.bulkClear} onClick={onClear}>
          <Icon name="x" size={13} />
          選択解除
        </button>
      </div>
    </div>
  );
}

function Dropdown({
  menuKey,
  icon,
  label,
  open,
  disabled,
  title,
  onToggle,
  onClose,
  children,
}: {
  menuKey: MenuKey;
  icon: IconName;
  label: string;
  open: boolean;
  disabled: boolean;
  title?: string; // 無効の理由（無効なボタンにも出るよう外側に付ける）
  onToggle: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // 開いたときだけ最初の項目へフォーカスを移す（SSE の読み直しで描き直されても動かさない）
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close.current();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div className={s.bulkDropdownWrap} ref={root} title={title}>
      <button type="button" ref={trigger} data-menu={menuKey} className={s.bulkDropdown} aria-haspopup="true" aria-expanded={open} disabled={disabled} onClick={onToggle}>
        <Icon name={icon} size={13} color="var(--ink2)" />
        {label}
        <Icon name="chevron-down" size={12} color="var(--ink3)" />
      </button>
      {open && (
        <div
          className={s.bulkPopover}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            // 一覧の Escape（選択解除）やプレビューの Escape に渡さず、メニューだけを閉じる
            event.preventDefault();
            event.stopPropagation();
            onClose();
            trigger.current?.focus();
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
}

function Menu({ label, items }: { label: string; items: { key: string; label: string; run: () => void }[] }) {
  return (
    <div role="menu" aria-label={label} className={s.bulkMenu} onKeyDown={moveFocus}>
      {items.map((item, index) => (
        <button key={item.key} type="button" role="menuitem" data-autofocus={index === 0 ? "" : undefined} onClick={item.run}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

// Cycle・Milestone のメニュー（Pencil eKr6I・z7qFd）。見出し（Project 名）→ 選択肢 → 区切り →「〜なし」
function ChoiceMenu({
  label,
  head,
  items,
  empty,
  none,
}: {
  label: string;
  head?: string;
  items: { key: string; icon: IconName; label: string; badge?: ReactNode; run: () => void }[];
  empty: string;
  none: { label: string; run: () => void };
}) {
  return (
    <div role="menu" aria-label={label} className={s.bulkMenu} onKeyDown={moveFocus}>
      {head && (
        <p className={s.bulkMenuHead}>
          <Icon name="box" size={11} color="var(--ink3)" />
          {head}
        </p>
      )}
      {items.map((item, index) => (
        <button key={item.key} type="button" role="menuitem" data-autofocus={index === 0 ? "" : undefined} onClick={item.run}>
          <Icon name={item.icon} size={12} color="var(--ink3)" />
          <span className={s.bulkLabelName}>{item.label}</span>
          {item.badge}
        </button>
      ))}
      {items.length === 0 && <p className={s.bulkEmpty}>{empty}</p>}
      <hr className={s.bulkSeparator} />
      <button type="button" role="menuitem" className={s.bulkNone} data-autofocus={items.length === 0 ? "" : undefined} onClick={none.run}>
        <Icon name="circle-dashed" size={12} color="var(--ink3)" />
        <span className={s.bulkLabelName}>{none.label}</span>
      </button>
    </div>
  );
}

function LabelMenu({
  selected,
  labels,
  onAdd,
  onRemove,
}: {
  selected: Issue[];
  labels: readonly string[];
  onAdd: (label: string) => void;
  onRemove: (label: string) => void;
}) {
  const [query, setQuery] = useState("");
  const menu = labelMenu(selected, labels, query);
  return (
    <div className={s.bulkMenu} role="group" aria-label="ラベルを変更">
      <label className={s.bulkSearch}>
        <Icon name="search" size={12} color="var(--ink3)" />
        <input data-autofocus="" aria-label="ラベルを検索" placeholder="ラベルを検索…" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <hr className={s.bulkSeparator} />
      <div role="menu" aria-label="ラベルを追加" onKeyDown={moveFocus}>
        <p className={s.bulkSection}>追加</p>
        {menu.add.map((label) => (
          <button key={label} type="button" role="menuitem" onClick={() => onAdd(label)}>
            <Icon name="plus" size={12} color="var(--ink3)" />
            <span className={s.bulkLabelDot} />
            <span className={s.bulkLabelName}>{label}</span>
          </button>
        ))}
        {menu.create && (
          <button type="button" role="menuitem" onClick={() => onAdd(menu.create as string)}>
            <Icon name="plus" size={12} color="var(--ink3)" />
            <span className={s.bulkLabelName}>「{menu.create}」を新しく追加</span>
          </button>
        )}
        {menu.add.length === 0 && !menu.create && <p className={s.bulkEmpty}>追加できるラベルはありません</p>}
      </div>
      {menu.remove.length > 0 && (
        <>
          <hr className={s.bulkSeparator} />
          <div role="menu" aria-label="ラベルを削除" onKeyDown={moveFocus}>
            <p className={s.bulkSection}>削除（選択中の Issue に付いているラベル）</p>
            {menu.remove.map(({ label, count }) => (
              <button key={label} type="button" role="menuitem" onClick={() => onRemove(label)}>
                <Icon name="minus" size={12} color="var(--ink3)" />
                <span className={s.bulkLabelDot} />
                <span className={s.bulkLabelName}>{label}</span>
                <span className={s.bulkLabelCount}>{`${selected.length}件中 ${count}`}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ValueForm({
  label,
  type,
  min,
  max,
  onSet,
  onClear,
}: {
  label: string;
  type: "number" | "date";
  min?: number;
  max?: number;
  onSet: (value: string) => void;
  onClear: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      role="group"
      aria-label={`${label}を変更`}
      className={s.bulkForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (value !== "") onSet(value);
      }}
    >
      <label>
        {label}
        <input data-autofocus="" type={type} min={min} max={max} step={type === "number" ? 1 : undefined} value={value} onChange={(event) => setValue(event.target.value)} />
      </label>
      <div className={s.bulkFormActions}>
        <button type="button" className={s.bulkClear} onClick={onClear}>
          解除
        </button>
        <button type="submit" className={s.bulkApply} disabled={value === ""}>
          適用
        </button>
      </div>
    </form>
  );
}
