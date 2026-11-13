import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { startIssue } from "../../core/src";
import { nodCliRecorder, recordInitialReview, simulatedCi } from "../../../plugins/nod/skills/pm/evals/initial-review";
import { createTask1Scenario } from "../../../plugins/nod/skills/pm/evals/setup";
import { createTask2Scenario } from "../../../plugins/nod/skills/pm/evals/task2-setup";

const reviewAgents = { standards: { definition: "code-reviewer-standards" }, spec: { definition: "code-reviewer-spec" }, refute: { definition: "code-reviewer-refute" } };
const acceptanceAgents = { ...reviewAgents, acceptance: { definition: "code-reviewer-acceptance" } };
/** 報告Documentの印の間の本文。 */
const between = (content: string, name: string) => content.match(new RegExp(`<!-- ${name}:begin -->\\n([\\s\\S]*?)<!-- ${name}:end -->`))?.[1];

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
  expect(report).toMatchObject({ outcome: "succeeded", commit: "a".repeat(40), acceptance: { passed: true }, tests: [{ exitCode: 0 }], review: {
    independent: true, implementer: "term-implementation", status: "完了", score: 5, target: { baseSha: "b".repeat(40), headSha: "a".repeat(40) },
    agents: reviewAgents, ci: { headSha: "a".repeat(40), verdict: "成功", base: "main" }, remainingChecks: [], mergeReadiness: "可（人のレビューなしでマージ可）", mergeReady: "付けた",
    standards: { findings: [] }, spec: { findings: [] },
  } });
  expect(report.review.headCommit).toBe(report.commit);
  expect(report.review.reviewer).toBeUndefined();
  const agentIds = Object.values(report.review.agents as Record<string, { id: string }>).map(agent => agent.id);
  expect(new Set([...agentIds, report.review.implementer]).size).toBe(4);
  // 監査Documentに原文を保存し、利用者向け結果は別Documentから参照する。
  const shown = Bun.spawnSync([scenario.nod, "doc", "show", String(report.review.auditDocument.id), "--json"], { env: scenario.env });
  expect(shown.exitCode).toBe(0);
  const document = JSON.parse(shown.stdout.toString());
  expect(document).toMatchObject({ kind: "doc", issues: [{ id: "API-1" }] });
  const verdict = readFileSync(report.review.verdict.path, "utf8");
  expect(createHash("sha256").update(verdict).digest("hex")).toBe(report.review.verdict.sha256);
  expect(document.content).toContain(`<!-- refute-verdict:begin -->\n${verdict}<!-- refute-verdict:end -->`);
  const resultDocument = JSON.parse(Bun.spawnSync([scenario.nod, "doc", "show", String(report.review.reportDocument.id), "--json"], { env: scenario.env }).stdout.toString());
  expect(resultDocument).toMatchObject({ kind: "doc", issues: [{ id: "API-1" }] });
  expect(resultDocument.id).not.toBe(document.id);
  expect(resultDocument.content).toContain(`Document ${document.id}（${report.review.auditDocument.path}）`);
  expect(resultDocument.content).toContain("## 要対応\n\nなし");
  expect(resultDocument.content).toContain("## 未確認（0件）\n\nなし");
  expect(resultDocument.content).toContain("- マージ可否: 可（人のレビューなしでマージ可）");
  for (const detail of ["refute-verdict:begin", "acceptance-result:begin", "### 試行の記録", "sha256", "### 担当"]) expect(resultDocument.content).not.toContain(detail);
  for (const content of [resultDocument.content, document.content]) {
    expect(content).toContain(`runId: ${report.review.runId}`);
    expect(content).toContain("a".repeat(40));
    expect(content.replace(/<!-- ci-result:begin -->\n[\s\S]*?<!-- ci-result:end -->/g, "")).not.toContain("- マージ可否:");
  }
  // 親はテストを実行せず、同じheadのCIの照合を parent/ci/1/result.json に残し、報告のCIの節に必須のチェックごとの結果を書く。
  const ci = JSON.parse(readFileSync(report.review.ci.recordPath, "utf8"));
  expect(report.review.ci.recordPath).toBe(`${report.review.workDirectory}/parent/ci/1/result.json`);
  expect(ci).toMatchObject({ ok: true, verdict: "成功", base: "main", head: "a".repeat(40), required: [{ context: "test", sources: ["workspace-rules"], result: "成功" }] });
  expect(createHash("sha256").update(readFileSync(report.review.ci.recordPath)).digest("hex")).toBe(report.review.ci.sha256);
  for (const line of ["### CI の結果（親だけが照合）", "\n- CI 判定: 成功", `\n- head SHA の一致: result.json の head ${"a".repeat(40)} と target.md の head ${"a".repeat(40)} が一致`, "\n- merge-ready: 付けた", "\n- マージ可否: 可（人のレビューなしでマージ可）"]) expect(document.content).toContain(line);
  // CI の結果は報告の ci-result の印の中だけにあり、印の外には CI 判定・マージ可否・merge-ready が無い（後のレビューの受け入れ確認への写しで印だけで除ける）。
  const outside = document.content.replace(/<!-- ci-result:begin -->\n[\s\S]*?<!-- ci-result:end -->/g, "");
  for (const part of ["CI 判定", "- マージ可否:", "- merge-ready:", "test=成功"]) expect(outside).not.toContain(part);
  expect(between(document.content, "ci-result")).toContain("- マージ可否: 可（人のレビューなしでマージ可）");
  expect(document.content).toMatch(/### CI の結果（親だけが照合）\n\nCI の結果は次の ci-result の印の中だけに書く。\n\n<!-- ci-result:begin -->\n[^<]*- CI 判定: 成功[^<]*<!-- ci-result:end -->/);
  const issue = Bun.spawnSync([scenario.nod, "issue", "show", "API-1", "--json"], { env: scenario.env });
  expect(issue.exitCode).toBe(0);
  const shownIssue = JSON.parse(issue.stdout.toString());
  expect(shownIssue).toMatchObject({ status: "in_progress", assignee: "codex", agentState: "working" });
  // 要約の作業ログ（--kind progress）には CI 判定・マージ可否を書かず、[ci-result] で始まる記録を参照する。
  const progressLogs = (shownIssue.activity as { logKind?: string | null; body?: string }[]).filter(item => item.logKind === "progress" && item.body?.includes(`報告Document ${report.review.reportDocument.id}`));
  expect(progressLogs).toHaveLength(1);
  expect(progressLogs[0]!.body).toContain("CI判定・マージ可否・merge-readyは[ci-result]の作業ログを参照");
  for (const part of ["CI判定成功", "CI 判定", "マージ可否可"]) expect(progressLogs[0]!.body).not.toContain(part);
  // マージ可なので、報告の保存と作業ログの後に実nodのIssueへmerge-readyが付き、判定したhead SHA・CI判定・報告Document IDを --kind test に1件残す。
  expect(shownIssue.labels).toContain("merge-ready");
  const mergeReadyLogs = (shownIssue.activity as { id: number; logKind?: string | null; body?: string }[]).filter(item => item.logKind === "test" && item.body?.startsWith("[ci-result] merge-ready: 付けた"));
  expect(mergeReadyLogs.map(item => item.id)).toEqual([report.review.mergeReadyLog]);
  for (const part of [`判定した head SHA ${"a".repeat(40)}、現在の head ${"a".repeat(40)}（一致）`, "基点 main", "CI 判定 成功", "test=成功（出典 workspace-rules", `報告Document ${report.review.reportDocument.id}`, `runId ${report.review.runId}`, `${report.review.workDirectory}/parent/ci/1/`]) expect(mergeReadyLogs[0]!.body).toContain(part);
  // 保存の後に親が書いた記録の id は own-logs.md に残る。
  expect(readFileSync(`${report.review.workDirectory}/parent/acceptance/own-logs.md`, "utf8")).toContain(`- ${report.review.mergeReadyLog}:`);
  const operations = readFileSync(scenario.log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(operations.filter(op => op.tool === "fixture")).toMatchObject([
    { origin: "worker", actor: "codex", simulated: true, argv: ["worker-start-state", "API-1"] },
  ]);
  expect(operations.filter(op => op.origin === "worker" && op.tool === "nod" && op.argv.includes("start"))).toEqual([]);
  const read = JSON.parse(orca("orchestration", "worker-read", "--dispatch", launch.dispatch.id).text);
  expect(read.gitEvidence).toMatchObject({ executionHost: "Studio", simulated: true, commands: [
    { argv: ["git", "rev-parse", "HEAD"], exitCode: 0, stdout: `${"a".repeat(40)}\n` },
    { argv: ["git", "show", "--no-patch", "a".repeat(40)], exitCode: 0 },
  ] });
});

