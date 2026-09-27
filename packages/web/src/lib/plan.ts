import type { Plan } from "../api/types";

export function planProgress(plan: Plan): { done: number; total: number } {
  return {
    done: plan.tasks.filter((t) => t.status === "done" || t.status === "skipped").length,
    total: plan.tasks.length,
  };
}

// spec：計画は Task と、開いた Task の Step を見せる。最初は作業中の Task を開いておく。
export function initialOpenTask(plan: Plan): number | null {
  const doing = plan.tasks.findIndex((t) => t.status === "doing");
  if (doing >= 0) return doing;
  const pending = plan.tasks.findIndex((t) => t.status === "pending");
  return pending >= 0 ? pending : null;
}
