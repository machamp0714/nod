import { expect, test } from "bun:test";
import { createTask6Scenario } from "../../../plugins/nod/skills/pm/evals/task6-setup";
import { readFileSync } from "node:fs";

test("PM復元評価は既存PRへの関連回復を二重createと記録しない", async () => {
  const s = await createTask6Scenario({ variant: "pr-lost" });
  const call = (...argv: string[]) => {
    const r = Bun.spawnSync([s.orca, "orchestration", ...argv, "--json"], { env: s.env });
    expect(r.exitCode, r.stdout.toString()).toBe(0);
    return JSON.parse(r.stdout.toString()).result;
  };
  const task = call("task-create", "--spec", "pushとPR提出。API-1 gpt-6.1-sol:high。既存PRは作成し直さず関連のみ回復。");
  call("worker-start", "--task", task.id, "--terminal", "term-api1", "--worktree", "id:repo-api::/evaluation/studio/retention");
  expect(JSON.parse(call("check").messages[0].body).prUrl).toBe("https://github.com/evaluation/api/pull/42");
  const operations = readFileSync(s.log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(operations.filter(o => o.tool === "gh" && o.argv[0] === "pr" && o.argv[1] === "create")).toEqual([]);
});

test("PM復元評価は同じ完了messageの再配送と古Dispatchの古commitを現在の待機所有者と区別して取得する", async () => {
  const s = await createTask6Scenario({ variant: "duplicate-old" });
  const call = (...argv: string[]) => {
    const r = Bun.spawnSync([s.orca, "orchestration", ...argv, "--json"], { env: s.env });
    expect(r.exitCode).toBe(0);
    return JSON.parse(r.stdout.toString()).result;
  };
  const d = call("check");
  expect(d.messages.map((m: { id: string }) => m.id)).toEqual(["done-review-1", "done-review-1", "old-initial"]);
  expect(JSON.parse(d.messages[2].body).commit).toBe("a".repeat(40));
  expect(call("worker-show", "--dispatch", "dispatch-wait")).toMatchObject({ git: { head: "c".repeat(40) }, reported: false, terminalId: "term-api1" });
  expect(call("check").id).toBe(d.id);
  call("check", "--ack", d.id);
  expect(call("worker-show", "--dispatch", "dispatch-wait").released).toBe(false);
});

test("PM復元評価は2件中の質問待ちと提出済みPRを別Issueとして実nodから復元する", async () => {
  const s = await createTask6Scenario({ variant: "two-issue" });
  const show = (id: string) => {
    const r = Bun.spawnSync([s.nod, "-w", "API", "issue", "show", id, "--json"], { env: s.env });
    expect(r.exitCode).toBe(0);
    return JSON.parse(r.stdout.toString());
  };
  expect(show("API-1")).toMatchObject({ status: "in_progress", openQuestions: [{ answer: null }] });
  expect(show("API-2")).toMatchObject({ status: "in_review", openQuestions: [] });
  const r = Bun.spawnSync([s.gh, "pr", "view", "export-column", "--repo", "evaluation/api"], { env: s.env });
  expect(JSON.parse(r.stdout.toString())).toMatchObject({ number: 42, headRefName: "export-column", headRefOid: "c".repeat(40) });
});

test("PM復元評価は実装中の既存試行だけを完了配信し、要求値と実効値と現在commitを取得する", async () => {
  const s = await createTask6Scenario({ variant: "implementation" });
  const r = Bun.spawnSync([s.orca, "orchestration", "check", "--json"], { env: s.env });
  expect(r.exitCode).toBe(0);
  const d = JSON.parse(r.stdout.toString()).result;
  expect(d.messages).toHaveLength(1);
  expect(JSON.parse(d.messages[0].body)).toMatchObject({ taskId: "task-api1", dispatchId: "dispatch-api1", commit: "a".repeat(40), model: "gpt-6.1-sol", effort: "high", review: { standards: { findings: [] }, spec: { findings: [] } } });
});

test("PM復元評価は仕様未合意の質問IDと元messageを実nodから再取得し、空通知でも待機を保持する", async () => {
  const s = await createTask6Scenario({ variant: "spec-wait" });
  const r = Bun.spawnSync([s.nod, "-w", "API", "issue", "show", "API-1", "--json"], { env: s.env });
  expect(r.exitCode).toBe(0);
  const issue = JSON.parse(r.stdout.toString());
  expect(issue.labels).toContain("needs-spec");
  expect(issue.openQuestions).toHaveLength(1);
  expect(issue.openQuestions[0].answer).toBeNull();
  const check = Bun.spawnSync([s.orca, "orchestration", "check", "--wait", "--timeout-ms", "1", "--json"], { env: s.env });
  expect(JSON.parse(check.stdout.toString()).result.messages).toEqual([]);
  const w = Bun.spawnSync([s.orca, "orchestration", "worker-show", "--dispatch", "dispatch-api1", "--json"], { env: s.env });
  expect(JSON.parse(w.stdout.toString()).result.phase).toBe("spec_wait");
});

test("PM復元評価は修正確認1巡目を独立担当から報告し、元実装者の待機Dispatchを維持する", async () => {
  const s = await createTask6Scenario({ variant: "fix-confirm" });
  const call = (...argv: string[]) => {
    const r = Bun.spawnSync([s.orca, "orchestration", ...argv, "--json"], { env: s.env });
    expect(r.exitCode, r.stdout.toString()).toBe(0);
    return JSON.parse(r.stdout.toString()).result;
  };
  const d = call("check");
  const report = JSON.parse(d.messages.find((m: { dispatchId: string }) => m.dispatchId === "dispatch-confirm").body);
  expect(report).toMatchObject({ round: 1, role: "independent-confirmation", commit: "c".repeat(40), findings: [], resolvedFindingIds: ["F1"] });
  expect(report.reviewer).not.toBe("term-api1");
  const waiting = call("worker-show", "--dispatch", "dispatch-wait");
  expect(waiting).toMatchObject({ phase: "followup", reported: false, terminalId: "term-api1", git: { head: "c".repeat(40) } });
  call("worker-release", "--dispatch", "dispatch-confirm");
  call("check", "--ack", d.id);
  expect(call("worker-show", "--dispatch", "dispatch-wait").released).toBe(false);
});

test("PM復元評価はPR応答喪失後にrepoとbranchとheadを絞り、URLとnumberでも同じ既存PRを取得する", async () => {
  const s = await createTask6Scenario({ variant: "pr-lost" });
  const gh = (...argv: string[]) => {
    const r = Bun.spawnSync([s.gh, "pr", ...argv], { env: s.env });
    expect(r.exitCode, r.stdout.toString()).toBe(0);
    return JSON.parse(r.stdout.toString());
  };
  const existing = gh("list", "--repo", "evaluation/api", "--head", "retention", "--json", "number,url,headRefOid");
  expect(existing).toHaveLength(1);
  expect(existing[0]).toMatchObject({ number: 42, headRefOid: "a".repeat(40) });
  for (const selector of [existing[0].url, "42", "retention"]) expect(gh("view", selector, "--repo", "evaluation/api")).toEqual(existing[0]);
  expect(gh("list", "--repo", "evaluation/other", "--head", "retention")).toEqual([]);
  expect(gh("list", "--repo", "evaluation/api", "--head", "different")).toEqual([]);
});

test("PM復元評価は通信断を保持し、公開recover後も同じTaskとDispatchで実効値を確認できる", async () => {
  const s = await createTask6Scenario({ variant: "unknown" });
  const call = (...argv: string[]) => {
    const r = Bun.spawnSync([s.orca, "orchestration", ...argv, "--json"], { env: s.env });
    expect(r.exitCode, r.stdout.toString()).toBe(0);
    return JSON.parse(r.stdout.toString()).result;
  };
  const before = call("worker-show", "--dispatch", "dispatch-api1");
  expect(before.launch.effective).toBeNull();
  expect(before.projection.liveness.verdict).toBe("unverifiable");
  const guide = Bun.spawnSync([s.orca, "skills", "get", "orchestration"], { env: s.env }).stdout.toString();
  expect(guide).toContain("task6-control.ts");
  const recovery = Bun.spawnSync([process.execPath, "plugins/nod/skills/pm/evals/task6-control.ts", s.dir, "recover"], { env: s.env });
  expect(recovery.exitCode, recovery.stderr.toString()).toBe(0);
  const after = call("worker-show", "--dispatch", "dispatch-api1");
  expect(after.task.id).toBe(before.task.id);
  expect(after.terminalId).toBe(before.terminalId);
  expect(after.launch.effective).toEqual({ model: "gpt-6.1-sol", effort: "high" });
  expect(call("request-show", "--request", "op-api1-launch")).toMatchObject({ status: "completed", receipt: { dispatchId: "dispatch-api1" } });
});
