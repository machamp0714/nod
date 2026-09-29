import type { ReactNode } from "react";
import type { AgentState } from "../../api/types";
import { AGENT_STATE_META, TONE_COLORS } from "../../lib/meta";
import s from "./issue-list.module.css";

// design/nod.pen「Issues｜委任中タブ（#53）」の作業状況の pill：6px の丸 dot、角丸10px、余白上下2px/左右7px、11px/500
export function AgentStateDot({ state, children }: { state: AgentState; children?: ReactNode }) {
  const color = TONE_COLORS[AGENT_STATE_META[state].tone];
  return (
    <span className={s.agentDot} style={{ color: color.fg, background: color.bg }}>
      <span className={s.agentDotMark} style={{ background: color.fg }} aria-hidden="true" />
      {children ?? AGENT_STATE_META[state].label}
    </span>
  );
}
