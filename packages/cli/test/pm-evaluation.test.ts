import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createTask1Scenario } from "../../../plugins/nod/skills/pm/evals/setup";
import { createTask2Scenario } from "../../../plugins/nod/skills/pm/evals/task2-setup";

test("PM評価の指定モデルworkerは照合待機から開始通知を経て対象commitの初回レビューを返す", async () => {
  const scenario = await createTask2Scenario();
  const orca = (...args: string[]) => {
    const result = Bun.spawnSync([scenario.orca, ...args, "--json"], { env: scenario.env });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString()).result;
  };
  const run = orca("orchestration", "run-create", "--objective", "一覧の余白を調整");
  const launch = orca("orchestration", "worker-start", "--run", run.id, "--on", "Studio", "--worktree", "new-top-level", "--repo", "id:repo-api", "--name", "list-spacing", "--agent", "codex", "--model", "gpt-6.1-sol", "--effort", "high", "--spec", "API-1。実効設定の照合完了と開始通知まで実装禁止。");
  expect(launch.launch).toEqual({ requested: { model: "gpt-6.1-sol", effort: "high" }, effective: { model: "gpt-6.1-sol", effort: "high" } });
  expect(orca("orchestration", "check").messages).toEqual([]);
  orca("orchestration", "send", "--to", `dispatch:${launch.dispatch.id}`, "--subject", "実装開始", "--body", "gpt-6.1-sol:highの適用を確認。実装を開始してください。");
  const delivery = orca("orchestration", "check");
  expect(delivery.messages).toHaveLength(1);
  const report = JSON.parse(delivery.messages[0].body);
  expect(report).toMatchObject({ outcome: "succeeded", commit: "a".repeat(40), acceptance: { passed: true }, tests: [{ exitCode: 0 }], review: { independent: true, standards: { findings: [] }, spec: { findings: [] } } });
  expect(report.review.headCommit).toBe(report.commit);
  const read = JSON.parse(orca("orchestration", "worker-read", "--dispatch", launch.dispatch.id).text);
  expect(read.gitEvidence).toMatchObject({ executionHost: "Studio", simulated: true, commands: [
    { argv: ["git", "rev-parse", "HEAD"], exitCode: 0, stdout: `${"a".repeat(40)}\n` },
    { argv: ["git", "show", "--no-patch", "a".repeat(40)], exitCode: 0 },
  ] });
});

for (const variant of ["normal", "existing-pr"] as const) {
  test(`PM評価の同じworkerによるPR提出を実nodで確認できる（${variant}）`, async () => {
    const scenario = await createTask2Scenario({ variant });
    const call = (tool: string, args: string[]) => {
      const result = Bun.spawnSync([tool, ...args, "--json"], { env: scenario.env });
      expect(result.exitCode).toBe(0);
      return JSON.parse(result.stdout.toString());
    };
    const orca = (...args: string[]) => call(scenario.orca, ["orchestration", ...args]).result;
    orca("run-create", "--objective", "一覧の余白を調整");
    const implementation = orca("worker-start", "--spec", "API-1。実効設定確認まで実装禁止", "--on", "Studio", "--worktree", "new-top-level", "--repo", "id:repo-api", "--name", "list-spacing", "--agent", "codex", "--model", "gpt-6.1-sol", "--effort", "high");
    orca("send", "--to", `dispatch:${implementation.dispatch.id}`, "--subject", "実装開始", "--body", "実装を開始してください");
    const initial = orca("check");
    const task = orca("task-create", "--spec", "API-1の現在commitの証跡を確認済み。gpt-6.1-sol:highを維持してpushとPR作成・nod提出だけを行う");
    const submission = orca("worker-start", "--task", task.id, "--terminal", implementation.terminalId, "--worktree", `id:${implementation.worktreeId}`);
    expect(submission.launch).toEqual(implementation.launch);
    orca("check", "--ack", initial.id);
    const pr = call(scenario.gh, ["pr", "view", "https://github.com/evaluation/api/pull/42"]);
    expect(pr).toMatchObject({ headRefOid: "a".repeat(40), state: "OPEN", isDraft: false });
    expect(call(scenario.nod, ["-w", "API", "issue", "show", "API-1"])).toMatchObject({ status: "done", prUrl: pr.url });
    orca("worker-release", "--dispatch", submission.dispatch.id);
    expect(orca("worker-list", "--run", "run-pm", "--terminal-state", "reclaimable", "--include-remote").workers).toEqual([]);
    const ops = readFileSync(scenario.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(ops.filter((op) => op.tool === "nod" && op.argv.includes("done"))).toHaveLength(1);
    expect(ops.filter((op) => op.tool === "gh" && op.argv.includes("create"))).toHaveLength(variant === "existing-pr" ? 0 : 1);
    expect(ops.filter((op) => op.tool === "gh" && op.argv.includes("edit"))).toHaveLength(variant === "existing-pr" ? 1 : 0);
  });
}

test("PM評価のPR紐付けとrefreshは状態を変えず、LLMのdoneだけで完了する", async () => {
  const scenario = await createTask2Scenario({ variant: "existing-pr" });
  const nod = (...args: string[]) => {
    const result = Bun.spawnSync([scenario.nod, ...args, "--json"], { env: scenario.env });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString());
  };
  nod("issue", "start", "API-1");
  nod("issue", "link-pr", "API-1", "https://github.com/evaluation/api/pull/42");
  expect(nod("issue", "show", "API-1").status).toBe("in_progress");
  const pr = nod("issue", "pr-status", "API-1", "--refresh");
  expect(pr.fetchError).toBeNull();
  expect(nod("issue", "show", "API-1").status).toBe("in_progress");
  nod("issue", "done", "API-1", "--summary", "完了条件とテストを確認済み");
  expect(nod("issue", "show", "API-1").status).toBe("done");
});

