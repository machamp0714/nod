import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { formatRelative } from "../../lib/format";
import { AgentAvatar, WorkspaceBadge } from "../ui";
import s from "./split.module.css";

export function QueueItem({
  to,
  tab,
  issueId,
  title,
  actor,
  at,
  body,
  workspaceKey,
  workspaceName,
  selected,
}: {
  to: "/inbox" | "/reviews" | "/triage";
  tab?: "questions" | "all";
  issueId: string;
  title: string;
  actor: string;
  at: string;
  body?: string;
  workspaceKey: string;
  workspaceName: string;
  selected: boolean;
}) {
  return (
    <Link to={to} search={{ selected: issueId, ...(to === "/inbox" ? { tab } : {}) }} className={s.item} data-selected={selected}>
      <div className={s.itemHead}>
        <AgentAvatar actor={actor} />
        <span className={s.itemTitle}>{title}</span>
        <span className={s.itemTime}>{formatRelative(at)}</span>
      </div>
      {body && <p className={s.itemBody}>{body}</p>}
      <div className={s.itemMeta}>
        <WorkspaceBadge workspaceKey={workspaceKey} name={workspaceName} />
        <span className={s.itemId}>{issueId}</span>
      </div>
    </Link>
  );
}

export function QueueEmpty({ children }: { children: ReactNode }) {
  return <p className={s.empty}>{children}</p>;
}
