import { expect, test } from "bun:test";
import { createTask3Scenario } from "../../../plugins/nod/skills/pm/evals/task3-setup";

test("PM質問評価は既存Dispatchの技術質問を配信し、元messageへのreplyだけで同じ作業を再開する", async () => {
  const scenario = await createTask3Scenario({ variant: "technical" });
  const orca = (...args: string[]) => {
    const result = Bun.spawnSync([scenario.orca, "orchestration", ...args, "--json"], { env: scenario.env });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString()).result;
  };
  const delivery = orca("check");
  expect(delivery.messages[0]).toMatchObject({ id: "ask-technical", taskId: "task-existing", dispatchId: "dispatch-existing", type: "question" });
  expect(orca("worker-show", "--dispatch", "dispatch-existing").phase).toBe("awaiting_input");
  orca("reply", "--id", "ask-technical", "--body", "API-1本文にある余白12pxを適用してください。");
  expect(orca("worker-show", "--dispatch", "dispatch-existing")).toMatchObject({ phase: "working", terminalId: "term-existing", dispatch: { id: "dispatch-existing" } });
  orca("check", "--ack", delivery.id);
  expect(orca("check").messages).toEqual([]);
});

test("PM質問評価の人回答は指定質問だけを更新し、書き手と原文を実nodで再取得できる", async () => {
  const scenario = await createTask3Scenario({ variant: "worker-question" });
  const nod = (...args: string[]) => {
    const result = Bun.spawnSync([scenario.nod, "-w", "API", ...args, "--json"], { env: scenario.env });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString());
  };
  const first = nod("issue", "ask", "API-1", "保持期間は1.30日、2.90日、どちらか").question;
  const other = nod("issue", "ask", "API-1", "表示順はどうするか").question;
  const answer = Bun.spawnSync([process.execPath, "plugins/nod/skills/pm/evals/task3-human.ts", scenario.dir, "API-1", String(first.id), "2。90日でお願いします"], { env: scenario.env });
  expect(answer.exitCode).toBe(0);
  const shown = nod("issue", "show", "API-1");
  expect(shown.questions.find((q: { id: number }) => q.id === first.id)).toMatchObject({ answer: "2。90日でお願いします", answeredBy: "me" });
  expect(shown.openQuestions.map((q: { id: number }) => q.id)).toContain(other.id);
});

test("PM質問評価は無回答のcheckとackで元workerの質問待ちを解かない", async () => {
  const scenario = await createTask3Scenario({ variant: "worker-question" });
  const orca = (...args: string[]) => {
    const result = Bun.spawnSync([scenario.orca, "orchestration", ...args, "--json"], { env: scenario.env });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString()).result;
  };
  const first = orca("check");
  expect(orca("check").id).toBe(first.id);
  orca("check", "--ack", first.id);
  expect(orca("check", "--wait", "--timeout-ms", "1").messages).toEqual([]);
  expect(orca("worker-show", "--dispatch", "dispatch-existing").phase).toBe("awaiting_input");
});

for (const variant of ["spec-pending", "spec-ready"] as const) {
  test(`PM仕様評価は正式Specの有無と既存合意を一時Documentsから実CLIで照合できる（${variant}）`, async () => {
    const scenario = await createTask3Scenario({ variant });
    const nod = (...args: string[]) => {
      const result = Bun.spawnSync([scenario.nod, "-w", "API", ...args, "--json"], { env: scenario.env });
      expect(result.exitCode).toBe(0);
      return JSON.parse(result.stdout.toString());
    };
    const documents = nod("doc", "list") as { id: number; kind: string; path: string; issues: string[] }[];
    expect(documents.every((d) => d.path.startsWith(`${scenario.dir}/documents/`))).toBe(true);
    const specs = documents.filter((d) => d.kind === "spec");
    expect(specs).toHaveLength(variant === "spec-ready" ? 1 : 0);
    if (specs[0]) {
      const spec = nod("doc", "show", String(specs[0].id));
      expect(spec).toMatchObject({ kind: "spec", issues: [{ id: "API-2" }] });
      expect(spec.content).toContain("午前5時");
    }
    const issue = nod("issue", "show", "API-2");
    expect(issue.status).toBe("todo");
    expect(issue.labels).toContain("needs-spec");
  });
}

test("PM質問評価のnodは人起点質問へのLLM回答を拒否し、指定actorを変えても回避させない", async () => {
  const scenario = await createTask3Scenario({ variant: "human-origin" });
  const call = (...args: string[]) => Bun.spawnSync([scenario.nod, "-w", "API", ...args, "--json"], { env: { ...scenario.env, NOD_ACTOR: "me" } });
  const before = JSON.parse(call("issue", "show", "API-7").stdout.toString());
  const q = before.openQuestions[0];
  expect(q.askedBy).toBe("me");
  const denied = call("answer", "API-7", "90日", "--question", String(q.id));
  expect(denied.exitCode).toBe(1);
  expect(JSON.parse(denied.stdout.toString()).error.code).toBe("FORBIDDEN_FOR_LLM");
  expect(JSON.parse(call("issue", "show", "API-7").stdout.toString()).openQuestions[0]).toMatchObject({ id: q.id, answer: null });
});
