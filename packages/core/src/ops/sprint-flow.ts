import { tx } from "../db";
import type { OpCtx } from "../ctx";
import { NodError } from "../errors";
import type { ProjectFlow } from "../types";
import type { SprintClock } from "../sprint-types";
import { getSprint } from "./sprints";
import { getIssueDependencyFlow } from "./projects";
import { getSprintIssueEligibility, type SprintIssueEligibility } from "./sprint-eligibility";

export interface SprintFlow extends Pick<ProjectFlow, "nodes" | "edges"> {
  sprintId: string; sprintVersion: number; planId: string | null; planHash: string | null; revision: number | null;
  mode: "planned" | "adopted"; selectedCount: number; missingItems: string[]; observedAt: string;
  eligibility: SprintIssueEligibility[];
}
// 読取だけの投影。開始後のplan指定は採用中の合意済み版へ固定し、未合意追加を混ぜない。
export function getSprintFlow(ctx: OpCtx, ref: string, planId?: string, clock: SprintClock = {}): SprintFlow {
  return tx(ctx.db, () => {
    const sprint = getSprint(ctx.db, ref);
    if (sprint.phase === "imported") throw new NodError("INVALID_STATE", "移行履歴には合意済みの計画フローがありません");
    const instant = clock.now ?? new Date();
    if (!Number.isFinite(instant.getTime())) throw new NodError("INVALID_ARGS", "時計の時刻が不正です");
    const started = sprint.activatedAt !== null;
    const targetId = started ? sprint.adoptedPlanId : planId ?? sprint.plans.at(-1)?.id;
    const target = sprint.plans.find(p => p.id === targetId);
    if (!started && planId && !target) throw new NodError("NOT_FOUND", "対象Sprintに計画がありません");
    const plan = target && (!started || (target.agreedBy === "me" && target.agreedAt && target.agreedHash === target.contentHash)) ? target : undefined;
    const selectedIds = new Set(plan?.content.items.map(item => item.itemId) ?? []);
    const selected = sprint.items.filter(item => selectedIds.has(item.id));
    const ids = selected.flatMap(item => item.issueId === null ? [] : [item.issueId]);
    const flow = getIssueDependencyFlow(ctx.db, ids.length ? `SELECT id FROM issues WHERE id IN (${ids.map(() => "?").join(",")}) AND archived_at IS NULL` : "SELECT id FROM issues WHERE 0", ids, false, instant.toISOString());
    const visible = new Set(flow.nodes.filter(n => !n.external).map(n => n.id));
    const eligibility = started ? selected.map(item => getSprintIssueEligibility(ctx, sprint.id, item.id, clock)) : [];
    const nodes = flow.nodes.map(node => node.external || !started ? node : { ...node, ready: eligibility.some(item => item.issueId === node.id && item.eligible) });
    return { ...flow, nodes, sprintId: sprint.id, sprintVersion: sprint.version, planId: plan?.id ?? null, planHash: plan?.contentHash ?? null, revision: plan?.revision ?? null,
      mode: started ? "adopted" : "planned", selectedCount: selectedIds.size, missingItems: selected.filter(item => !visible.has(item.sourceIssueKey)).map(item => item.sourceIssueKey), observedAt: instant.toISOString(),
      eligibility };
  });
}
