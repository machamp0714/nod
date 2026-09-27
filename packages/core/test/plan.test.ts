import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIssue, getIssue } from "../src/ops/issues";
import { importPlan, setPlanTasks, setStep } from "../src/ops/plan";
import { codeOf, eventsOf, setup } from "./helpers";

function planFile(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "nod-plan-")), "plan.md");
  writeFileSync(path, content);
  return path;
}

describe("importPlan", () => {
  test("計画書を取り込み、Document として添付し、取り込み直すと置き換える", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const path = planFile("# 検索の実装計画\n\n### Task 1: 調べる\n\n- [ ] **Step 1: 読む**\n- [ ] **Step 2: 書く**\n");
    const plan = importPlan(llm, i.id, path);
    expect(plan).toEqual({
      source: path,
      tasks: [
        {
          title: "調べる",
          status: "pending",
          steps: [
            { title: "読む", status: "pending" },
            { title: "書く", status: "pending" },
          ],
        },
      ],
    });
    expect(getIssue(db, i.id).documents).toEqual([expect.objectContaining({ path, title: "検索の実装計画", kind: "plan" })]);

    writeFileSync(path, "# 検索の実装計画\n\n### Task 1: 調べる\n\n### Task 2: 直す\n");
    expect(importPlan(llm, i.id, path).tasks.map((t) => t.title)).toEqual(["調べる", "直す"]);
    expect((db.query("SELECT count(*) AS n FROM plan_tasks").get() as { n: number }).n).toBe(2);
    expect((db.query("SELECT count(*) AS n FROM plan_steps").get() as { n: number }).n).toBe(0);
    expect(getIssue(db, i.id).documents).toHaveLength(1);
    expect(eventsOf(db, i.id).filter((e) => e.type === "plan_updated").map((e) => e.data)).toEqual([
      { source: path, tasks: 1 },
      { source: path, tasks: 2 },
    ]);
  });

  test("Task 見出しがなければ NO_TASKS、ファイルがなければ FILE_NOT_FOUND", () => {
    const { ws, me } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    expect(codeOf(() => importPlan(me, i.id, planFile("# 見出しだけ\n")))).toBe("NO_TASKS");
    expect(codeOf(() => importPlan(me, i.id, "/nope/plan.md"))).toBe("FILE_NOT_FOUND");
  });
});

describe("setPlanTasks と setStep", () => {
  test("手で Task だけの計画を作り、状態を更新する", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    setPlanTasks(llm, i.id, ["調査", "実装"]);
    const plan = setStep(llm, i.id, "1", "done");
    expect(plan.source).toBeNull();
    expect(plan.tasks.map((t) => [t.title, t.status])).toEqual([
      ["調査", "done"],
      ["実装", "pending"],
    ]);
    expect(eventsOf(db, i.id).at(-1)).toMatchObject({ type: "plan_updated", data: { ref: "1", status: "done" } });
    expect(codeOf(() => setPlanTasks(llm, i.id, []))).toBe("INVALID_ARGS");
  });

  test("Step を更新すると Task の状態が揃う", () => {
    const { ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    importPlan(llm, i.id, planFile("### Task 1: 調べる\n\n- [ ] **Step 1: 読む**\n- [ ] **Step 2: 書く**\n"));
    expect(setStep(llm, i.id, "1.1", "done").tasks[0]?.status).toBe("doing");
    expect(setStep(llm, i.id, "1.2", "skipped").tasks[0]?.status).toBe("done");
  });

  test("存在しない Task や Step、形式の違う指定は INVALID_STEP", () => {
    const { ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    setPlanTasks(llm, i.id, ["a"]);
    expect(codeOf(() => setStep(llm, i.id, "2", "done"))).toBe("INVALID_STEP");
    expect(codeOf(() => setStep(llm, i.id, "1.1", "done"))).toBe("INVALID_STEP");
    expect(codeOf(() => setStep(llm, i.id, "x", "done"))).toBe("INVALID_STEP");
  });
});
