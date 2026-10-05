import { useCycles } from "../../api/hooks/cycles";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Issue, IssueReminder, Relations, RelationState, Status, UpdateIssueInput } from "../../api/types";
import { attachmentDate } from "./DocumentsSection";
import { PrStatusSection } from "./PrStatusSection";
import { prLabel } from "../../lib/format";
import { formatDueDate, formatEstimate, isOverdue, isValidDueDateInput, localToday, MIN_DUE_DATE, parseEstimateInput } from "../../lib/due-date";
import { cycleMenu as unfinishedCycles } from "../../lib/bulk-selection";
import { executionLocation } from "../../lib/execution-location";
import { assigneeChoices, hasText, parseLabels, statusChoices } from "../../lib/issue-edit";
import { statusName } from "../../lib/workspace-labels";
import { useStatusNames } from "../../api/hooks/workspace-labels";
import { useMilestones } from "../../api/hooks/projects";
import { priorityMeta, STATUS_META, TONE_COLORS } from "../../lib/meta";
import { relationMark } from "../../lib/relation-state";
import { formatReminderAt, parseReminderInput, reminderInputs } from "../../lib/reminder";
import { AgentAvatar, AgentStatePill, Button, Icon, type IconName, LabelChip, Pill, WorkspaceBadge } from "../ui";
import s from "./issue-detail.module.css";
import { OpenInOrcaButton } from "./OpenInOrcaButton";
import { PropertyMenu, type PropertyOption } from "./PropertyMenu";
import { StartInOrcaButton } from "./StartInOrcaButton";
import { useAsyncAction } from "./useAsyncAction";

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={s.prop}>
      <dt className={s.propKey}>{label}</dt>
      <dd className={s.propValue}>{children}</dd>
    </div>
  );
}

// 空の値は薄い文字の「なし」（nod.pen「見積もり・期限｜行の状態」QP1Q5）
function Empty() {
  return <span className={s.propPlaceholder}>なし</span>;
}

// ピルとメニューの項目の先頭に置くアイコン（14）。色は親から受け、読み上げには出さない
function PropIcon({ name, color }: { name: IconName; color: string }) {
  return <span className={s.propIcon} style={{ color }} aria-hidden="true"><Icon name={name} /></span>;
}

// 変える操作がない値。ピルと同じ余白で並べる
function Static({ children }: { children: ReactNode }) {
  return <span className={s.propStatic}>{children}</span>;
}

const PRIORITY_OPTIONS: PropertyOption[] = [0, 1, 2, 3, 4].map((priority) => {
  const meta = priorityMeta(priority);
  return { value: String(priority), label: meta.label, icon: <PropIcon name={meta.icon} color={TONE_COLORS[meta.tone].fg} /> };
});

type Change = (input: UpdateIssueInput) => Promise<unknown>;

// nod.pen「見積もり・期限｜行の状態」：表示中は値を押すと入力に切り替わる。Enter・フォーカス外しで確定、Escape で取り消す
function EstimateField({ estimate, busy, change }: { estimate: number | null; busy: boolean; change: Change }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const close = () => { setDraft(null); setInvalid(false); };
  async function commit() {
    if (draft === null) return;
    const value = parseEstimateInput(draft);
    if (value === undefined) return setInvalid(true);
    if (value === estimate || (await change({ estimate: value }))) close();
  }
  if (draft === null) {
    const label = formatEstimate(estimate);
    return (
      <button type="button" className={s.propButton} aria-label="Estimate を編集" disabled={busy} onClick={() => setDraft(estimate === null ? "" : String(estimate))}>
        <PropIcon name="gauge" color={label ? "var(--ink2)" : "var(--ink3)"} />
        {label ? <span className={s.propText}>{label}</span> : <Empty />}
      </button>
    );
  }
  return (
    <span className={s.propEdit}>
      <span className={s.numberInput}>
        <input
          autoFocus
          className={s.bareInput}
          aria-label="Estimate"
          aria-invalid={invalid || undefined}
          inputMode="numeric"
          placeholder="1〜100"
          value={draft}
          disabled={busy}
          onChange={(e) => { setDraft(e.target.value); setInvalid(false); }}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) void commit();
            if (e.key === "Escape") close();
          }}
        />
        <span className={s.unit}>pt</span>
      </span>
      {invalid && <span className={s.fieldError} role="alert">1〜100 の整数で入力してください</span>}
    </span>
  );
}