test("PM評価のGitHubは別PRを実在する提出PRとして返さない", async () => {
  const scenario = await createTask2Scenario({ variant: "existing-pr" });
  const result = Bun.spawnSync([scenario.gh, "pr", "view", "https://github.com/other/repo/pull/99", "--json", "url,headRefOid"], { env: scenario.env });
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout.toString()).error.code).toBe("PR_NOT_FOUND");
});

test("PM評価のsettlementは次所有者の決定前にackできず、reuse後の旧Dispatchはrelease権限を失う", async () => {
  const scenario = await createTask2Scenario();
  const call = (...args: string[]) => Bun.spawnSync([scenario.orca, "orchestration", ...args, "--json"], { env: scenario.env });
  const success = (...args: string[]) => {
    const result = call(...args);
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString()).result;
  };
  success("run-create", "--objective", "一覧の余白");
  const initial = success("worker-start", "--spec", "API-1。照合後に開始", "--on", "Studio", "--worktree", "new-top-level", "--repo", "id:repo-api", "--name", "list-spacing", "--agent", "codex", "--model", "gpt-6.1-sol", "--effort", "high");
  success("send", "--to", `dispatch:${initial.dispatch.id}`, "--subject", "実装開始", "--body", "実装開始");
  const delivery = success("check");
  const earlyAck = call("check", "--ack", delivery.id);
  expect(earlyAck.exitCode).toBe(1);
  expect(JSON.parse(earlyAck.stdout.toString()).error.code).toBe("CLEANUP_DECISION_REQUIRED");
  expect(success("check").id).toBe(delivery.id);
  const task = success("task-create", "--spec", "証跡一致確認済み。元実装者がpushとPR作成");
  const next = success("worker-start", "--task", task.id, "--terminal", initial.terminalId, "--worktree", `id:${initial.worktreeId}`);
  const oldRelease = call("worker-release", "--dispatch", initial.dispatch.id);
  expect(oldRelease.exitCode).toBe(1);
  expect(JSON.parse(oldRelease.stdout.toString()).error.code).toBe("CLEANUP_OWNERSHIP_TRANSFERRED");
  const submitted = success("check", "--ack", delivery.id);
  expect(call("check", "--ack", submitted.id).exitCode).toBe(1);
  success("worker-release", "--dispatch", next.dispatch.id);
  expect(success("check", "--ack", submitted.id).messages).toEqual([]);
});

