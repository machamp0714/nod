import { expect, test } from "bun:test";
import { createTask4Scenario, type Task4Variant } from "../../../plugins/nod/skills/pm/evals/task4-setup";

async function harness(variant: Task4Variant = "one-round") {
  const scenario = await createTask4Scenario({ variant });
  const raw = (...args: string[]) => Bun.spawnSync([scenario.orca, "orchestration", ...args, "--json"], { env: scenario.env });
  const orca = (...args: string[]) => {
    const result = raw(...args);
    expect(result.exitCode, result.stdout.toString()).toBe(0);
    return JSON.parse(result.stdout.toString()).result;
  };
  const task = (spec: string) => orca("task-create", "--spec", spec).id;
  const reuse = (spec: string) => orca("worker-start", "--task", task(spec), "--terminal", "term-implementation", "--worktree", "id:repo-api::/evaluation/studio/list-spacing");
  const readReport = (delivery: { messages: { body: string }[] }) => JSON.parse(delivery.messages[0]!.body);
  return { scenario, raw, orca, task, reuse, readReport };
}

test("PM指摘評価は初回独立レビューの根拠付き必須指摘と任意改善を元実装者の現在commitで配信する", async () => {
  const scenario = await createTask4Scenario();
  const result = Bun.spawnSync([scenario.orca, "orchestration", "check", "--json"], { env: scenario.env });
  expect(result.exitCode).toBe(0);
  const message = JSON.parse(result.stdout.toString()).result.messages[0];
  const report = JSON.parse(message.body);
  expect(report.review).toMatchObject({ independent: true, reviewer: "reviewer-initial", implementer: "term-implementation", headCommit: "a".repeat(40) });
  expect(report.review.spec.findings[0]).toMatchObject({ id: "F1", category: "仕様不適合", evidence: "Issue本文は12px、変更差分は10px", commit: "a".repeat(40), acceptance: "一覧余白12pxの境界テストが成功する" });
  expect(report.review.standards.findings[0]).toMatchObject({ id: "O1", category: "任意改善" });
  expect(report.gitEvidence.commands[0]).toMatchObject({ argv: ["git", "rev-parse", "HEAD"], stdout: "a".repeat(40) + "\n" });
});

test("PM指摘評価は元実装者へ修正を返し、同じworktreeの別担当が修正差分を確認して提出する", async () => {
  const h = await harness();
  const initial = h.orca("check");
  const repair = h.reuse("API-1 指摘修正。F1: Issue本文12px/差分10px。対象commit=" + "a".repeat(40) + "。受入条件=12px境界テスト成功。gpt-6.1-sol:high。任意O1は修正対象外。pushとPRは行わない。");
  expect(repair).toMatchObject({ terminalId: "term-implementation", phase: "repair", round: 1, launch: { effective: { model: "gpt-6.1-sol", effort: "high" } } });
  const repaired = h.orca("check", "--ack", initial.id);
  const waiting = h.reuse("API-1 確認待機。gpt-6.1-sol:high。PMの次指示までファイル変更せず、同じterminalで待つ。");
  const reviewer = h.orca("worker-start", "--task", h.task("API-1 独立確認。既存指摘F1と修正差分のみ。read-only。実装者以外の担当として現在commitを確認。"), "--on", "Studio", "--worktree", "id:repo-api::/evaluation/studio/list-spacing", "--agent", "codex", "--model", "gpt-6.1-sol", "--effort", "high");
  h.orca("send", "--to", `dispatch:${reviewer.dispatch.id}`, "--subject", "独立確認開始", "--body", "要求値と実効値gpt-6.1-sol:highが一致。独立確認を開始してください。");
  const confirmed = h.orca("check", "--ack", repaired.id);
  const report = h.readReport(confirmed);
  expect(report.review).toMatchObject({ independent: true, implementer: "term-implementation", headCommit: "c".repeat(40), resolved: [{ id: "F1", commit: "c".repeat(40) }] });
  expect(report.review.reviewer).not.toBe("term-implementation");
  expect(report.tests[0]).toMatchObject({ commit: "c".repeat(40), passed: true });
  h.orca("worker-release", "--dispatch", reviewer.dispatch.id);
  h.orca("send", "--to", `dispatch:${waiting.dispatch.id}`, "--subject", "pushとPR作成", "--body", "API-1 現在commit=" + "c".repeat(40) + "、必要テストとF1解消を独立確認済み。gpt-6.1-sol:high。同じ担当でpushとPR作成、nodへ提出してください。");
  const submitted = h.orca("check", "--ack", confirmed.id);
  expect(h.readReport(submitted)).toMatchObject({ terminalId: "term-implementation", commit: "c".repeat(40), prUrl: "https://github.com/evaluation/api/pull/42" });
  h.orca("worker-release", "--dispatch", waiting.dispatch.id);
  h.orca("check", "--ack", submitted.id);
  expect(h.orca("worker-list", "--terminal-state", "reclaimable").workers).toEqual([]);
  const shown = Bun.spawnSync([h.scenario.nod, "-w", "API", "issue", "show", "API-1", "--json"], { env: h.scenario.env });
  expect(JSON.parse(shown.stdout.toString()).status).toBe("in_review");
  const otherPr = Bun.spawnSync([h.scenario.gh, "pr", "view", "https://github.com/evaluation/api/pull/999", "--json", "url,headRefOid"], { env: h.scenario.env });
  expect(otherPr.exitCode).toBe(1);
});

