import { expect, test } from "bun:test";
import { createTask5Scenario, type Task5Variant } from "../../../plugins/nod/skills/pm/evals/task5-setup";

async function harness(variant: Task5Variant = "waiting") {
  const s = await createTask5Scenario({ variant });
  const raw = (...args: string[]) => Bun.spawnSync([s.orca, "orchestration", ...args, "--json"], { env: s.env });
  const call = (...args: string[]) => {
    const r = raw(...args);
    expect(r.exitCode, r.stdout.toString()).toBe(0);
    return JSON.parse(r.stdout.toString()).result;
  };
  const nod = (...args: string[]) => {
    const r = Bun.spawnSync([s.nod, "-w", "API", ...args, "--json"], { env: s.env });
    expect(r.exitCode, r.stdout.toString()).toBe(0);
    return JSON.parse(r.stdout.toString());
  };
  return { s, raw, call, nod };
}

test("PM並行評価は質問元と独立Issueを別Dispatchで配信し、無回答のackでも元質問を保持する", async () => {
  const s = await createTask5Scenario();
  const call = (...args: string[]) => {
    const r = Bun.spawnSync([s.orca, "orchestration", ...args, "--json"], { env: s.env });
    expect(r.exitCode, r.stdout.toString()).toBe(0);
    return JSON.parse(r.stdout.toString()).result;
  };
  const first = call("check");
  expect(first.messages[0]).toMatchObject({ id: "ask-api1", dispatchId: "dispatch-api1", type: "question" });
  call("check", "--ack", first.id);
  expect(call("check", "--wait", "--timeout-ms", "1").messages).toEqual([]);
  expect(call("worker-show", "--dispatch", "dispatch-api1")).toMatchObject({ issueId: "API-1", phase: "awaiting_input", terminalId: "term-api1" });
  const second = call("worker-start", "--spec", "実装。API-2。gpt-6.1-sol:high。照合完了まで変更しない。", "--on", "Studio", "--worktree", "new-top-level", "--repo", "id:repo-api", "--name", "export-column", "--agent", "codex", "--model", "gpt-6.1-sol", "--effort", "high");
  call("send", "--to", `dispatch:${second.dispatch.id}`, "--subject", "実装開始", "--body", "要求値と実効値を照合済み。実装を開始してください。");
  const completed = call("check");
  expect(JSON.parse(completed.messages[0].body)).toMatchObject({ issueId: "API-2", dispatchId: second.dispatch.id, acceptance: { passed: true } });
  expect(call("worker-show", "--dispatch", "dispatch-api1").phase).toBe("awaiting_input");
});

test("PM並行評価は独立IssueのPRだけを提出し、質問と成果とcleanup所有者を別々に照合できる", async () => {
  const h = await harness();
  const initial = h.call("check");
  expect(h.nod("issue", "show", "API-2").labels).not.toContain("needs-spec");
  expect(h.nod("issue", "show", "API-6").labels).toContain("needs-spec");
  const q = h.nod("issue", "ask", "API-1", "保持期間は1.30日、2.90日。推奨1。保存量のため。決定後は元の集計作業を再開。").question;
  h.nod("issue", "log", "API-1", `質問#${q.id} Run=run-pm Task=task-api1 Dispatch=dispatch-api1 message=ask-api1。工程=人回答待ち。占有枠=1。`, "--kind", "blocker");
  h.call("check", "--ack", initial.id);
  const second = h.call("worker-start", "--spec", "実装。API-2。gpt-6.1-sol:high。照合完了まで変更しない。", "--on", "Studio", "--worktree", "new-top-level", "--repo", "id:repo-api", "--name", "export-column", "--agent", "codex", "--model", "gpt-6.1-sol", "--effort", "high");
  h.call("send", "--to", `dispatch:${second.dispatch.id}`, "--subject", "実装開始", "--body", "要求値と実効値が一致。開始してください。");
  const completed = h.call("check");
  expect(JSON.parse(h.raw("check", "--ack", completed.id).stdout.toString()).error.code).toBe("CLEANUP_DECISION_REQUIRED");
  const task = h.call("task-create", "--spec", "pushとPR作成。API-2 gpt-6.1-sol:high。CSV列名の現在commitを提出。");
  const reused = h.call("worker-start", "--task", task.id, "--terminal", second.terminalId, "--worktree", `id:${second.worktreeId}`);
  expect(reused.terminalId).toBe(second.terminalId);
  expect(JSON.parse(h.raw("worker-release", "--dispatch", second.dispatch.id).stdout.toString()).error.code).toBe("CLEANUP_OWNERSHIP_TRANSFERRED");
  const submitted = h.call("check", "--ack", completed.id);
  expect(JSON.parse(submitted.messages[0].body)).toMatchObject({ issueId: "API-2", prUrl: "https://github.com/evaluation/api/pull/42", commit: "c".repeat(40) });
  const prResult = Bun.spawnSync([h.s.gh, "pr", "view", "https://github.com/evaluation/api/pull/42", "--json", "headRefName,headRefOid,title"], { env: h.s.env });
  expect(prResult.exitCode).toBe(0);
  expect(JSON.parse(prResult.stdout.toString())).toMatchObject({ headRefName: "export-column", headRefOid: "c".repeat(40), title: "CSV列名を統一" });
  h.call("worker-release", "--dispatch", reused.dispatch.id);
  h.call("check", "--ack", submitted.id);
  expect(h.nod("issue", "show", "API-1").openQuestions[0]).toMatchObject({ id: q.id, answer: null });
  expect(h.nod("issue", "show", "API-1").status).toBe("in_progress");
  expect(h.nod("issue", "show", "API-2").status).toBe("in_review");
  expect(h.call("worker-show", "--dispatch", "dispatch-api1").phase).toBe("awaiting_input");
  expect(h.call("worker-list", "--terminal-state", "reclaimable").workers).toEqual([]);
});

