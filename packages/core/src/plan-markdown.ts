import type { PlanStep, PlanTask, StepStatus } from "./types";

export function rollup(steps: PlanStep[], fallback: StepStatus): StepStatus {
  if (steps.length === 0) return fallback;
  if (steps.every((s) => s.status === "done" || s.status === "skipped")) return "done";
  if (steps.some((s) => s.status !== "pending")) return "doing";
  return "pending";
}

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const TASK_RE = /^###\s+Task\s+\d+\s*[:：]\s*(.+?)\s*$/;
const STEP_RE = /^\s*-\s+\[([ xX])\]\s+\*\*(?:Step\s+\d+\s*[:：]\s*)?(.+?)\*\*/;

// writing-plans の実装計画書から「### Task N: ...」と「- [ ] **Step N: ...**」を読む
export function parsePlanMarkdown(md: string): PlanTask[] {
  const tasks: PlanTask[] = [];
  let fence: string | null = null;
  for (const line of md.split(/\r?\n/)) {
    const f = FENCE_RE.exec(line);
    if (f?.[1]) {
      const mark = f[1];
      if (fence === null) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length && line.trim() === mark) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const task = TASK_RE.exec(line);
    if (task?.[1]) {
      tasks.push({ title: task[1], status: "pending", steps: [] });
      continue;
    }
    const step = STEP_RE.exec(line);
    const current = tasks.at(-1);
    if (step?.[2] && current) {
      current.steps.push({ title: step[2], status: step[1] === " " ? "pending" : "done" });
    }
  }
  return tasks.map((t) => ({ ...t, status: rollup(t.steps, t.status) }));
}
