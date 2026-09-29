import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import type { Issue, Relations, Status, UpdateIssueInput } from "../../api/types";
import { attachmentDate } from "./DocumentsSection";
import { prLabel } from "../../lib/format";
import { formatDueDate, formatEstimate, isOverdue, isValidDueDateInput, localToday, MIN_DUE_DATE, parseEstimateInput } from "../../lib/due-date";
import { executionLocation } from "../../lib/execution-location";
import { assigneeChoices, hasText, parseLabels, statusChoices } from "../../lib/issue-edit";
import { priorityMeta } from "../../lib/meta";
import { AgentStatePill, Button, Icon, Pill, StatusIcon, WorkspaceBadge } from "../ui";
import s from "./issue-detail.module.css";
import { useAsyncAction } from "./useAsyncAction";

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={s.prop}>
      <dt className={s.propKey}>{label}</dt>
      <dd className={s.propValue}>{children}</dd>
    </div>
  );
}

function Empty() {
  return <span className={s.muted}>—</span>;
}

const PRIORITIES = [0, 1, 2, 3, 4];

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
        <Icon name="gauge" color={label ? "var(--ink2)" : "var(--ink3)"} />
        {label ?? <Empty />}
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
        <Icon name="calendar" color={overdue ? "var(--fail)" : label ? "var(--ink2)" : "var(--ink3)"} />
        {label ? <span className={overdue ? s.overdue : undefined} title={issue.dueDate ?? undefined}>{label}</span> : <Empty />}
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
        className={s.input}
        aria-label="Due date"
        aria-invalid={invalid || undefined}
        min={MIN_DUE_DATE}
        max="9999-12-31"
        value={draft}
        disabled={busy}
        onChange={(e) => { setDraft(e.target.value); setInvalid(false); }}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void commit(); }}
      />
      <Button icon="x" onClick={() => void set(null)} disabled={busy || issue.dueDate === null}>
        解除
      </Button>
      {invalid && <span className={s.fieldError} role="alert">{MIN_DUE_DATE} 以降の日付を入力してください</span>}
    </span>
  );
}

// spec：ステータス、優先度、Workspace、Project、ラベル、担当者、作業状況、実行場所、PR。
// Workspace、作業状況、実行場所、PR は、変える API がないため表示だけにする。
export function PropertiesPanel({
  issue,
  workspaceName,
  projects,
  onUpdate,
  readOnly = false,
}: {
  issue: Issue;
  workspaceName: string;
  projects: { id: number; name: string }[];
  onUpdate: (input: UpdateIssueInput) => Promise<unknown>;
  readOnly?: boolean; // アーカイブ済み。値は見せるが変えられない
}) {
  const action = useAsyncAction();
  const locked = action.busy || readOnly;
  const location = executionLocation(issue.branch, issue.worktree);
  const [labelText, setLabelText] = useState("");
  const change = (input: UpdateIssueInput) => action.run(() => onUpdate(input), "変更できませんでした");
  // 選択肢の一覧を読み込む前や、一覧にない Project でも、今の値を表示できるようにする
  const projectOptions = issue.project && !projects.some((p) => p.id === issue.project?.id) ? [...projects, issue.project] : projects;

  async function addLabels() {
    const labels = parseLabels(labelText, issue.labels);
    if (labels.length === 0 || (await change({ addLabels: labels }))) setLabelText("");
  }

  return (
    <section className={`${s.panel} ${readOnly ? s.propsLocked : ""}`} aria-label="プロパティ">
      <dl className={s.props}>
        <Prop label="Status">
          <StatusIcon status={issue.status} />
          <select
            className={s.select}
            aria-label="Status"
            value={issue.status}
            disabled={locked}
            onChange={(e) => void change({ status: e.target.value as Status })}
          >
            {statusChoices(issue.status).map((choice) => (
              <option key={choice.value} value={choice.value} disabled={choice.disabled}>
                {choice.label}
              </option>
            ))}
          </select>
        </Prop>
        <Prop label="Priority">
          <select
            className={s.select}
            aria-label="Priority"
            value={String(issue.priority)}
            disabled={locked}
            onChange={(e) => void change({ priority: Number(e.target.value) })}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={String(p)}>
                {priorityMeta(p).label}
              </option>
            ))}
          </select>
        </Prop>
        <Prop label="Estimate">
          <EstimateField key={String(issue.estimate)} estimate={issue.estimate} busy={locked} change={change} />
        </Prop>
        <Prop label="Due date">
          <DueDateField issue={issue} busy={locked} change={change} />
        </Prop>
        <Prop label="Workspace">
          <WorkspaceBadge workspaceKey={issue.workspace} name={workspaceName} />
        </Prop>
        <Prop label="Project">
          <select
            className={s.select}
            aria-label="Project"
            value={issue.project ? String(issue.project.id) : ""}
            disabled={locked}
            onChange={(e) => void change({ projectRef: e.target.value === "" ? null : e.target.value })}
          >
            <option value="">なし</option>
            {projectOptions.map((p) => (
              <option key={p.id} value={String(p.id)}>
                {p.name}
              </option>
            ))}
          </select>
        </Prop>
        <Prop label="Labels">
          {issue.labels.map((label) => (
            <Pill key={label} tone="muted" icon="tag">
              {label}
              <button
                type="button"
                className={s.labelRemove}
                aria-label={`ラベル ${label} を外す`}
                disabled={locked}
                onClick={() => void change({ removeLabels: [label] })}
              >
                <Icon name="x" size={12} />
              </button>
            </Pill>
          ))}
          <span className={s.labelForm}>
            <input
              disabled={locked}
              className={s.input}
              aria-label="ラベルを追加"
              placeholder="ラベルを追加"
              value={labelText}
              onChange={(e) => setLabelText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) void addLabels();
              }}
            />
            <Button onClick={() => void addLabels()} disabled={locked || !hasText(labelText)}>
              追加
            </Button>
          </span>
        </Prop>
        <Prop label="Assignee">
          <select
            className={s.select}
            aria-label="Assignee"
            value={issue.assignee ?? ""}
            disabled={locked}
            onChange={(e) => void change({ assignee: e.target.value === "" ? null : e.target.value })}
          >
            <option value="">なし</option>
            {assigneeChoices(issue.assignee).map((assignee) => (
              <option key={assignee} value={assignee}>
                {assignee}
              </option>
            ))}
          </select>
        </Prop>
        <Prop label="作業状況">{issue.agentState ? <AgentStatePill state={issue.agentState} /> : <Empty />}</Prop>
        <Prop label="実行場所">
          {location ? (
            <span className={s.inline} title={issue.worktree ?? undefined}>
              <Icon name="terminal" />
              <span className={s.executionLocation}>
                {location.branchLabel}
                {location.worktree && <span>{location.worktree}</span>}
              </span>
            </span>
          ) : (
            <Empty />
          )}
        </Prop>
        <Prop label="PR">
          {issue.prUrl ? (
            <a href={issue.prUrl} target="_blank" rel="noreferrer" className={s.link}>
              {prLabel(issue.prUrl)}
            </a>
          ) : (
            <Empty />
          )}
        </Prop>
        <Prop label="Created"><span title={issue.createdAt}>{attachmentDate(issue.createdAt)} · {issue.createdBy}</span></Prop>
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

export function RelationsPanel({ relations }: { relations: Relations }) {
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
              {relations[key].map((id) => (
                <Link key={id} to="/issues/$issueId" params={{ issueId: id }} className={s.link}>
                  {id}
                </Link>
              ))}
            </Prop>
          ))}
        </dl>
      )}
    </section>
  );
}