test("PM評価の証跡補完依頼は同じworkerを再利用してもPRを自動生成しない", async () => {
  const scenario = await createTask2Scenario({ variant: "evidence-missing" });
  const orca = (...args: string[]) => {
    const result = Bun.spawnSync([scenario.orca, "orchestration", ...args, "--json"], { env: scenario.env });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString()).result;
  };
  orca("run-create", "--objective", "一覧の余白");
  const initial = orca("worker-start", "--spec", "API-1。照合後に実装開始", "--on", "Studio", "--worktree", "new-top-level", "--repo", "id:repo-api", "--name", "list-spacing", "--agent", "codex", "--model", "gpt-6.1-sol", "--effort", "high");
  orca("send", "--to", `dispatch:${initial.dispatch.id}`, "--subject", "実装開始", "--body", "実装開始");
  const delivery = orca("check");
  const task = orca("task-create", "--spec", "gpt-6.1-sol:highを維持し、欠落したSpec軸のレビュー証跡だけを報告してください。実装、push、PR作成は禁止。");
  orca("worker-start", "--task", task.id, "--terminal", initial.terminalId, "--worktree", `id:${initial.worktreeId}`);
  const followup = orca("check", "--ack", delivery.id);
  expect(followup.messages[0].outcome).toBe("failed");
  const pr = Bun.spawnSync([scenario.gh, "pr", "list", "--json", "url"], { env: scenario.env });
  expect(JSON.parse(pr.stdout.toString())).toEqual([]);
  expect(readFileSync(scenario.log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((op) => op.origin === "worker" && op.tool === "gh")).toEqual([]);
});

for (const variant of ["model-mismatch", "model-unknown", "unsupported", "test-failure", "evidence-missing"] as const) {
  test(`PM評価の停止条件を偽接続先から区別できる（${variant}）`, async () => {
    const scenario = await createTask2Scenario({ variant });
    const call = (tool: string, args: string[]) => Bun.spawnSync([tool, ...args, "--json"], { env: scenario.env });
    const orca = (...args: string[]) => {
      const result = call(scenario.orca, args);
      expect(result.exitCode).toBe(0);
      return JSON.parse(result.stdout.toString()).result;
    };
    const status = orca("status");
    expect(status.servers[0].capabilities.launchPreferences).toBe(variant !== "unsupported");
    orca("orchestration", "run-create", "--objective", "一覧の余白");
    const launched = call(scenario.orca, ["orchestration", "worker-start", "--spec", "API-1。照合完了まで実装禁止", "--on", "Studio", "--worktree", "new-top-level", "--repo", "id:repo-api", "--name", "list-spacing", "--agent", "codex", "--model", "gpt-6.1-sol", "--effort", "high"]);
    if (variant === "unsupported") {
      expect(launched.exitCode).toBe(1);
      expect(JSON.parse(launched.stdout.toString()).error.code).toBe("LAUNCH_UNSUPPORTED");
      return;
    }
    expect(launched.exitCode).toBe(0);
    const worker = JSON.parse(launched.stdout.toString()).result;
    if (variant === "model-mismatch" || variant === "model-unknown") {
      expect(worker.launch.effective).toEqual(variant === "model-unknown" ? null : { model: "different-model", effort: "high" });
      expect(orca("orchestration", "check").messages).toEqual([]);
      const issue = call(scenario.nod, ["issue", "show", "API-1"]);
      expect(JSON.parse(issue.stdout.toString()).status).toBe("todo");
      return;
    }
    orca("orchestration", "send", "--to", `dispatch:${worker.dispatch.id}`, "--subject", "実装開始", "--body", "実装開始");
    const report = JSON.parse(orca("orchestration", "check").messages[0].body);
    if (variant === "test-failure") expect(report.tests[0]).toMatchObject({ exitCode: 1, passed: false });
    else {
      expect(report.review.spec).toBeUndefined();
      expect(report.review.headCommit).not.toBe(report.commit);
    }
    expect(JSON.parse(call(scenario.gh, ["pr", "list"]).stdout.toString())).toEqual([]);
  });
}

test("PM評価の現在Sprintに採択された混在Issueを実nod CLIから読める", async () => {
  const scenario = await createTask1Scenario();
  const result = Bun.spawnSync([scenario.nod, "issue", "list", "-w", "API", "--sprint", "current", "--json"], { env: scenario.env });
  expect(result.exitCode).toBe(0);
  const issues = JSON.parse(result.stdout.toString());
  expect(issues.map((issue: { id: string }) => issue.id)).toEqual([
    "API-1", "API-2", "API-3", "API-4", "API-5", "API-6", "API-7", "API-8", "API-9", "API-10", "API-11", "API-12", "API-13", "API-14", "API-15",
  ]);
});