test("初回レビューの保存時に対象の現在のheadが固定したheadと違えば、CI判定成功でもマージ不可でmerge-readyを付けない", async () => {
  const scenario = await createTask2Scenario();
  const nod = (...args: string[]) => {
    const result = Bun.spawnSync([scenario.nod, "-w", "API", ...args, "--json"], { env: scenario.env });
    expect(result.exitCode, result.stdout.toString()).toBe(0);
    return JSON.parse(result.stdout.toString());
  };
  // head a を固定してレビューした間に、別の作業者が c を追加した。a については完了・5点・確認が残る事項0件・CI判定成功がそろう。
  const review = recordInitialReview({
    dir: scenario.dir, issueId: "API-1", implementer: "term-implementation", baseCommit: "b".repeat(40), headCommit: "a".repeat(40), currentHead: "c".repeat(40),
    standards: { findings: [], evidence: "既存規約を確認" }, spec: { findings: [], evidence: "Issue要求を照合" }, ci: simulatedCi("a".repeat(40)),
  }, nodCliRecorder(nod));
  expect(review).toMatchObject({ status: "完了", score: 5, remainingChecks: [], ci: { headSha: "a".repeat(40), verdict: "成功" }, mergeReadiness: "不可（人の判断が要る）", mergeReady: "付けていない" });
  const issue = nod("issue", "show", "API-1") as { labels: string[]; activity: { id?: number; body?: string }[] };
  expect(issue.labels).not.toContain("merge-ready");
  const record = issue.activity.find(item => item.id === review.mergeReadyLog)!;
  expect(record.body).toStartWith(`[ci-result] merge-ready: 付けていない（マージ可否が不可: 対象版が現在の head と違う（追加コミット。固定した head ${"a".repeat(40)}、現在の head ${"c".repeat(40)}）`);
  expect(record.body).toContain(`現在の head ${"c".repeat(40)}（不一致）`);
  // 比べた結果は親専用領域と報告の ci-result の印の中に残る。
  expect(readFileSync(`${review.workDirectory}/parent/head-check.md`, "utf8")).toContain(`- マージ可否を決める直前: 固定した head ${"a".repeat(40)}／現在の head ${"c".repeat(40)}（不一致。対象版が現在の head と違う（追加コミット））`);
  const document = nod("doc", "show", String(review.auditDocument.id)) as { content: string };
  expect(between(document.content, "ci-result")).toContain(`- 現在の head の照合: 固定した head ${"a".repeat(40)}／現在の head ${"c".repeat(40)}（不一致`);
});

for (const variant of ["normal", "existing-pr", "acceptance-confirmed"] as const) {
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
    const submitted = JSON.parse(orca("check", "--ack", initial.id).messages[0].body);
    const pr = call(scenario.gh, ["pr", "view", "https://github.com/evaluation/api/pull/42"]);
    expect(pr).toMatchObject({ headRefOid: "a".repeat(40), state: "OPEN", isDraft: false });
    // PRのheadは初回レビューの対象版と同じなので、13節の再照合で同じheadのCI判定を記録してIn Reviewへ移す。CI判定は成功なのでmerge-readyは付いたまま。
    expect(submitted.ci).toMatchObject({ headSha: "a".repeat(40), verdict: "成功", ready: true, recheck: { reviewHead: "a".repeat(40), currentHead: "a".repeat(40), remainingChecks: [], mergeReadiness: "可（人のレビューなしでマージ可）", mergeReady: "付けた" } });
    expect(call(scenario.nod, ["-w", "API", "issue", "show", "API-1"])).toMatchObject({ status: "in_review", prUrl: pr.url, labels: expect.arrayContaining(["merge-ready"]) });
    orca("worker-release", "--dispatch", submission.dispatch.id);
    expect(orca("worker-list", "--run", "run-pm", "--terminal-state", "reclaimable", "--include-remote").workers).toEqual([]);
    const ops = readFileSync(scenario.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(ops.filter((op) => op.tool === "nod" && op.argv.includes("done"))).toHaveLength(0);
    expect(ops.filter((op) => op.tool === "gh" && op.argv.includes("create"))).toHaveLength(variant === "existing-pr" ? 0 : 1);
    expect(ops.filter((op) => op.tool === "gh" && op.argv.includes("edit"))).toHaveLength(variant === "existing-pr" ? 1 : 0);
  });
}

