import { now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError } from "../errors";
import { recordEvent } from "../events";
import { findWritableIssueRow, type IssueRow, loadPlan } from "../issue-query";
import { setColumn } from "../mutate";
import { parsePlanMarkdown, rollup } from "../plan-markdown";
import type { Plan, PlanStep, PlanTask, StepStatus } from "../types";
import { linkDocument, readDocumentFile } from "./documents";

function replacePlan(ctx: OpCtx, row: IssueRow, tasks: PlanTask[], source: string | null): void {
  ctx.db.query("DELETE FROM plan_tasks WHERE issue_id = ?").run(row.id);
  const insertTask = ctx.db.query("INSERT INTO plan_tasks (issue_id, position, title, status) VALUES (?, ?, ?, ?)");
  const insertStep = ctx.db.query("INSERT INTO plan_steps (task_id, position, title, status) VALUES (?, ?, ?, ?)");
  tasks.forEach((t, i) => {
    const taskId = Number(insertTask.run(row.id, i + 1, t.title, t.status).lastInsertRowid);
    t.steps.forEach((s, j) => insertStep.run(taskId, j + 1, s.title, s.status));
  });
  setColumn(ctx, row, "plan_source", source);
  ctx.db.query("UPDATE issues SET updated_at = ? WHERE id = ?").run(now(), row.id);
  recordEvent(ctx.db, row.id, ctx.actor, "plan_updated", { source, tasks: tasks.length });
}

export function importPlan(ctx: OpCtx, ref: string, path: string, cwd?: string): Plan {
  const { abs, content } = readDocumentFile(path, cwd);
  const tasks = parsePlanMarkdown(content);
  if (tasks.length === 0) throw new NodError("NO_TASKS", `${abs} に「### Task N: ...」の見出しがありません`);
  return tx(ctx.db, () => {
    const row = findWritableIssueRow(ctx.db, ref);
    replacePlan(ctx, row, tasks, abs);
    linkDocument(ctx, { issue: row }, { path: abs, content, kind: "plan" });
    return loadPlan(ctx.db, row.id, row.plan_source);
  });
}

export function setPlanTasks(ctx: OpCtx, ref: string, titles: string[]): Plan {
  if (titles.length === 0 || titles.some((t) => !t.trim())) {
    throw new NodError("INVALID_ARGS", "--step で Task のタイトルを1つ以上指定してください");
  }
  return tx(ctx.db, () => {
    const row = findWritableIssueRow(ctx.db, ref);
    replacePlan(ctx, row, titles.map((title) => ({ title, status: "pending", steps: [] })), null);
    return loadPlan(ctx.db, row.id, row.plan_source);
  });
}

export function setStep(ctx: OpCtx, ref: string, stepRef: string, status: StepStatus): Plan {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(stepRef);
  if (!m) throw new NodError("INVALID_STEP", `${stepRef} は Task 番号（例: 2）か Task.Step 番号（例: 2.3）ではありません`);
  return tx(ctx.db, () => {
    const row = findWritableIssueRow(ctx.db, ref);
    const task = ctx.db
      .query("SELECT id, status FROM plan_tasks WHERE issue_id = ? AND position = ?")
      .get(row.id, Number(m[1])) as { id: number; status: StepStatus } | null;
    if (!task) {
      const n = (ctx.db.query("SELECT count(*) AS n FROM plan_tasks WHERE issue_id = ?").get(row.id) as { n: number }).n;
      throw new NodError("INVALID_STEP", `Task ${m[1]} はありません（計画の Task は ${n} 件）`);
    }
    if (m[2]) {
      const { changes } = ctx.db
        .query("UPDATE plan_steps SET status = ? WHERE task_id = ? AND position = ?")
        .run(status, task.id, Number(m[2]));
      if (changes === 0) throw new NodError("INVALID_STEP", `Task ${m[1]} に Step ${m[2]} はありません`);
      const steps = ctx.db.query("SELECT title, status FROM plan_steps WHERE task_id = ? ORDER BY position").all(task.id) as PlanStep[];
      ctx.db.query("UPDATE plan_tasks SET status = ? WHERE id = ?").run(rollup(steps, task.status), task.id);
    } else {
      ctx.db.query("UPDATE plan_tasks SET status = ? WHERE id = ?").run(status, task.id);
    }
    ctx.db.query("UPDATE issues SET updated_at = ? WHERE id = ?").run(now(), row.id);
    recordEvent(ctx.db, row.id, ctx.actor, "plan_updated", { ref: stepRef, status });
    return loadPlan(ctx.db, row.id, row.plan_source);
  });
}