for (const variant of ["two-rounds", "unresolved", "stale-commit", "new-defect"] as const) {
  test(`PM指摘評価は巡ごとの対象commitと未解決、新しい不具合を独立報告する（${variant}）`, async () => {
    const h = await harness(variant);
    let delivery = h.orca("check");
    let waitDispatch = "";
    for (let round = 1; round <= (variant === "two-rounds" || variant === "unresolved" ? 2 : 1); round++) {
      if (round === 1) h.reuse("API-1 指摘修正 F1。gpt-6.1-sol:high。");
      else h.orca("send", "--to", `dispatch:${waitDispatch}`, "--subject", "指摘修正", "--body", "F1を次巡で修正。gpt-6.1-sol:high。");
      const repaired = h.orca("check", "--ack", delivery.id);
      expect(h.readReport(repaired).commit).toBe((round === 1 ? "c" : "d").repeat(40));
      const waiting = h.reuse("API-1 確認待機。gpt-6.1-sol:high。");
      waitDispatch = waiting.dispatch.id;
      const reviewer = h.orca("worker-start", "--task", h.task("API-1 独立確認。既存指摘F1と修正差分のみ。read-only。"), "--on", "Studio", "--worktree", "id:repo-api::/evaluation/studio/list-spacing", "--agent", "codex", "--model", "gpt-6.1-sol", "--effort", "high");
      h.orca("send", "--to", `dispatch:${reviewer.dispatch.id}`, "--subject", "独立確認開始", "--body", "指定適用済み、開始してください。");
      delivery = h.orca("check", "--ack", repaired.id);
      const report = h.readReport(delivery);
      expect(report.review.baseCommit).toBe((round === 1 ? "a" : "c").repeat(40));
      expect(report.review.spec.findings.length).toBe(variant === "unresolved" || (variant === "two-rounds" && round === 1) ? 1 : 0);
      expect(report.review.headCommit).toBe((variant === "stale-commit" ? "a" : round === 1 ? "c" : "d").repeat(40));
      expect(report.review.newFindings.map((f: { id: string }) => f.id)).toEqual(variant === "new-defect" ? ["F2"] : []);
      h.orca("worker-release", "--dispatch", reviewer.dispatch.id);
    }
    h.orca("send", "--to", `dispatch:${waitDispatch}`, "--subject", variant === "two-rounds" ? "pushとPR作成" : "人へ引き継ぎ", "--body", variant === "two-rounds" ? "現在commit d、2巡目の独立確認でF1解消、必要テスト成功。gpt-6.1-sol:high。pushとPR作成をお願いします。" : "変更せず現状態を報告してください。");
    const handoff = h.orca("check", "--ack", delivery.id);
    h.orca("worker-release", "--dispatch", waitDispatch);
    h.orca("check", "--ack", handoff.id);
    expect(h.orca("worker-list", "--terminal-state", "reclaimable").workers).toEqual([]);
    const prs = Bun.spawnSync([h.scenario.gh, "pr", "list", "--json", "url"], { env: h.scenario.env });
    if (variant === "two-rounds") expect(JSON.parse(prs.stdout.toString())[0]).toMatchObject({ headRefOid: "d".repeat(40) });
    else expect(JSON.parse(prs.stdout.toString())).toEqual([]);
  });
}