test("PM評価の受け入れ確認担当が確認済みとした初回レビューは4担当の組で完了・5点・マージ可になる", async () => {
  const scenario = await createTask2Scenario({ variant: "acceptance-confirmed" });
  const orca = (...args: string[]) => {
    const result = Bun.spawnSync([scenario.orca, ...args, "--json"], { env: scenario.env });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString()).result;
  };
  orca("orchestration", "run-create", "--objective", "一覧の余白を調整");
  const launch = orca("orchestration", "worker-start", "--on", "Studio", "--worktree", "new-top-level", "--repo", "id:repo-api", "--name", "list-spacing", "--agent", "codex", "--model", "gpt-6.1-sol", "--effort", "high", "--spec", "API-1。照合完了まで実装禁止");
  orca("orchestration", "send", "--to", `dispatch:${launch.dispatch.id}`, "--subject", "実装開始", "--body", "実装を開始してください");
  const report = JSON.parse(orca("orchestration", "check").messages[0].body);
  // 反証が作業記録の要求を受け入れ確認担当の行にし、受け入れ確認担当が確認済みとした。4担当の有効な結果がそろった完了で、受け入れ確認の結果は点数を変えない。
  expect(report.review).toMatchObject({ status: "完了", score: 5, agents: acceptanceAgents, remainingChecks: [], ci: { headSha: report.commit, verdict: "成功" }, mergeReadiness: "可（人のレビューなしでマージ可）", mergeReady: "付けた" });
  expect(report.review.acceptanceRows).toEqual([{ source: expect.stringContaining("作業ログ"), judgment: "確認済み", evidence: expect.any(String) }]);
  const ids = Object.values(report.review.agents as Record<string, { id: string }>).map(agent => agent.id);
  expect(ids).toHaveLength(4);
  expect(new Set([...ids, report.review.implementer]).size).toBe(5);
  // 受け入れ確認担当は反証の後に1回だけ起動され、反証の判定本文には受け入れ確認担当の行がある。
  expect(report.review.attempts.map((attempt: { role: string; attempt: number; result: string }) => [attempt.role, attempt.attempt, attempt.result])).toEqual([["standards", 1, "有効"], ["spec", 1, "有効"], ["refute", 1, "有効"], ["acceptance", 1, "有効"]]);
  const verdict = readFileSync(report.review.verdict.path, "utf8");
  expect(verdict).toContain(`| ${report.review.acceptanceRows[0].source} | 受け入れ確認担当 |`);
  const result = readFileSync(report.review.acceptance.path, "utf8");
  expect(createHash("sha256").update(result).digest("hex")).toBe(report.review.acceptance.sha256);
  expect(result).toContain("- 判定: 確認済み");
  // 原文の同一性は監査Documentで確かめる。
  const shown = Bun.spawnSync([scenario.nod, "doc", "show", String(report.review.auditDocument.id), "--json"], { env: scenario.env });
  const document = JSON.parse(shown.stdout.toString());
  expect(between(document.content, "refute-verdict")).toBe(verdict);
  expect(between(document.content, "acceptance-result")).toBe(result);
  expect(document.content).toContain("| 受け入れ確認 | code-reviewer-acceptance |");
  for (const line of ["- 最終状態: 完了", "- 確定した要対応の点数: 5", "- 確認が残る事項: 0 件", "- マージ可否: 可（人のレビューなしでマージ可）"]) expect(document.content).toContain(`\n${line}`);
  const issue = JSON.parse(Bun.spawnSync([scenario.nod, "issue", "show", "API-1", "--json"], { env: scenario.env }).stdout.toString()) as { activity: { logKind?: string | null; body?: string }[] };
  expect(issue.activity.filter(item => item.logKind === "progress" && item.body?.includes(`受け入れ確認=code-reviewer-acceptance/${report.review.agents.acceptance.id}`))).toHaveLength(1);
});

test("PM評価の保存直前の再照合は親自身の記録・Issueのイベント・判定に使っていない項目の解決だけでは止めず、完了・5点・マージ可のままにする", async () => {
  const scenario = await createTask2Scenario({ variant: "acceptance-own-records" });
  const orca = (...args: string[]) => {
    const result = Bun.spawnSync([scenario.orca, ...args, "--json"], { env: scenario.env });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString()).result;
  };
  orca("orchestration", "run-create", "--objective", "一覧の余白を調整");
  const launch = orca("orchestration", "worker-start", "--on", "Studio", "--worktree", "new-top-level", "--repo", "id:repo-api", "--name", "list-spacing", "--agent", "codex", "--model", "gpt-6.1-sol", "--effort", "high", "--spec", "API-1。照合完了まで実装禁止");
  orca("orchestration", "send", "--to", `dispatch:${launch.dispatch.id}`, "--subject", "実装開始", "--body", "実装を開始してください");
  const report = JSON.parse(orca("orchestration", "check").messages[0].body);
  // 受け入れ確認担当がデザインの正本と配置先の観測で確認済みとした後、保存直前までに、レビューの親自身が書いた経過の作業ログとコメント（own-logs に記録。
  // 実装者と同じ actor で書く）、人による優先度の変更（Issueのイベント）、判定に使っていない実装者の経過の作業ログ（写しの前に書かれた）の解決だけが起きた。
  expect(report.review).toMatchObject({ status: "完了", score: 5, agents: acceptanceAgents, remainingChecks: [], ci: { headSha: report.commit, verdict: "成功" }, mergeReadiness: "可（人のレビューなしでマージ可）", mergeReady: "付けた" });
  expect(report.review.acceptanceRows.map((row: { judgment: string }) => row.judgment)).toEqual(["確認済み", "確認済み"]);
  const issue = JSON.parse(Bun.spawnSync([scenario.nod, "issue", "show", "API-1", "--json"], { env: scenario.env }).stdout.toString()) as { activity: { kind: string; actor: string; type?: string; logKind?: string | null; body?: string; resolvedAt?: string | null }[] };
  expect(issue.activity.filter(item => item.logKind === "progress" && item.actor === "codex" && item.body?.startsWith("独立レビューの親の記録"))).toHaveLength(1);
  expect(issue.activity.filter(item => item.kind === "comment" && item.logKind === null && item.actor === "codex" && item.body?.startsWith("独立レビューの途中経過"))).toHaveLength(1);
  expect(issue.activity.filter(item => item.body === "進捗: 一覧画面のスクリーンショットを整理している" && item.logKind === "progress" && item.resolvedAt)).toHaveLength(1);
  expect(issue.activity.filter(item => item.kind === "event" && item.type === "priority_changed" && item.actor === "me")).toHaveLength(1);
  const document = JSON.parse(Bun.spawnSync([scenario.nod, "doc", "show", String(report.review.auditDocument.id), "--json"], { env: scenario.env }).stdout.toString());
  for (const line of ["- 最終状態: 完了", "- 確定した要対応の点数: 5", "- 確認が残る事項: 0 件", "- マージ可否: 可（人のレビューなしでマージ可）"]) expect(document.content).toContain(`\n${line}`);
  expect(document.content).toContain("### 保存直前の受け入れ証拠の再照合");
  expect(document.content).toMatch(/- 固定の後に足された Activity: \d+ 件（親以外の追記 0 件。止めなかった親自身の記録 2 件、Issue のイベント [1-9]\d* 件）/);
  expect(document.content).toContain("観測時点までの確認であり、将来の配置状態は保証しない");
});