// 日付欄はキーボード入力の途中（年の1桁目など）でも値が変わるため、変更ごとには保存せず Enter・フォーカス外しで確定する
function DueDateField({ issue, busy, change }: { issue: Issue; busy: boolean; change: Change }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const label = formatDueDate(issue.dueDate, localToday());
  const overdue = isOverdue(issue, localToday());
  const close = () => { setDraft(null); setInvalid(false); };
  async function set(dueDate: string | null) {
    if (dueDate === issue.dueDate || (await change({ dueDate }))) close();
  }
  async function commit() {
    if (draft === null) return;
    // 空は入力が揃っていない状態。解除は「解除」で行う
    if (draft === "") return close();
    if (!isValidDueDateInput(draft)) return setInvalid(true);
    await set(draft);
  }
  if (draft === null) {
    return (
      <button type="button" className={s.propButton} aria-label="Due date を編集" disabled={busy} onClick={() => setDraft(issue.dueDate ?? "")}>
        <PropIcon name="calendar" color={overdue ? "var(--fail)" : label ? "var(--ink2)" : "var(--ink3)"} />
        {label ? <span className={overdue ? `${s.propText} ${s.overdue}` : s.propText} title={issue.dueDate ?? undefined}>{label}</span> : <Empty />}
        {overdue && <Pill tone="fail">期限超過</Pill>}
      </button>
    );
  }
  return (
    <span
      className={s.propEdit}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) void commit(); }}
      onKeyDown={(e) => { if (e.key === "Escape") close(); }}
    >
      <input
        autoFocus
        type="date"
        className={`${s.input} ${s.pillInput}`}
        aria-label="Due date"
        aria-invalid={invalid || undefined}
        min={MIN_DUE_DATE}
        max="9999-12-31"
        value={draft}
        disabled={busy}
        onChange={(e) => { setDraft(e.target.value); setInvalid(false); }}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void commit(); }}
      />
      <Button size="sm" icon="x" onClick={() => void set(null)} disabled={busy || issue.dueDate === null}>
        解除
      </Button>
      {invalid && <span className={s.fieldError} role="alert">{MIN_DUE_DATE} 以降の日付を入力してください</span>}
    </span>
  );
}

// リマインダーの設定・解除。null で解除
export type RemindChange = (input: { at: string; note: string | null } | null) => Promise<unknown>;

const REMINDER_ERRORS = { invalid: "日付と時刻を入力してください", past: "過去の日時は指定できません" } as const;