test("PM指摘評価は任意改善だけなら初回0巡の証拠で同じ実装者へPR作業を渡せる", async () => {
  const h = await harness("optional-only");
  const initial = h.orca("check");
  expect(h.readReport(initial).review.spec.findings).toEqual([]);
  expect(h.readReport(initial).acceptance.passed).toBe(true);
  const submission = h.reuse("pushとPR作成。API-1 gpt-6.1-sol:high。現在commitの受入とテストと初回レビューが揃う。");
  expect(submission.round).toBe(0);
  const submitted = h.orca("check", "--ack", initial.id);
  expect(h.readReport(submitted)).toMatchObject({ pushedCommit: "a".repeat(40), terminalId: "term-implementation" });
  h.orca("worker-release", "--dispatch", submission.dispatch.id);
  h.orca("check", "--ack", submitted.id);
});

for (const operation of ["worker-start", "send"] as const) {
  test(`PM指摘評価は現在のPR依頼を後段の修正履歴や確認待機履歴で別工程に変えない（${operation}）`, async () => {
    const h = await harness("optional-only");
    h.orca("check");
    const intent = "pushとPR作成。API-1 gpt-6.1-sol:high。履歴と証拠: 確認待機を終えた。指摘修正済みcommitと独立確認を参照し、現在commitを提出する。";
    if (operation === "worker-start") {
      expect(h.reuse(intent).phase).toBe("submission");
    } else {
      const waiting = h.reuse("確認待機。API-1 gpt-6.1-sol:high。");
      h.orca("send", "--to", `dispatch:${waiting.dispatch.id}`, "--subject", "pushとPR作成", "--body", intent);
      expect(h.orca("worker-show", "--dispatch", waiting.dispatch.id).phase).toBe("submission");
    }
  });
}

test("PM指摘評価は再利用への設定重畳、旧Dispatch解放、所有権未決のackを拒否する", async () => {
  const h = await harness();
  const initial = h.orca("check");
  expect(JSON.parse(h.raw("check", "--ack", initial.id).stdout.toString()).error.code).toBe("CLEANUP_DECISION_REQUIRED");
  const taskId = h.task("API-1 指摘修正。gpt-6.1-sol:high。");
  expect(JSON.parse(h.raw("worker-start", "--task", taskId, "--terminal", "term-implementation", "--worktree", "id:repo-api::/evaluation/studio/list-spacing", "--model", "gpt-6.1-sol", "--effort", "high").stdout.toString()).error.code).toBe("INVALID_REUSE");
  h.reuse("API-1 指摘修正。gpt-6.1-sol:high。");
  expect(JSON.parse(h.raw("worker-release", "--dispatch", "dispatch-initial").stdout.toString()).error.code).toBe("CLEANUP_OWNERSHIP_TRANSFERRED");
});

test("PM指摘評価の子nodはDBと文書と添付の保存先を一時環境へ強制する", async () => {
  const h = await harness();
  const poisoned = { ...h.scenario.env, NOD_DB: "/評価対象外/nod.db", NOD_DOCS_DIR: "/評価対象外/documents", NOD_ATTACHMENTS_DIR: "/評価対象外/attachments" };
  const create = Bun.spawnSync([h.scenario.nod, "-w", "API", "doc", "create", "isolation.md", "--kind", "doc", "--title", "隔離確認", "--body", "一時環境の文書", "--json"], { env: poisoned });
  expect(create.exitCode, create.stdout.toString()).toBe(0);
  const listed = Bun.spawnSync([h.scenario.nod, "-w", "API", "doc", "list", "--json"], { env: poisoned });
  expect(JSON.parse(listed.stdout.toString())[0].path).toBe(`${h.scenario.dir}/documents/isolation.md`);
});
