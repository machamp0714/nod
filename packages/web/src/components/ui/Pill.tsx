import type { ReactNode } from "react";
import type { AgentState, Status } from "../../api/types";
import { useStatusNames } from "../../api/hooks/workspace-labels";
import { AGENT_STATE_META, priorityMeta, STATUS_META, type Tone, TONE_COLORS } from "../../lib/meta";
import { statusName } from "../../lib/workspace-labels";
import { Icon, type IconName } from "./Icon";
import s from "./ui.module.css";

export function Pill({ tone, icon, children }: { tone: Tone; icon?: IconName; children: ReactNode }) {
  const color = TONE_COLORS[tone];
  return (
    <span className={s.pill} style={{ color: color.fg, background: color.bg }}>
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

export function StatusIcon({ status, size = 14 }: { status: Status; size?: number }) {
  const meta = STATUS_META[status];
  return <Icon name={meta.icon} size={size} color={TONE_COLORS[meta.tone].fg} />;
}

// workspace を渡すと、その Workspace で設定した表示名を出す
export function StatusLabel({ status, workspace }: { status: Status; workspace?: string }) {
  const names = useStatusNames();
  return (
    <span className={s.inline}>
      <StatusIcon status={status} />
      <span className={s.inlineText}>{statusName(status, names.data, workspace)}</span>
    </span>
  );
}

export function AgentStatePill({ state }: { state: AgentState }) {
  const meta = AGENT_STATE_META[state];
  return (
    <Pill tone={meta.tone} icon={meta.icon}>
      {meta.label}
    </Pill>
  );
}

export function PriorityLabel({ priority }: { priority: number }) {
  const meta = priorityMeta(priority);
  return (
    <span className={s.inline}>
      <Icon name={meta.icon} color={TONE_COLORS[meta.tone].fg} />
      <span className={s.inlineText}>{meta.label}</span>
    </span>
  );
}
