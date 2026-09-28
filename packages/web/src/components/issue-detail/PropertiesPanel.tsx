import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import type { Issue, Relations, Status, UpdateIssueInput } from "../../api/types";
import { prLabel } from "../../lib/format";
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

// spec：ステータス、優先度、Workspace、Project、ラベル、担当者、作業状況、実行場所、PR。
// Workspace、作業状況、実行場所、PR は、変える API がないため表示だけにする。
export function PropertiesPanel({
  issue,
  workspaceName,
  projects,
  onUpdate,
}: {
  issue: Issue;
  workspaceName: string;
  projects: { id: number; name: string }[];
  onUpdate: (input: UpdateIssueInput) => Promise<unknown>;
}) {
  const action = useAsyncAction();
  const [labelText, setLabelText] = useState("");
  const change = (input: UpdateIssueInput) => action.run(() => onUpdate(input), "変更できませんでした");
  // 選択肢の一覧を読み込む前や、一覧にない Project でも、今の値を表示できるようにする
  const projectOptions = issue.project && !projects.some((p) => p.id === issue.project?.id) ? [...projects, issue.project] : projects;

  async function addLabels() {
    const labels = parseLabels(labelText, issue.labels);
    if (labels.length === 0 || (await change({ addLabels: labels }))) setLabelText("");
  }

  return (
    <section className={s.panel} aria-label="プロパティ">
      <dl className={s.props}>
        <Prop label="Status">
          <StatusIcon status={issue.status} />
          <select
            className={s.select}
            aria-label="Status"
            value={issue.status}
            disabled={action.busy}
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
            disabled={action.busy}
            onChange={(e) => void change({ priority: Number(e.target.value) })}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={String(p)}>
                {priorityMeta(p).label}
              </option>
            ))}
          </select>
        </Prop>
        <Prop label="Workspace">
          <WorkspaceBadge workspaceKey={issue.workspace} name={workspaceName} />
        </Prop>
        <Prop label="Project">
          <select
            className={s.select}
            aria-label="Project"
            value={issue.project ? String(issue.project.id) : ""}
            disabled={action.busy}
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
                disabled={action.busy}
                onClick={() => void change({ removeLabels: [label] })}
              >
                <Icon name="x" size={12} />
              </button>
            </Pill>
          ))}
          <span className={s.labelForm}>
            <input
              className={s.input}
              aria-label="ラベルを追加"
              placeholder="ラベルを追加"
              value={labelText}
              onChange={(e) => setLabelText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) void addLabels();
              }}
            />
            <Button onClick={() => void addLabels()} disabled={action.busy || !hasText(labelText)}>
              追加
            </Button>
          </span>
        </Prop>
        <Prop label="Assignee">
          <select
            className={s.select}
            aria-label="Assignee"
            value={issue.assignee ?? ""}
            disabled={action.busy}
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
          {issue.branch ? (
            <span className={s.inline} title={issue.worktree ?? undefined}>
              <Icon name="terminal" />
              {issue.branch}
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