for (const variant of ["model-pending", "launch-pending", "unverifiable", "stop"] as const) {
  test(`PM並行評価は既存予約と停止対象を空通知でも保持する（${variant}）`, async () => {
    const h = await harness(variant);
    const first = h.call("check");
    if (first.id) h.call("check", "--ack", first.id);
    h.call("check", "--wait", "--timeout-ms", "1");
    expect(h.call("worker-list", "--run", "run-pm", "--include-remote").workers).toHaveLength(1);
    const w = h.call("worker-show", "--dispatch", "dispatch-api1");
    expect(w.reported).toBe(false);
    expect(w.released).toBe(false);
    expect(w.launch.effective).toEqual(variant === "stop" ? { model: "gpt-6.1-sol", effort: "high" } : null);
    expect(JSON.parse(h.raw("worker-release", "--dispatch", "dispatch-api1").stdout.toString()).error.code).toBe("SETTLEMENT_REQUIRED");
    expect(h.nod("issue", "show", "API-2").status).toBe("todo");
  });
}

test("PM並行評価は候補がなくても稼働workerの完了を配信し、worker不在なら人待ちだけを取得する", async () => {
  const active = await harness("supervise");
  expect(active.nod("issue", "show", "API-2").archivedAt).not.toBeNull();
  const d = active.call("check", "--wait", "--timeout-ms", "1");
  expect(d.messages[0]).toMatchObject({ type: "worker_done", dispatchId: "dispatch-api1" });
  const idle = await harness("idle");
  expect(idle.call("worker-list").workers).toEqual([]);
  expect(idle.call("check").messages).toEqual([]);
  expect(idle.nod("issue", "show", "API-1").openQuestions).toHaveLength(1);
});

test("PM並行評価の子nodはDBと文書と添付を一時領域へ固定する", async () => {
  const h = await harness();
  const env = { ...h.s.env, NOD_DB: "/評価対象外/nod.db", NOD_DOCS_DIR: "/評価対象外/documents", NOD_ATTACHMENTS_DIR: "/評価対象外/attachments", NOD_ACTOR: "me" };
  const r = Bun.spawnSync([h.s.nod, "-w", "API", "doc", "create", "isolation.md", "--kind", "doc", "--title", "隔離確認", "--body", "一時文書", "--json"], { env });
  expect(r.exitCode).toBe(0);
  expect(h.nod("doc", "list")[0].path).toBe(`${h.s.dir}/documents/isolation.md`);
});

for (const route of ["Task先頭文", "send subject"] as const) {
  test(`PM並行評価の公開ガイドにある例で元workerのPR工程を開始できる（${route}）`, async () => {
    const h = await harness("supervise");
    const guide = h.raw("--help");
    expect(guide.exitCode).toBe(0);
    const taskExample = guide.stdout.toString().match(/PR Task spec例: "([^"]+)"/)?.[1];
    const subjectExample = guide.stdout.toString().match(/send --to dispatch:<ID> --subject "([^"]+)" --body/)?.[1];
    expect(taskExample).toBeDefined();
    expect(subjectExample).toBeDefined();
    const completed = h.call("check");
    const task = h.call("task-create", "--spec", route === "Task先頭文" ? taskExample!.replace("<IssueID>", "API-1") : "確認待機。API-1 gpt-6.1-sol:high。次指示まで変更しない。");
    const next = h.call("worker-start", "--task", task.id, "--terminal", "term-api1", "--worktree", "id:repo-api::/evaluation/studio/retention");
    if (route === "send subject") h.call("send", "--to", `dispatch:${next.dispatch.id}`, "--subject", subjectExample!, "--body", "API-1 現在commitの必要テストと独立レビューを確認済み。gpt-6.1-sol:highでpushとPR提出を実施してください。");
    const submitted = h.call("check", "--ack", completed.id);
    expect(JSON.parse(submitted.messages[0].body)).toMatchObject({ issueId: "API-1", prUrl: "https://github.com/evaluation/api/pull/42", terminalId: "term-api1" });
    const prResult = Bun.spawnSync([h.s.gh, "pr", "view", "https://github.com/evaluation/api/pull/42", "--json", "headRefName,headRefOid,title"], { env: h.s.env });
    expect(prResult.exitCode).toBe(0);
    const current = h.call("worker-show", "--dispatch", next.dispatch.id);
    expect(JSON.parse(prResult.stdout.toString())).toMatchObject({ headRefName: current.git.branch, headRefOid: "a".repeat(40), title: "保持期間の境界を確認" });
    expect(h.nod("issue", "show", "API-1").status).toBe("in_review");
    h.call("worker-release", "--dispatch", next.dispatch.id);
    h.call("check", "--ack", submitted.id);
  });
}
