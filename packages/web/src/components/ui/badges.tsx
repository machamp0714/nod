import { useWorkspaces } from "../../api/hooks/shared";
import { agentColor, agentInitial } from "../../lib/color";
import { workspaceColorOf } from "../../lib/workspace-color";
import { formatQuestionCount, type QuestionCount } from "../../lib/format";
import { type Tone, TONE_COLORS } from "../../lib/meta";
import s from "./ui.module.css";

export function WorkspaceBadge({ workspaceKey, name }: { workspaceKey: string; name?: string }) {
  const workspaces = useWorkspaces();
  const color = workspaceColorOf(workspaces.data, workspaceKey);
  const state = color ? "ready" : workspaces.isPending ? "pending" : workspaces.isError ? "error" : "missing";
  return (
    <span
      className={s.inline}
      title={state === "error" ? `${workspaceKey}（Workspace の色を取得できません）` : workspaceKey}
      data-workspace-key={workspaceKey}
      data-workspace-color-state={state}
    >
      <span className={s.swatch} style={{ background: color ?? "transparent" }} />
      <span className={s.inlineText}>{name ?? workspaceKey}</span>
    </span>
  );
}

export function AgentAvatar({ actor, size = 18 }: { actor: string; size?: number }) {
  return (
    <span className={s.avatar} style={{ width: size, height: size, background: agentColor(actor) }} title={actor}>
      {agentInitial(actor)}
    </span>
  );
}

export function QuestionProgress({ count }: { count: QuestionCount }) {
  const open = count.decided < count.total;
  return (
    <span className={s.mono} style={{ color: open ? "var(--ask)" : "var(--ink3)" }}>
      {formatQuestionCount(count)}
    </span>
  );
}

export function ProgressBar({
  value,
  max,
  tone = "accent",
  width = 120,
}: {
  value: number;
  max: number;
  tone?: Tone;
  width?: number | string;
}) {
  const ratio = max === 0 ? 0 : Math.min(value / max, 1);
  return (
    <span className={s.bar} style={{ width }} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <span className={s.barFill} style={{ display: "block", width: `${ratio * 100}%`, background: TONE_COLORS[tone].fg }} />
    </span>
  );
}