// nod.pen「リマインダー行｜状態」：未設定・設定済み（日時とメモの2段）・編集中（日付＋時刻＋メモ、設定・解除）・過去日時エラー。
// Escape で取り消す。アーカイブ済み（archived）は設定・変更できず、設定済みなら解除だけできる（Pencil に状態がないため、既存の「解除」ボタンで補う）
function ReminderField({ reminder, busy, archived, change }: {
  reminder: IssueReminder | null;
  busy: boolean;
  archived: boolean;
  change: (input: Parameters<RemindChange>[0]) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<{ date: string; time: string; note: string } | null>(null);
  const [error, setError] = useState<keyof typeof REMINDER_ERRORS | null>(null);
  const close = () => { setDraft(null); setError(null); };
  const edit = (next: Partial<{ date: string; time: string; note: string }>) => { setDraft((d) => (d ? { ...d, ...next } : d)); setError(null); };
  async function commit() {
    if (draft === null) return;
    const parsed = parseReminderInput(draft.date, draft.time);
    if ("error" in parsed) return setError(parsed.error);
    if (await change({ at: parsed.at.toISOString(), note: draft.note.trim() || null })) close();
  }
  async function clear() {
    if (await change(null)) close();
  }
  if (draft === null) {
    const display = (
      <button type="button" className={reminder?.note ? `${s.propButton} ${s.propButtonStack}` : s.propButton} aria-label="Reminder を編集" disabled={busy || archived}
        onClick={() => setDraft({ ...reminderInputs(reminder?.remindAt ?? null), note: reminder?.note ?? "" })}>
        <PropIcon name="bell" color={reminder ? "var(--ink2)" : "var(--ink3)"} />
        {reminder ? (
          <span className={s.reminderStack}>
            <span className={s.propText} title={reminder.remindAt}>{formatReminderAt(reminder.remindAt)}</span>
            {reminder.note && <span className={s.reminderNote}>{reminder.note}</span>}
          </span>
        ) : <Empty />}
      </button>
    );
    if (!archived || reminder === null) return display;
    return (
      <span className={s.reminderArchived}>
        {display}
        <Button size="sm" icon="x" className={s.unlocked} onClick={() => void clear()} disabled={busy}>解除</Button>
      </span>
    );
  }
  return (
    <form className={s.reminderEdit} aria-label="リマインダー" onSubmit={(e) => { e.preventDefault(); void commit(); }}
      onKeyDown={(e) => { if (e.key === "Escape") close(); }}>
      <span className={s.reminderDateTime}>
        <input autoFocus type="date" className={s.input} aria-label="リマインダーの日付" aria-invalid={error !== null || undefined}
          value={draft.date} disabled={busy} onChange={(e) => edit({ date: e.target.value })} />
        <input type="time" className={`${s.input} ${s.reminderTime}`} aria-label="リマインダーの時刻" value={draft.time} disabled={busy}
          onChange={(e) => edit({ time: e.target.value })} />
      </span>
      <input className={s.input} aria-label="リマインダーのメモ" placeholder="メモ（任意）" value={draft.note} disabled={busy}
        onChange={(e) => edit({ note: e.target.value })} />
      {error && <span className={s.fieldError} role="alert"><Icon name="circle-alert" size={12} />{REMINDER_ERRORS[error]}</span>}
      <span className={s.reminderButtons}>
        <Button type="submit" variant="primary" disabled={busy}>設定</Button>
        <Button icon="x" onClick={() => void clear()} disabled={busy || reminder === null}>解除</Button>
      </span>
    </form>
  );
}

// Labels の末尾の追加ボタン（24 の円形）。押すと入力欄が直下に開き、Enter か「追加」で足す。続けて足せるよう、足したあとも開いたままにする。
// Escape、外側のクリック、フォーカスが外へ出たとき（Tab）に閉じる。locked（アーカイブ済み）は開けない
function LabelAdder({ labels, locked, busy, change }: { labels: readonly string[]; locked: boolean; busy: boolean; change: Change }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  // ここからの保存が終わって入力欄がまた使えるようになったら、入力欄へフォーカスを戻す。ほかの項目の保存では動かさない
  useEffect(() => {
    if (busy || !refocus.current) return;
    refocus.current = false;
    input.current?.focus();
  }, [busy]);
  async function add() {
    const next = parseLabels(text, labels);
    if (next.length === 0) return setText("");
    refocus.current = true;
    if (await change({ addLabels: next })) setText("");
  }
  return (
    // 保存中は入力欄が disabled になってフォーカスを失う（relatedTarget がない）ため、行き先が枠の外にあるときだけ閉じる
    <span className={s.propMenuRoot} ref={root}
      onBlur={(e) => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
      <button type="button" ref={trigger} className={s.labelAdd} aria-label="ラベルを追加" title="ラベルを追加" aria-haspopup="dialog" aria-expanded={open}
        disabled={locked} onClick={() => setOpen(!open)}>
        <Icon name="plus" />
      </button>
      {open && (
        <div className={`${s.propPopover} ${s.labelForm}`} role="dialog" aria-label="ラベルを追加"
          onKeyDown={(e) => { if (e.key === "Escape" && !e.nativeEvent.isComposing) { e.preventDefault(); setOpen(false); trigger.current?.focus(); } }}>
          <input
            ref={input}
            disabled={busy}
            className={s.propSearch}
            aria-label="ラベルを追加"
            placeholder="ラベルを追加…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) void add();
            }}
          />
          <Button size="sm" onClick={() => void add()} disabled={busy || !hasText(text)}>
            追加
          </Button>
        </div>
      )}
    </span>
  );
}

