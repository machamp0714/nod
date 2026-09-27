import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { Issue, Relations } from "../../api/types";
import { prLabel } from "../../lib/format";
import { AgentAvatar, AgentStatePill, Icon, Pill, PriorityLabel, StatusLabel, WorkspaceBadge } from "../ui";
import s from "./issue-detail.module.css";

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

// spec：ステータス、優先度、Workspace、Project、ラベル、担当者、作業状況、実行場所、PR。編集は G でつなぐ。
export function PropertiesPanel({ issue, workspaceName }: { issue: Issue; workspaceName: string }) {
  return (
    <section className={s.panel} aria-label="プロパティ">
      <dl className={s.props}>
        <Prop label="Status">
          <StatusLabel status={issue.status} />
        </Prop>
        <Prop label="Priority">
          <PriorityLabel priority={issue.priority} />
        </Prop>
        <Prop label="Workspace">
          <WorkspaceBadge workspaceKey={issue.workspace} name={workspaceName} />
        </Prop>
        <Prop label="Project">
          {issue.project ? (
            <Link to="/projects/$projectId" params={{ projectId: String(issue.project.id) }} className={s.link}>
              {issue.project.name}
            </Link>
          ) : (
            <Empty />
          )}
        </Prop>
        <Prop label="Labels">
          {issue.labels.length > 0 ? (
            issue.labels.map((label) => (
              <Pill key={label} tone="muted" icon="tag">
                {label}
              </Pill>
            ))
          ) : (
            <Empty />
          )}
        </Prop>
        <Prop label="Assignee">
          {issue.assignee ? (
            <span className={s.inline}>
              <AgentAvatar actor={issue.assignee} />
              {issue.assignee}
            </span>
          ) : (
            <Empty />
          )}
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
