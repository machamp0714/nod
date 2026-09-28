import { useState } from "react";
import type { Plan, StepStatus } from "../../api/types";
import { STEP_META, TONE_COLORS } from "../../lib/meta";
import { initialOpenTask, planProgress } from "../../lib/plan";
import { Icon, ProgressBar } from "../ui";
import s from "./issue-detail.module.css";

function StepIcon({ status }: { status: StepStatus }) {
  const meta = STEP_META[status];
  return (
    <span title={meta.label}>
      <Icon name={meta.icon} color={TONE_COLORS[meta.tone].fg} />
    </span>
  );
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

// spec：計画は Task と、開いた Task の Step を見せる。
export function PlanSection({ plan }: { plan: Plan }) {
  const [open, setOpen] = useState<number | null>(() => initialOpenTask(plan));
  const progress = planProgress(plan);
  return (
    <section className={s.section} aria-label="計画">
      <header className={s.sectionHead}>
        <h2 className={s.sectionTitle}>計画</h2>
        {plan.source && (
          <span className={s.source} title={plan.source}>
            <Icon name="file-text" size={12} />
            {basename(plan.source)}
          </span>
        )}
        <span className={s.spacer} />
        {plan.tasks.length > 0 && (
          <>
            <span className={s.meta}>
              Task {progress.done} / {progress.total}
            </span>
            <ProgressBar value={progress.done} max={progress.total} tone="ready" />
          </>
        )}
      </header>
      {plan.tasks.length === 0 ? (
        <p className={s.muted}>計画はありません</p>
      ) : (
        <ol className={s.tasks}>
          {plan.tasks.map((task, index) => {
            const expanded = open === index;
            const doneSteps = task.steps.filter((step) => step.status === "done").length;
            return (
              <li key={`${index}-${task.title}`} className={s.task}>
                <button type="button" className={s.taskRow} aria-expanded={expanded} onClick={() => setOpen(expanded ? null : index)}>
                  <span className={s.taskNumber}>{index + 1}</span>
                  <StepIcon status={task.status} />
                  <span className={s.taskTitle}>{task.title}</span>
                  <span className={s.meta}>
                    {doneSteps}/{task.steps.length}
                  </span>
                  <Icon name="chevron-right" />
                </button>
                {expanded && task.steps.length > 0 && (
                  <ol className={s.steps}>
                    {task.steps.map((step, stepIndex) => (
                      <li key={`${stepIndex}-${step.title}`} className={s.step}>
                        <StepIcon status={step.status} />
                        <span className={s.stepNumber}>
                          {index + 1}.{stepIndex + 1}
                        </span>
                        <span>{step.title}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