for (const variant of ["acceptance-ci-recheck", "acceptance-ci-recheck-unrecorded"] as const) {
  test(`PM評価の受け入れ確認担当を起動したレビューは保存時のCI結果なしで不可のまま、PR作業後の13節の再照合でmerge-readyを決める（${variant}）`, async () => {
    const scenario = await createTask2Scenario({ variant });
    const orca = (...args: string[]) => {
      const result = Bun.spawnSync([scenario.orca, "orchestration", ...args, "--json"], { env: scenario.env });
      expect(result.exitCode).toBe(0);
      return JSON.parse(result.stdout.toString()).result;
    };
    type Issue = { status: string; labels: string[]; activity: { id: number; kind: string; actor: string; logKind?: string | null; body?: string }[] };
    const issue = () => JSON.parse(Bun.spawnSync([scenario.nod, "-w", "API", "issue", "show", "API-1", "--json"], { env: scenario.env }).stdout.toString()) as Issue;
    orca("run-create", "--objective", "一覧の余白を調整");
    const implementation = orca("worker-start", "--spec", "API-1。照合完了まで実装禁止", "--on", "Studio", "--worktree", "new-top-level", "--repo", "id:repo-api", "--name", "list-spacing", "--agent", "codex", "--model", "gpt-6.1-sol", "--effort", "high");
    orca("send", "--to", `dispatch:${implementation.dispatch.id}`, "--subject", "実装開始", "--body", "実装を開始してください");
    const initial = orca("check");
    const report = JSON.parse(initial.messages[0].body);
    // 保存時はpush前でheadのCIに結果が無い。4担当がそろった完了・5点・確認が残る事項0件でも、CI判定結果なしでマージ不可、ラベルなし。
    expect(report.review).toMatchObject({ status: "完了", score: 5, agents: acceptanceAgents, remainingChecks: [], ci: { headSha: "a".repeat(40), verdict: "結果なし" }, mergeReadiness: "不可（人の判断が要る）", mergeReady: "付けていない" });
    expect(issue().labels).not.toContain("merge-ready");
    const document = JSON.parse(Bun.spawnSync([scenario.nod, "doc", "show", String(report.review.auditDocument.id), "--json"], { env: scenario.env }).stdout.toString());
    for (const line of ["- 確認が残る事項: 0 件", "- マージ可否: 不可（人の判断が要る）", "- CI 判定: 結果なし", "- merge-ready: 付けていない"]) expect(document.content).toContain(`\n${line}`);
    expect(document.content).toContain("CI の完了後に親の手順の13節の CI の再照合で判定し直す。");
    // 対照のため、PR作業の前に古い判定のmerge-readyが付いた状態にする（人の操作。Issueのイベントは追記に数えない）。
    if (variant === "acceptance-ci-recheck-unrecorded") Bun.spawnSync([scenario.nod, "-w", "API", "issue", "update", "API-1", "--add-label", "merge-ready", "--json"], { env: scenario.env });
    const task = orca("task-create", "--spec", "API-1の現在commitの証跡を確認済み。gpt-6.1-sol:highを維持してpushとPR作成・CIの照合・nod提出だけを行う");
    const submission = orca("worker-start", "--task", task.id, "--terminal", implementation.terminalId, "--worktree", `id:${implementation.worktreeId}`);
    const submitted = JSON.parse(orca("check", "--ack", initial.id).messages[0].body);
    const after = issue();
    const prLog = after.activity.find(item => item.logKind === "progress" && item.body?.startsWith("PR作業:"))!;
    const ownLogs = readFileSync(`${report.review.workDirectory}/parent/acceptance/own-logs.md`, "utf8");
    const record = readFileSync(submitted.ci.recheck.recordPath, "utf8");
    expect(submitted.ci.recheck.recordPath).toBe(`${report.review.workDirectory}/parent/recheck-2/record.md`);
    expect(JSON.parse(readFileSync(`${report.review.workDirectory}/parent/ci/2/result.json`, "utf8"))).toMatchObject({ verdict: "成功", head: "a".repeat(40) });
    const recheckLogs = after.activity.filter(item => item.logKind === "test" && item.body?.includes("CI の再照合 2"));
    expect(recheckLogs.map(item => item.id)).toEqual([submitted.ci.recheck.log]);
    for (const part of [`判定した head SHA ${"a".repeat(40)}`, "CI 判定 成功", `報告Document ${report.review.reportDocument.id}`]) expect(recheckLogs[0]!.body).toContain(part);
    if (variant === "acceptance-ci-recheck") {
      // 実装担当がPRの記録を nod --json で書いて id を own-logs に記録したので親自身の記録になり、同じheadのCI判定成功でマージ可、merge-readyが付き、In Reviewへ移る。
      expect(ownLogs).toContain(`- ${prLog.id}: PR作業の記録`);
      expect(submitted.ci).toMatchObject({ verdict: "成功", ready: true, recheck: { remainingChecks: [], mergeReadiness: "可（人のレビューなしでマージ可）", mergeReady: "付けた" } });
      expect(after).toMatchObject({ status: "in_review", labels: expect.arrayContaining(["merge-ready"]) });
      expect(recheckLogs[0]!.body).toStartWith("[ci-result] merge-ready: 付けた");
      for (const line of ["- merge-ready: 付けた", "- マージ可否: 可（人のレビューなしでマージ可）", "受け入れ証拠は確認が残る事項を 0 件加えた"]) expect(record).toContain(line);
    } else {
      // id を記録しなかったPRの記録は、実装担当（親と同じ actor）が書いたものでも親以外の追記になり、判定に使った証拠を使った2行に確認が残る事項が付く。
      // CI判定は成功でもマージ不可で、付いていたmerge-readyは外れる。In Reviewにならないのは確認が残る事項が加わったためで、CI判定が理由ではない。
      expect(ownLogs).not.toContain(`- ${prLog.id}:`);
      expect(prLog.actor).toBe("codex");
      expect(submitted.ci).toMatchObject({ verdict: "成功", ready: false, recheck: { mergeReadiness: "不可（人の判断が要る）", mergeReady: "外した" } });
      expect(submitted.ci.recheck.remainingChecks).toEqual([
        { source: expect.stringContaining("デザインの正本"), owner: "受け入れ確認担当（新しい実行）", reason: expect.stringContaining(`親以外の追記（使用した証拠の有効性を確認できない。親は意味を判断しない。activity:${prLog.id}（`) },
        { source: expect.stringContaining("配置先"), owner: "受け入れ確認担当（新しい実行）", reason: expect.stringContaining(`activity:${prLog.id}（`) },
      ]);
      expect(after.status).toBe("in_progress");
      expect(after.labels).not.toContain("merge-ready");
      expect(recheckLogs[0]!.body).toStartWith("[ci-result] merge-ready: 外した");
      for (const line of ["- merge-ready: 外した", "- マージ可否: 不可（人の判断が要る）", "受け入れ証拠は確認が残る事項を 2 件加えた"]) expect(record).toContain(line);
    }
    // 報告Documentは書き換えない。
    expect(JSON.parse(Bun.spawnSync([scenario.nod, "doc", "show", String(report.review.auditDocument.id), "--json"], { env: scenario.env }).stdout.toString()).content).toBe(document.content);
    orca("worker-release", "--dispatch", submission.dispatch.id);
  });
}

