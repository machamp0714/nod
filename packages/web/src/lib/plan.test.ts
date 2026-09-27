import { describe, expect, test } from "bun:test";
import type { Plan, StepStatus } from "../api/types";
import { initialOpenTask, planProgress } from "./plan";

const plan = (...statuses: StepStatus[]): Plan => ({ source: null, tasks: statuses.map((status, i) => ({ title: `T${i}`, status, steps: [] })) });

describe("planProgress", () => {
  test("done と skipped の Task を終わったものとして数える", () => {
    expect(planProgress(plan("done", "skipped", "doing", "pending"))).toEqual({ done: 2, total: 4 });
    expect(planProgress(plan())).toEqual({ done: 0, total: 0 });
  });
});

describe("initialOpenTask", () => {
  test("作業中の Task、なければ最初の未着手の Task を開く", () => {
    expect(initialOpenTask(plan("done", "doing", "pending"))).toBe(1);
    expect(initialOpenTask(plan("done", "pending", "pending"))).toBe(1);
    expect(initialOpenTask(plan("done", "done"))).toBeNull();
    expect(initialOpenTask(plan())).toBeNull();
  });
});