// spec：ステータス、優先度、Workspace、Project、ラベル、担当者、作業状況、実行場所、PR。
// Workspace、作業状況、実行場所、PR は、変える API がないため表示だけにする。
// variant="inbox" は Inbox の通知詳細の右カラム（nod.pen『Inbox｜通知からの編集（#46）』）で、変えられる行とリマインダーだけを出す
export function PropertiesPanel({
  issue,
  workspaceName,
  projects,
  onUpdate,
  readOnly = false,
  reminder,
  onRemind,
  variant = "rail",
}: {
  issue: Issue;
  workspaceName: string;
  projects: { id: number; name: string }[];
  onUpdate: (input: UpdateIssueInput) => Promise<unknown>;
  readOnly?: boolean; // アーカイブ済み。値は見せるが変えられない
  reminder: IssueReminder | null;
  onRemind: RemindChange;
  variant?: "rail" | "inbox";
}) {
  const action = useAsyncAction();
  const locked = action.busy || readOnly;
  const full = variant === "rail";
  const location = executionLocation(issue.branch, issue.worktree);
  // 「Orca で作業を始める」が成功したら、押したボタンが消えるため、代わりに出る「Orca で開く」へフォーカスを移す（#210）。
  // 読み直しの描画が成功の通知より後になることもあるため、通知のときと worktree が変わったときの両方で試す
  const openInOrca = useRef<HTMLButtonElement>(null);
  const focusOpenInOrca = useRef(false);
  const moveFocusToOpenInOrca = () => {
    if (!focusOpenInOrca.current || !openInOrca.current) return;
    focusOpenInOrca.current = false;
    openInOrca.current.focus();
  };
  useEffect(moveFocusToOpenInOrca, [issue.worktree]);
  const statusNames = useStatusNames();
  const change = (input: UpdateIssueInput) => action.run(() => onUpdate(input), "変更できませんでした");
  const remind = (input: Parameters<RemindChange>[0]) =>
    action.run(() => onRemind(input), input ? "リマインダーを設定できませんでした" : "リマインダーを解除できませんでした");
  // 選択肢の一覧を読み込む前や、一覧にない Project でも、今の値を表示できるようにする
  const projectOptions = issue.project && !projects.some((p) => p.id === issue.project?.id) ? [...projects, issue.project] : projects;
  // Milestone は Issue の Project のものだけ選べる。読み込み前でも今の値を表示する
  const milestones = useMilestones();
  const projectMilestones = (milestones.data ?? []).filter((m) => m.projectId === issue.project?.id);
  const milestoneOptions =
    issue.milestone && !projectMilestones.some((m) => m.id === issue.milestone?.id) ? [...projectMilestones, issue.milestone] : projectMilestones;
  // 終了していない Cycle を選べる（Pencil「Issue詳細｜Cycle」は名前だけを出す）。一覧を読み込む前や終了した Cycle でも今の値を表示する
  const cycles = useCycles();
  const cycleOptions = unfinishedCycles(cycles.data ?? []).map((c) => ({ id: c.id, label: c.name }));
  if (issue.cycle && !cycleOptions.some((c) => c.id === issue.cycle?.id)) cycleOptions.push({ id: issue.cycle.id, label: issue.cycle.name });
  // メニューの項目。未設定は値 "" の「なし」
  const none = (icon: IconName): PropertyOption => ({ value: "", label: "なし", icon: <PropIcon name={icon} color="var(--ink3)" /> });
  const statusOptions: PropertyOption[] = statusChoices(issue.status, (status) => statusName(status, statusNames.data, issue.workspace)).map((choice) => ({
    ...choice,
    icon: <PropIcon name={STATUS_META[choice.value].icon} color={TONE_COLORS[STATUS_META[choice.value].tone].fg} />,
  }));
  const projectMenu: PropertyOption[] = [none("box"), ...projectOptions.map((p) => ({ value: String(p.id), label: p.name, icon: <PropIcon name="box" color="var(--ink3)" /> }))];
  const milestoneMenu: PropertyOption[] = [none("flag"), ...milestoneOptions.map((m) => ({ value: String(m.id), label: m.name, icon: <PropIcon name="flag" color="var(--ink2)" /> }))];
  const cycleMenu: PropertyOption[] = [none("calendar-range"), ...cycleOptions.map((c) => ({ value: String(c.id), label: c.label, icon: <PropIcon name="calendar-range" color="var(--ink2)" /> }))];
  const assigneeMenu: PropertyOption[] = [
    none("circle-user"),
    ...assigneeChoices(issue.assignee).map((assignee) => ({ value: assignee, label: assignee, icon: <span className={s.propIcon} aria-hidden="true"><AgentAvatar actor={assignee} /></span> })),
  ];

  return (
    <section className={`${full ? s.panel : s.inboxProps} ${readOnly ? s.propsLocked : ""}`} aria-label="プロパティ">
      {!full && <h3 className={s.inboxPropsTitle}>プロパティ</h3>}
      <dl className={s.props}>
        <Prop label="Status">
          <PropertyMenu label="Status" value={issue.status} options={statusOptions} disabled={locked} onChange={(value) => void change({ status: value as Status })} />
        </Prop>
        <Prop label="Priority">
          <PropertyMenu label="Priority" value={String(issue.priority)} options={PRIORITY_OPTIONS} disabled={locked} onChange={(value) => void change({ priority: Number(value) })} />
        </Prop>
        <Prop label="Estimate">
          <EstimateField key={String(issue.estimate)} estimate={issue.estimate} busy={locked} change={change} />
        </Prop>
        <Prop label="Due date">
          <DueDateField issue={issue} busy={locked} change={change} />
        </Prop>
        {full && (
          <Prop label="Workspace">
            <Static><WorkspaceBadge workspaceKey={issue.workspace} name={workspaceName} /></Static>
          </Prop>
        )}
        <Prop label="Project">
          <PropertyMenu label="Project" value={issue.project ? String(issue.project.id) : ""} options={projectMenu} disabled={locked}
            onChange={(value) => void change({ projectRef: value === "" ? null : value })} />
        </Prop>
        <Prop label="Milestone">
          <PropertyMenu label="Milestone" value={issue.milestone ? String(issue.milestone.id) : ""} options={milestoneMenu} disabled={locked || !issue.project}
            describedBy={issue.project ? undefined : `milestone-hint-${issue.id}`}
            onChange={(value) => void change({ milestoneRef: value === "" ? null : value })} />
          {!issue.project && (
            <span id={`milestone-hint-${issue.id}`} className={s.propHint}>
              Project を設定すると選べます
            </span>
          )}
        </Prop>
        <Prop label="Cycle">
          <PropertyMenu label="Cycle" value={issue.cycle ? String(issue.cycle.id) : ""} options={cycleMenu} disabled={locked}
            onChange={(value) => void change({ cycleRef: value === "" ? null : value })} />
        </Prop>
        <Prop label="Labels">
          <span className={s.propLabels}>
            {issue.labels.map((label) => (
              <LabelChip key={label} workspace={issue.workspace} name={label} className={s.propLabel}>
                <button
                  type="button"
                  className={s.labelRemove}
                  aria-label={`ラベル ${label} を外す`}
                  disabled={locked}
                  onClick={() => void change({ removeLabels: [label] })}
                >
                  <Icon name="x" size={12} />
                </button>
              </LabelChip>
            ))}
            <LabelAdder labels={issue.labels} locked={readOnly} busy={action.busy} change={change} />
          </span>
        </Prop>
        <Prop label="Assignee">
          <PropertyMenu label="Assignee" value={issue.assignee ?? ""} options={assigneeMenu} disabled={locked}
            onChange={(value) => void change({ assignee: value === "" ? null : value })} />
        </Prop>
        {full && <Prop label="作業状況"><Static>{issue.agentState ? <AgentStatePill state={issue.agentState} /> : <Empty />}</Static></Prop>}
        {full && (
          <Prop label="実行場所">
            {location ? (
              // nod.pen「Olqdi」の実行場所：高さ 28 の1行。worktree は値の列の幅で切り、ブランチと worktree の全文は title で読む
              <span className={s.locationValue}>
                <span className={`${s.propStatic} ${s.locationText}`} title={location.worktree ? `${location.branchLabel} · ${location.worktree}` : location.branchLabel}>
                  <PropIcon name="terminal" color="var(--ink2)" />
                  <span className={s.propText}>
                    {location.branchLabel}
                    {location.worktree && <span className={s.locationPath}> · {location.worktree}</span>}
                  </span>
                </span>
                {issue.worktree && <OpenInOrcaButton issueId={issue.id} buttonRef={openInOrca} />}
              </span>
            ) : (
              // 実行場所が未記録（worktree もブランチも無い）のときだけ、値の位置に「Orca で作業を始める」を出す（#210、nod.pen「PHJ9L」）
              <StartInOrcaButton issueId={issue.id} workspaceKey={issue.workspace} title={issue.title} disabled={readOnly}
                onCreated={() => { focusOpenInOrca.current = true; moveFocusToOpenInOrca(); }} />
            )}
          </Prop>
        )}
        {full && (
          <div className={s.prGroup}>
            <dt className={s.propKey}>PR</dt>
            <dd className={s.propValue}>
              <Static>
                {issue.prUrl ? (
                  <a href={issue.prUrl} target="_blank" rel="noreferrer" className={`${s.link} ${s.propText}`}>
                    {prLabel(issue.prUrl)}
                  </a>
                ) : (
                  <Empty />
                )}
              </Static>
            </dd>
            {issue.prUrl && (
              <dd className={s.prStatusCell}>
                <PrStatusSection issueId={issue.id} />
              </dd>
            )}
          </div>
        )}
        <Prop label="Reminder">
          <ReminderField key={`${reminder?.remindAt}:${reminder?.note}`} reminder={reminder} busy={action.busy} archived={readOnly} change={remind} />
        </Prop>
        {full && <Prop label="Created"><Static><span className={`${s.propText} ${s.propQuiet}`} title={issue.createdAt}>{attachmentDate(issue.createdAt)} · {issue.createdBy}</span></Static></Prop>}
      </dl>
      {action.error && (
        <p className={`${s.error} ${s.panelError}`} role="alert">
          {action.error}
        </p>
      )}
    </section>
  );
}