for (const variant of ["ci-failure", "ci-pending", "ci-no-required"] as const) {
  test(`PM評価は同じheadのCI判定が成功でなくても既存の条件が揃えばPR作業からIn Reviewへ移し、マージ可否は不可・merge-readyなしのままにする（${variant}）`, async () => {
    const scenario = await createTask2Scenario({ variant });
    const orca = (...args: string[]) => {
      const result = Bun.spawnSync([scenario.orca, "orchestration", ...args, "--json"], { env: scenario.env });
      expect(result.exitCode).toBe(0);
      return JSON.parse(result.stdout.toString()).result;
    };
    const issue = () => JSON.parse(Bun.spawnSync([scenario.nod, "-w", "API", "issue", "show", "API-1", "--json"], { env: scenario.env }).stdout.toString()) as { status: string; labels: string[]; activity: { id: number; logKind?: string | null; body?: string }[] };
    const verdict = ({ "ci-failure": "失敗", "ci-pending": "未確定", "ci-no-required": "必須のチェックなし" } as const)[variant];
    orca("run-create", "--objective", "一覧の余白を調整");
    const implementation = orca("worker-start", "--spec", "API-1。照合完了まで実装禁止", "--on", "Studio", "--worktree", "new-top-level", "--repo", "id:repo-api", "--name", "list-spacing", "--agent", "codex", "--model", "gpt-6.1-sol", "--effort", "high");
    orca("send", "--to", `dispatch:${implementation.dispatch.id}`, "--subject", "実装開始", "--body", "実装を開始してください");
    const initial = orca("check");
    const report = JSON.parse(initial.messages[0].body);
    // 完了・5点・確認が残る事項0件で、CI判定だけが成功でない。マージ可否は不可でラベルなし、blockerは無い。
    expect(report.review).toMatchObject({ status: "完了", score: 5, remainingChecks: [], ci: { headSha: "a".repeat(40), verdict }, mergeReadiness: "不可（人の判断が要る）", mergeReady: "付けていない" });
    expect(issue().activity.filter(item => item.logKind === "blocker")).toHaveLength(0);
    const document = JSON.parse(Bun.spawnSync([scenario.nod, "doc", "show", String(report.review.reportDocument.id), "--json"], { env: scenario.env }).stdout.toString());
    // CI判定が成功でないことだけを理由に止めず、同じ実装者へPR作業を依頼する。偽GitHubのCIはPRの後も同じ判定のまま。
    const task = orca("task-create", "--spec", "API-1の現在commitの証跡を確認済み。gpt-6.1-sol:highを維持してpushとPR作成・CIの照合・nod提出だけを行う");
    const submission = orca("worker-start", "--task", task.id, "--terminal", implementation.terminalId, "--worktree", `id:${implementation.worktreeId}`);
    const submitted = JSON.parse(orca("check", "--ack", initial.id).messages[0].body);
    // 13節の再照合でCI判定を記録し、マージ可否は不可・merge-readyなしのまま、In Reviewへ移る。
    expect(submitted.ci).toMatchObject({ headSha: "a".repeat(40), verdict, ready: true, recheck: { remainingChecks: [], mergeReadiness: "不可（人の判断が要る）", mergeReady: "付けていない" } });
    expect(JSON.parse(readFileSync(`${report.review.workDirectory}/parent/ci/2/result.json`, "utf8"))).toMatchObject({ verdict, head: "a".repeat(40) });
    const after = issue();
    expect(after.status).toBe("in_review");
    expect(after.labels).not.toContain("merge-ready");
    const recheckLogs = after.activity.filter(item => item.logKind === "test" && item.body?.includes("CI の再照合 2"));
    expect(recheckLogs.map(item => item.id)).toEqual([submitted.ci.recheck.log]);
    expect(recheckLogs[0]!.body).toStartWith(`[ci-result] merge-ready: 付けていない（マージ可否が不可: CI 判定 ${verdict}`);
    // 報告Documentは書き換えない。
    expect(JSON.parse(Bun.spawnSync([scenario.nod, "doc", "show", String(report.review.reportDocument.id), "--json"], { env: scenario.env }).stdout.toString()).content).toBe(document.content);
    orca("worker-release", "--dispatch", submission.dispatch.id);
  });
}