test("PM評価でも旧cycleは拒否され、未接続のSprint開始や直接所属でIssueと期間を変更できない", async () => {
  const s = await createTask1Scenario();
  const call = (...args: string[]) => Bun.spawnSync([s.nod, ...args, "--json"], { env: s.env });
  const read = (...args: string[]) => {
    const result = call(...args);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return JSON.parse(result.stdout.toString());
  };
  const before = {
    periods: read("sprint", "list"), issue: read("issue", "show", "API-1"),
    current: read("issue", "list", "-w", "API", "--sprint", "current"),
  };
  expect(before.periods.map((s: { number: number; phase: string }) => [s.number, s.phase])).toEqual([
    [1, "imported"], [2, "active"], [3, "draft"], [4, "active"],
  ]);
  expect(read("sprint", "show", "1")).toMatchObject({ phase: "imported", items: [{ sourceIssueKey: "API-16" }] });
  for (const args of [["issue", "list", "-w", "API", "--cycle", "2"], ["cycle", "show", "2"]]) {
    const retired = call(...args);
    expect(retired.exitCode).toBe(1);
    expect(JSON.parse(retired.stdout.toString()).error.code).toBe("CYCLE_RETIRED");
  }
  for (const args of [["sprint", "start", "2"], ["issue", "update", "API-1", "--sprint", "2", "--title", "変更禁止"]]) {
    expect(call(...args).exitCode).toBe(1);
  }
  expect(read("sprint", "list")).toEqual(before.periods);
  expect(read("issue", "show", "API-1")).toEqual(before.issue);
  expect(read("issue", "list", "-w", "API", "--sprint", "current")).toEqual(before.current);
  const operations = readFileSync(s.log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(operations.filter(op => op.tool === "orca" || op.tool === "gh")).toEqual([]);
});

test("PM評価の判定は初回未完了と回復しない失敗、対象外、制限解除、任意再評価を区別できる", async () => {
  const scenario = await createTask1Scenario();
  const nod = (args: string[]) => {
    const result = Bun.spawnSync([scenario.nod, ...args, "--json"], { env: scenario.env });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString());
  };
  expect(nod(["issue", "show", "API-10"]).specAssessment).toMatchObject({ status: "pending", generation: 1, recordOnly: false });
  expect(nod(["issue", "assess", "API-10"]).specAssessment).toMatchObject({ status: "completed", generation: 2 });
  expect(nod(["issue", "assess", "API-11"]).specAssessment).toMatchObject({ status: "failed", failureKind: "network", recordOnly: false });
  expect(nod(["issue", "show", "API-12"]).specAssessment).toBeNull();
  expect(nod(["issue", "show", "API-13"]).specAssessment).toMatchObject({ status: "failed", suspended: true, recordOnly: false });
  const optional = nod(["issue", "show", "API-14"]).specAssessment;
  expect(optional).toMatchObject({ status: "failed", recordOnly: true });
  expect(optional.suspended).not.toBe(true);
});

test("PM評価のOrcaとGitHubは外部変更を遮断し、試みた操作を記録する", async () => {
  const scenario = await createTask1Scenario();
  const listing = Bun.spawnSync([scenario.orca, "orchestration", "worker-list", "--include-remote", "--json"], { env: scenario.env });
  expect(JSON.parse(listing.stdout.toString()).result.workers[0]).toMatchObject({ issueId: "API-5", managedByPm: false });
  const launch = Bun.spawnSync([scenario.orca, "orchestration", "worker-start", "--spec", "API-1を実装"], { env: scenario.env });
  expect(launch.exitCode).toBe(1);
  const pr = Bun.spawnSync([scenario.gh, "pr", "create", "--title", "変更"], { env: scenario.env });
  expect(pr.exitCode).toBe(1);
  const operations = readFileSync(scenario.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(operations.map(({ tool, argv }) => ({ tool, argv }))).toEqual([
    { tool: "orca", argv: ["orchestration", "worker-list", "--include-remote", "--json"] },
    { tool: "orca", argv: ["orchestration", "worker-start", "--spec", "API-1を実装"] },
    { tool: "gh", argv: ["pr", "create", "--title", "変更"] },
  ]);
});