const RELATION_LABELS: [keyof Relations, string][] = [
  ["blocks", "Blocks"],
  ["blockedBy", "Blocked by"],
  ["related", "Related"],
  ["duplicateOf", "Duplicate of"],
  ["duplicates", "Duplicates"],
];

// design/nod.pen「12 Issue 詳細｜関係の状態」。相手の状態の印（アーカイブ済み・完了・キャンセル）を ID の後ろに添え、ID を淡色にする（#203）
export function RelationsPanel({ relations, relationStates }: { relations: Relations; relationStates: Record<string, RelationState> }) {
  const entries = RELATION_LABELS.filter(([key]) => relations[key].length > 0);
  return (
    <section className={s.panel} aria-label="関連 Issue">
      <h2 className={s.panelHeading}>関連 Issue</h2>
      {entries.length === 0 ? (
        <p className={s.panelEmpty}>関連 Issue はありません</p>
      ) : (
        <dl className={s.props}>
          {entries.map(([key, label]) => (
            <Prop key={key} label={label}>
              <span className={s.propLinks}>
                {relations[key].map((id) => {
                  const mark = relationMark(key, relationStates[id]);
                  return (
                    <span key={id} className={s.relation}>
                      <Link to="/issues/$issueId" params={{ issueId: id }} className={mark ? s.relationClosed : s.link}>
                        {id}
                      </Link>
                      {mark && <span className={s.relationMark}>{mark}</span>}
                    </span>
                  );
                })}
              </span>
            </Prop>
          ))}
        </dl>
      )}
    </section>
  );
}