test("PM評価のPR紐付けとrefreshは状態を変えず、LLMのdoneだけで完了する", async () => {
  const scenario = await createTask2Scenario({ variant: "existing-pr", beforeAdoption(db) {
    // PR操作の前提となる既存実行を採択前に作る。
    startIssue({ db, actor: "codex" }, "API-1");
  } });
  const nod = (...args: string[]) => {
    const result = Bun.spawnSync([scenario.nod, ...args, "--json"], { env: scenario.env });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString());
  };
  // 採択後も、元の担当による再開startは通常どおり成功する。
  expect(nod("issue", "start", "API-1")).toMatchObject({ status: "in_progress", assignee: "codex" });
  expect(nod("issue", "show", "API-1").status).toBe("in_progress");
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

for (const variant of ["model-mismatch", "model-unknown", "unsupported", "ci-failure", "ci-pending", "ci-no-required", "evidence-missing", "remaining-checks", "review-not-run", "review-usage-limit", "review-redelegated", "acceptance-unmet", "acceptance-unverified", "acceptance-missing", "acceptance-evidence-changed", "acceptance-others-appended"] as const) {
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
    const issue = () => JSON.parse(call(scenario.nod, ["issue", "show", "API-1"]).stdout.toString()) as { status: string; labels: string[]; activity: { logKind?: string | null; body?: string }[] };
    const logs = (kind: string) => issue().activity.filter(item => item.logKind === kind && item.body?.includes(`報告Document ${report.review.reportDocument.id}`));
    if (variant === "ci-failure" || variant === "ci-pending" || variant === "ci-no-required") {
      // 3担当の有効な結果がそろった完了・5点・確認が残る事項0件でも、同じheadのCI判定が成功でなければマージ可否だけが不可になる。レビューの原文と点数はCIで変わらない。
      const verdict = ({ "ci-failure": "失敗", "ci-pending": "未確定", "ci-no-required": "必須のチェックなし" } as const)[variant];
      expect(report.tests[0]).toMatchObject({ exitCode: 0, passed: true });
      expect(report.review).toMatchObject({ status: "完了", score: 5, agents: reviewAgents, remainingChecks: [], ci: { headSha: report.commit, verdict }, mergeReadiness: "不可（人の判断が要る）", mergeReady: "付けていない" });
      expect(JSON.parse(readFileSync(report.review.ci.recordPath, "utf8"))).toMatchObject({ verdict, head: report.commit, required: variant === "ci-no-required" ? [] : [{ context: "test", result: verdict }] });
      const verdictText = readFileSync(report.review.verdict.path, "utf8");
      expect(createHash("sha256").update(verdictText).digest("hex")).toBe(report.review.verdict.sha256);
      expect(verdictText).not.toContain("CI");
      const document = JSON.parse(call(scenario.nod, ["doc", "show", String(report.review.auditDocument.id)]).stdout.toString());
      expect(between(document.content, "refute-verdict")).toBe(verdictText);
      for (const line of ["- 最終状態: 完了", "- 確定した要対応の点数: 5", "- 確認が残る事項: 0 件", "- マージ可否: 不可（人の判断が要る）", `- CI 判定: ${verdict}`, "- merge-ready: 付けていない（マージ可否が不可）"]) expect(document.content).toContain(`\n${line}`);
      expect(document.content).toContain(`  - 不可の理由: CI 判定 ${verdict}`);
      // ラベルは付かず、付けなかったことと理由・判定したheadを --kind test に残す。
      expect(issue().labels).not.toContain("merge-ready");
      expect(logs("test").filter(item => item.body?.startsWith(`[ci-result] merge-ready: 付けていない（マージ可否が不可: CI 判定 ${verdict}`) && item.body.includes(`判定した head SHA ${report.commit}`))).toHaveLength(1);
      // 要約の作業ログには CI 判定を書かず、[ci-result] の記録を参照する。
      expect(logs("progress").filter(item => item.body?.includes("CI判定・マージ可否・merge-readyは[ci-result]の作業ログを参照") && !item.body.includes(`CI判定${verdict}`))).toHaveLength(1);
      // CI判定が成功でないことだけでは止めないので、blockerは記録されない。
      expect(logs("blocker")).toHaveLength(0);
    } else if (variant === "remaining-checks") {
      // 3担当の有効な結果があり反証の判定が確定した完了。確定した要対応0件の5点のまま、反証が理由と担当を示した未確認が確認が残る事項になり、マージ可否だけが不可になる。
      expect(report.tests[0]).toMatchObject({ exitCode: 0, passed: true });
      expect(report.review).toMatchObject({ status: "完了", score: 5, agents: reviewAgents, ci: { headSha: report.commit, verdict: "成功" }, mergeReadiness: "不可（人の判断が要る）", mergeReady: "付けていない" });
      expect(issue().labels).not.toContain("merge-ready");
      expect(report.review.remainingChecks).toEqual([{ source: expect.stringContaining("requirements/issue.md"), owner: expect.any(String), reason: expect.stringContaining("要実行確認") }]);
      const verdict = readFileSync(report.review.verdict.path, "utf8");
      expect(createHash("sha256").update(verdict).digest("hex")).toBe(report.review.verdict.sha256);
      expect(verdict).toContain(`| ${report.review.remainingChecks[0].source} | 未確認 |`);
      const document = JSON.parse(call(scenario.nod, ["doc", "show", String(report.review.reportDocument.id)]).stdout.toString());
      // 最終状態・確定した要対応の点数・確認が残る事項・マージ可否を別項目で報告する。
      for (const line of ["- 最終状態: 完了", "- 確定した要対応の点数: 5", "- 確認が残る事項: 1 件", "- マージ可否: 不可（人の判断が要る）"]) expect(document.content).toContain(`\n${line}`);
      expect(document.content).toContain(`| ${report.review.remainingChecks[0].source} | ${report.review.remainingChecks[0].owner} | ${report.review.remainingChecks[0].reason} |`);
      expect(logs("progress").filter(item => item.body?.includes("確認が残る事項1件"))).toHaveLength(1);
      expect(logs("blocker")).toHaveLength(0);
    } else if (variant === "evidence-missing") {
      // Spec探索が判定と無関係な失敗で無効になり、親が1回だけ再委譲した担当も有効な結果を返さず、反証へ進めない未完了。点数なしのblockerで、古いcommitを対象にしている。
      expect(report.review).toMatchObject({ status: "未完了", score: null, verdict: null, remainingChecks: [], mergeReadiness: "不可（人の判断が要る）", agents: { standards: reviewAgents.standards } });
      expect(report.review.agents.spec).toBeUndefined();
      expect(report.review.agents.refute).toBeUndefined();
      expect(report.review.spec).toBeUndefined();
      expect(report.review.headCommit).not.toBe(report.commit);
      expect(report.review.target.headSha).not.toBe(report.commit);
      // 再委譲は1回だけで、2回目も無効なら3回目は無い。2つの試行は別の担当IDで、どちらも監査用に残る。
      const specAttempts = report.review.attempts.filter((attempt: { role: string }) => attempt.role === "spec");
      expect(specAttempts.map((attempt: { attempt: number; result: string }) => [attempt.attempt, attempt.result])).toEqual([[1, "無効"], [2, "無効"]]);
      expect(new Set(specAttempts.map((attempt: { id: string }) => attempt.id)).size).toBe(2);
      expect(specAttempts.every((attempt: { saved?: { path: string } }) => attempt.saved?.path.includes("/parent/attempts/spec-"))).toBe(true);
      const document = JSON.parse(call(scenario.nod, ["doc", "show", String(report.review.reportDocument.id)]).stdout.toString());
      expect(document.content).toContain("\n- 最終状態: 未完了（理由: 有効な結果なし（Spec 探索。1回の再委譲の後も）");
      expect(document.content).toContain("\n- 確定した要対応の点数: 点数なし");
      expect(logs("blocker")).toHaveLength(1);
      expect(logs("progress")).toHaveLength(0);
    } else if (variant === "review-redelegated") {
      // Standards探索の最初の試行が禁止項目の混入（引き渡し形式違反）で無効になり、親が同じ入力で1回だけ再委譲した担当が有効な結果を返した完了。
      expect(report.review).toMatchObject({ status: "完了", score: 5, agents: reviewAgents, remainingChecks: [], ci: { headSha: report.commit, verdict: "成功" }, mergeReadiness: "可（人のレビューなしでマージ可）", mergeReady: "付けた" });
      const standardsAttempts = report.review.attempts.filter((attempt: { role: string }) => attempt.role === "standards");
      expect(standardsAttempts).toEqual([
        { role: "standards", attempt: 1, id: expect.any(String), result: "無効", reason: expect.stringContaining("確信度"), ompRetries: [], redelegation: "した（同じ入力・同じ依頼本文で新しいコンテキストへ1回）", saved: { path: expect.stringContaining("/parent/attempts/standards-1/"), sha256: expect.any(String) } },
        { role: "standards", attempt: 2, id: report.review.agents.standards.id, result: "有効", ompRetries: [] },
      ]);
      expect(standardsAttempts[0].id).not.toBe(standardsAttempts[1].id);
      expect(createHash("sha256").update(readFileSync(standardsAttempts[0].saved.path)).digest("hex")).toBe(standardsAttempts[0].saved.sha256);
      // 有効だったSpec探索と反証は1回の試行のまま。最初の無効な試行は反証の判定へ渡らない。
      expect(report.review.attempts.filter((attempt: { role: string }) => attempt.role !== "standards").map((attempt: { attempt: number; result: string }) => [attempt.attempt, attempt.result])).toEqual([[1, "有効"], [1, "有効"]]);
      expect(readFileSync(report.review.verdict.path, "utf8")).not.toContain(standardsAttempts[0].id);
      // 報告は両方の試行を持ち、omp内部の再試行と親による再委譲を区別する。
      const document = JSON.parse(call(scenario.nod, ["doc", "show", String(report.review.auditDocument.id)]).stdout.toString());
      expect(document.content).toContain("\n- 最終状態: 完了");
      expect(document.content).toContain("### 試行の記録");
      for (const attempt of standardsAttempts) expect(document.content).toContain(`| Standards 探索 | ${attempt.attempt} | ${attempt.id} | ${attempt.result} |`);
      expect(document.content).toContain("| omp 内部の再試行 | 親による再委譲 |");
      expect(logs("progress").filter(item => item.body?.includes(standardsAttempts[0].id))).toHaveLength(1);
      expect(logs("blocker")).toHaveLength(0);
    } else if (variant === "review-usage-limit") {
      // Spec探索が利用枠の上限（HTTP 429）で失敗した未完了。親は再委譲せずその時点で止め、反証も起動しない。
      expect(report.review).toMatchObject({ status: "未完了", score: null, verdict: null, remainingChecks: [], mergeReadiness: "不可（人の判断が要る）", agents: { standards: reviewAgents.standards } });
      expect(report.review.agents.spec).toBeUndefined();
      expect(report.review.agents.refute).toBeUndefined();
      // Spec探索の試行は最初の1回だけで、親による再委譲は無い。終了通知は監査用に親専用領域へ残し、担当のセッション内のomp内部の再試行は別に残る。
      const specAttempts = report.review.attempts.filter((attempt: { role: string }) => attempt.role === "spec");
      expect(specAttempts).toEqual([
        { role: "spec", attempt: 1, id: expect.any(String), result: "利用枠の上限", reason: expect.stringContaining("429"), ompRetries: [expect.stringContaining("retry.maxDelayMs")], redelegation: "しない（利用枠の上限）", saved: { path: expect.stringContaining("/parent/attempts/spec-1/"), sha256: expect.any(String) } },
      ]);
      expect(createHash("sha256").update(readFileSync(specAttempts[0].saved.path)).digest("hex")).toBe(specAttempts[0].saved.sha256);
      expect(report.review.attempts.filter((attempt: { role: string }) => attempt.role === "refute")).toEqual([]);
      const document = JSON.parse(call(scenario.nod, ["doc", "show", String(report.review.reportDocument.id)]).stdout.toString());
      expect(document.content).toContain("\n- 最終状態: 未完了（理由: 利用枠の上限、有効な結果なし");
      expect(document.content).toContain("\n- 確定した要対応の点数: 点数なし");
      expect(logs("blocker").filter(item => item.body?.includes("利用枠の上限"))).toHaveLength(1);
      expect(logs("progress")).toHaveLength(0);
    } else if (variant === "acceptance-unmet" || variant === "acceptance-unverified") {
      // 4担当の有効な結果がそろった完了・5点。受け入れ確認の「未充足」「確かめられず」は点数を変えず、確認が残る事項としてマージ可否だけを止める。
      const judgment = variant === "acceptance-unmet" ? "未充足" : "確かめられず";
      expect(report.tests[0]).toMatchObject({ exitCode: 0, passed: true });
      expect(report.review).toMatchObject({ status: "完了", score: 5, agents: acceptanceAgents, ci: { headSha: report.commit, verdict: "成功" }, mergeReadiness: "不可（人の判断が要る）", mergeReady: "付けていない" });
      expect(report.review.acceptanceRows).toEqual([{ source: expect.stringContaining("作業ログ"), judgment, evidence: expect.any(String) }]);
      expect(report.review.remainingChecks).toEqual([{ source: report.review.acceptanceRows[0].source, owner: "受け入れ確認担当", reason: expect.stringContaining(judgment) }]);
      expect(new Set([...Object.values(report.review.agents as Record<string, { id: string }>).map(agent => agent.id), report.review.implementer]).size).toBe(5);
      const verdict = readFileSync(report.review.verdict.path, "utf8");
      expect(verdict).toContain(`| ${report.review.acceptanceRows[0].source} | 受け入れ確認担当 |`);
      // 複合要求のコードから判断できる部分は反証の対応表に別の行として残る。
      expect(verdict).toContain("| requirements/issue.md（一覧の余白を12pxにする） | 充足 |");
      const result = readFileSync(report.review.acceptance.path, "utf8");
      expect(createHash("sha256").update(result).digest("hex")).toBe(report.review.acceptance.sha256);
      expect(result).toContain(`- 判定: ${judgment}`);
      const document = JSON.parse(call(scenario.nod, ["doc", "show", String(report.review.auditDocument.id)]).stdout.toString());
      expect(between(document.content, "refute-verdict")).toBe(verdict);
      expect(between(document.content, "acceptance-result")).toBe(result);
      for (const line of ["- 最終状態: 完了", "- 確定した要対応の点数: 5", "- 確認が残る事項: 1 件", "- マージ可否: 不可（人の判断が要る）"]) expect(document.content).toContain(`\n${line}`);
      expect(document.content).toContain(`| ${report.review.remainingChecks[0].source} | 受け入れ確認担当 | ${report.review.remainingChecks[0].reason} |`);
      expect(logs("progress").filter(item => item.body?.includes("確認が残る事項1件") && item.body?.includes(judgment))).toHaveLength(1);
      expect(logs("blocker")).toHaveLength(0);
    } else if (variant === "acceptance-evidence-changed") {
      // 受け入れ確認担当がデザインの正本と配置先の観測で2行とも確認済みとした後、保存直前の再照合で、判定に使った外部の正本の変化、
      // 根拠にした添付Documentの訂正、人が配置の記録を取り消すトップレベルのコメントが見つかった。担当の判定本文・完了・点数は変えず、親が確認が残る事項を追記してマージ不可にする。
      expect(report.tests[0]).toMatchObject({ exitCode: 0, passed: true });
      expect(report.review).toMatchObject({ status: "完了", score: 5, agents: acceptanceAgents, ci: { headSha: report.commit, verdict: "成功" }, mergeReadiness: "不可（人の判断が要る）", mergeReady: "付けていない" });
      const [design, deploy] = report.review.acceptanceRows as [{ source: string; judgment: string }, { source: string; judgment: string }];
      expect([design.judgment, deploy.judgment]).toEqual(["確認済み", "確認済み"]);
      expect(design.source).toContain("デザインの正本");
      expect(deploy.source).toContain("配置先");
      const owner = "受け入れ確認担当（新しい実行）";
      // 人のトップレベルのコメントは親以外の追記として、判定に使った証拠を使ったすべての行に付く。
      expect(report.review.remainingChecks).toEqual([
        { source: design.source, owner, reason: expect.stringContaining("外部の正本の変化") },
        { source: deploy.source, owner, reason: expect.stringContaining("訂正") },
        { source: design.source, owner, reason: expect.stringContaining("親以外の追記") },
        { source: deploy.source, owner, reason: expect.stringContaining("親以外の追記") },
      ]);
      // 反証は外部の正本を名指しし、受け入れ確認担当は内容の一致と更新順序、不変版と現在の配置を分けて判定した。
      const verdict = readFileSync(report.review.verdict.path, "utf8");
      expect(createHash("sha256").update(verdict).digest("hex")).toBe(report.review.verdict.sha256);
      expect(verdict).toContain("/evaluation/design/list-spacing.md");
      const result = readFileSync(report.review.acceptance.path, "utf8");
      expect(createHash("sha256").update(result).digest("hex")).toBe(report.review.acceptance.sha256);
      for (const line of ["- 外部の正本との内容の一致: 確認済み", "- 更新順序: 確認済み", "- 成果物の不変版の存在: 確認済み", "- 現在の配置: 確認済み"]) expect(result).toContain(line);
      expect(result).not.toContain("未充足");
      expect(result).toContain("## 判定に使った証拠");
      // 報告は担当の判定本文と結果を原文のまま収録し、再照合の結果は親が別の節と確認が残る事項に書く。
      const document = JSON.parse(call(scenario.nod, ["doc", "show", String(report.review.auditDocument.id)]).stdout.toString());
      expect(between(document.content, "refute-verdict")).toBe(verdict);
      expect(between(document.content, "acceptance-result")).toBe(result);
      for (const line of ["- 最終状態: 完了", "- 確定した要対応の点数: 5", "- 確認が残る事項: 4 件", "- マージ可否: 不可（人の判断が要る）"]) expect(document.content).toContain(`\n${line}`);
      for (const check of report.review.remainingChecks) expect(document.content).toContain(`| ${check.source} | ${check.owner} | ${check.reason} |`);
      expect(document.content).toContain("### 保存直前の受け入れ証拠の再照合");
      expect(document.content).toContain("観測時点までの確認であり、将来の配置状態は保証しない");
      expect(logs("progress").filter(item => item.body?.includes("確認が残る事項4件") && item.body?.includes("外部の正本の変化"))).toHaveLength(1);
      expect(logs("blocker")).toHaveLength(0);
    } else if (variant === "acceptance-others-appended") {
      // 受け入れ確認担当がデザインの正本と配置先の観測で2行とも確認済みとし、証拠の写しの指紋は変わっていない。写しの後・保存の前に、親以外が次を足した:
      // 実装者（レビューの親と同じ actor）の経過（progress）とテスト（test）の作業ログ、人による配置先の作業ログ（evidence/3 の参照元）への出典の文字列を含まない撤回の返信、
      // 人の確認依頼の追加と、写しの前からあった確認依頼への回答。親は種類・書いた人・返信先・本文を問わず、判定に使った証拠を使ったすべての行に確認が残る事項を付けてマージ不可にする。
      // 同じ時期に書いたレビューの親自身の経過の作業ログ（own-logs に記録）は止めない。
      expect(report.tests[0]).toMatchObject({ exitCode: 0, passed: true });
      expect(report.review).toMatchObject({ status: "完了", score: 5, agents: acceptanceAgents, ci: { headSha: report.commit, verdict: "成功" }, mergeReadiness: "不可（人の判断が要る）", mergeReady: "付けていない" });
      const [design, deploy] = report.review.acceptanceRows as [{ source: string; judgment: string }, { source: string; judgment: string }];
      expect([design.judgment, deploy.judgment]).toEqual(["確認済み", "確認済み"]);
      type Reply = { id: number; actor: string; body: string };
      type Item = { kind: string; id?: number; at: string; actor: string; body?: string; logKind?: string | null; replies?: Reply[]; answer?: string | null; answeredBy?: string | null };
      const activity = issue().activity as unknown as Item[];
      const progress = activity.find(item => item.body === "進捗: 一覧画面のスクリーンショットを差し替えた")!;
      const testLog = activity.find(item => item.body === "bun test test/list-spacing.test.ts 成功（実装者の確認）")!;
      const own = activity.find(item => item.logKind === "progress" && item.body?.startsWith("独立レビューの親の記録"))!;
      expect([progress.logKind, progress.actor, testLog.logKind, testLog.actor, own.actor]).toEqual(["progress", "codex", "test", "codex", "codex"]);
      const deployLog = activity.find(item => item.kind === "comment" && item.body?.includes("/evaluation/deploy/list/current"))!;
      const reply = deployLog.replies!.find(item => item.actor === "me")!;
      for (const source of ["/evaluation/deploy", "Document 5", "/evaluation/design"]) expect(reply.body).not.toContain(source);
      const answered = activity.find(item => item.kind === "question" && item.answer !== null)!;
      const asked = activity.find(item => item.kind === "question" && item.answer === null)!;
      expect([answered.actor, answered.answeredBy, asked.actor]).toEqual(["me", "me", "me"]);
      const owner = "受け入れ確認担当（新しい実行）";
      const appended = [`activity:${progress.id}`, `activity:${testLog.id}`, `activity:${reply.id}`, `activity@${asked.at}`, `activity@${answered.at}`];
      const checks = report.review.remainingChecks as { source: string; owner: string; reason: string }[];
      expect(checks).toHaveLength(10);
      for (const id of appended) expect(checks.filter(check => check.reason.includes(`${id}（`))).toEqual([design, deploy].map(row => ({ source: row.source, owner, reason: expect.stringContaining("親以外の追記") })));
      expect(checks.filter(check => check.reason.includes(`activity:${reply.id}（`) && check.reason.includes(`activity:${deployLog.id} への返信`))).toHaveLength(2);
      expect(checks.filter(check => check.reason.includes(`activity:${own.id}（`))).toEqual([]);
      const result = readFileSync(report.review.acceptance.path, "utf8");
      expect(createHash("sha256").update(result).digest("hex")).toBe(report.review.acceptance.sha256);
      const document = JSON.parse(call(scenario.nod, ["doc", "show", String(report.review.auditDocument.id)]).stdout.toString());
      expect(between(document.content, "acceptance-result")).toBe(result);
      for (const line of ["- 最終状態: 完了", "- 確定した要対応の点数: 5", "- 確認が残る事項: 10 件", "- マージ可否: 不可（人の判断が要る）"]) expect(document.content).toContain(`\n${line}`);
      for (const check of checks) expect(document.content).toContain(`| ${check.source} | ${check.owner} | ${check.reason} |`);
      expect(document.content).toMatch(/- 固定の後に足された Activity: \d+ 件（親以外の追記 5 件: .+。止めなかった親自身の記録 1 件、Issue のイベント \d+ 件）/);
      expect(logs("progress").filter(item => item.body?.includes("確認が残る事項10件") && item.body?.includes("親以外の追記"))).toHaveLength(1);
      expect(logs("blocker")).toHaveLength(0);
    } else if (variant === "acceptance-missing") {
      // 反証が受け入れ確認担当の行を作ったが、受け入れ確認担当が1回の再委譲の後も有効な結果を返さなかった。必要な担当が欠けた未完了で、点数なしのblocker。
      expect(report.review).toMatchObject({ status: "未完了", score: null, acceptance: null, remainingChecks: [], mergeReadiness: "不可（人の判断が要る）", agents: reviewAgents });
      expect(report.review.agents.acceptance).toBeUndefined();
      expect(report.review.verdict).not.toBeNull();
      const acceptanceAttempts = report.review.attempts.filter((attempt: { role: string }) => attempt.role === "acceptance");
      expect(acceptanceAttempts.map((attempt: { attempt: number; result: string }) => [attempt.attempt, attempt.result])).toEqual([[1, "無効"], [2, "無効"]]);
      expect(acceptanceAttempts.every((attempt: { saved?: { path: string } }) => attempt.saved?.path.includes("/parent/attempts/acceptance-"))).toBe(true);
      const document = JSON.parse(call(scenario.nod, ["doc", "show", String(report.review.auditDocument.id)]).stdout.toString());
      expect(document.content).toContain("\n- 最終状態: 未完了（理由: 有効な結果なし（受け入れ確認。1回の再委譲の後も）");
      expect(document.content).toContain("\n- 確定した要対応の点数: 点数なし");
      expect(between(document.content, "acceptance-result")).toStartWith("未受領");
      expect(logs("blocker")).toHaveLength(1);
      expect(logs("progress")).toHaveLength(0);
    } else {
      // 委譲できない環境で担当を1つも起動しなかった未実施。点数なしのblocker。
      expect(report.review).toMatchObject({ status: "未実施", score: null, verdict: null, agents: {}, remainingChecks: [], mergeReadiness: "不可（人の判断が要る）" });
      const document = JSON.parse(call(scenario.nod, ["doc", "show", String(report.review.reportDocument.id)]).stdout.toString());
      expect(document.content).toContain("\n- 最終状態: 未実施（理由: 委譲できない環境");
      expect(logs("blocker")).toHaveLength(1);
      expect(logs("progress")).toHaveLength(0);
    }
    // 初回レビューの受領時点では、どの停止条件でもPRは作られず、In Reviewにもならない。
    expect(JSON.parse(call(scenario.gh, ["pr", "list"]).stdout.toString())).toEqual([]);
    expect(issue().status).toBe("in_progress");
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
