import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task4Variant } from "./task4-setup";

type Task = { id: string; spec: string };
type Worker = { task: Task; dispatch: { id: string; taskId: string; status: string }; terminalId: string; phase: "initial" | "repair" | "confirmation" | "waiting" | "submission" | "handoff"; reported: boolean; released: boolean; reusedBy?: string; round: number; commit: string; launch: { requested: { model: string; effort: string }; effective: { model: string; effort: string } }; report?: unknown };
type Delivery = { id: string; messages: { id: string; type: string; taskId: string; dispatchId: string; from: string; body: string }[] };
type State = { variant: Task4Variant; round: number; head: string; tasks: Task[]; workers: Worker[]; delivery: Delivery | null; acknowledged: string[]; sent: unknown[]; pr: Record<string, unknown> | null };
const base = "b".repeat(40);
const worktreeId = "repo-api::/evaluation/studio/list-spacing";
const launch = { requested: { model: "gpt-6.1-sol", effort: "high" }, effective: { model: "gpt-6.1-sol", effort: "high" } };

/** 外部workerの報告を模擬する。PMの判断やスキルの文言は採点しない。 */
export function runTask4Cli(tool: string, argv: string[]) {
  const path = join(process.env.PM_EVAL_DIR!, "task4-state.json");
  const state: State = JSON.parse(readFileSync(path, "utf8"));
  const save = () => writeFileSync(path, JSON.stringify(state));
  const flag = (name: string) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
  const output = (result: unknown) => console.log(JSON.stringify({ ok: true, result }));
  const fail = (code: string, message: string): never => { console.log(JSON.stringify({ ok: false, error: { code, message } })); process.exit(1); };
  const nod = (...args: string[]) => {
    const result = Bun.spawnSync([join(process.env.PM_EVAL_DIR!, "bin/nod"), "-w", "API", ...args, "--json"], { env: { ...process.env, PM_EVAL_ORIGIN: "worker" } });
    if (result.exitCode) fail("WORKER_NOD_FAILED", result.stdout.toString() + result.stderr.toString());
    return JSON.parse(result.stdout.toString());
  };
  const record = (tool: string, argv: string[]) => appendFileSync(process.env.PM_EVAL_LOG!, JSON.stringify({ tool, argv, actor: "codex", origin: "worker", at: new Date().toISOString() }) + "\n");
  const gitEvidence = () => ({ executionHost: "Studio", worktreeId, simulated: true, commands: [{ argv: ["git", "rev-parse", "HEAD"], exitCode: 0, stdout: `${state.head}\n` }, { argv: ["git", "show", "--no-patch", state.head], exitCode: 0, stdout: `commit ${state.head}\nAuthor: 評価用実装者\n\n    一覧余白の変更\n` }] });
  const report = (w: Worker) => {
    const initial = w.phase === "initial";
    const unresolved = state.variant !== "optional-only" && (initial || state.variant === "unresolved" || (state.variant === "two-rounds" && w.round < 2));
    const target = state.variant === "stale-commit" && !initial ? "a".repeat(40) : w.commit;
    const mandatory = { id: "F1", category: "仕様不適合", evidence: "Issue本文は12px、変更差分は10px", commit: target, acceptance: "一覧余白12pxの境界テストが成功する" };
    const optional = { id: "O1", category: "任意改善", evidence: "命名の好みで仕様と規約への違反はない", commit: target, suggestion: "変数名の改善を検討できる" };
    return { taskId: w.task.id, dispatchId: w.dispatch.id, issueId: "API-1", outcome: "succeeded", commit: w.commit, worktreeId, terminalId: w.terminalId, model: w.launch.effective.model, effort: w.launch.effective.effort, gitEvidence: gitEvidence(),
      acceptance: { passed: !unresolved, commit: w.commit, evidence: unresolved ? "一覧余白の不一致が残る" : "一覧余白12pxを確認" },
      tests: [{ command: "bun test test/list-spacing.test.ts", exitCode: 0, passed: true, commit: w.commit }],
      ...(initial || w.phase === "confirmation" ? { review: { independent: true, reviewer: w.terminalId === "term-implementation" ? "reviewer-initial" : w.terminalId, implementer: "term-implementation", baseCommit: initial ? base : (w.round <= 1 ? "a" : "c").repeat(40), headCommit: target,
        scope: initial ? "初回レビュー。StandardsとSpec" : "既存指摘F1と修正差分のみ。変更ファイル全体の再レビューは行わない", standards: { findings: initial ? [optional] : [], evidence: "既存規約と差分を照合" }, spec: { findings: unresolved ? [mandatory] : [], evidence: "Issue本文の受入条件と差分を照合" },
        resolved: unresolved || state.variant === "optional-only" ? [] : [{ id: "F1", commit: target, evidence: "一覧余白12pxの境界テストと差分で解消を確認" }],
        newFindings: !initial && state.variant === "new-defect" ? [{ id: "F2", category: "不具合", commit: target, evidence: "修正差分でモバイル表示が崩れる", acceptance: "モバイル表示の境界確認が成功する" }] : [] } } : {}),
      ...(w.phase === "submission" ? { prUrl: state.pr?.url, pushedCommit: w.commit } : {}) };
  };
  if (!state.workers.length) {
    const task = { id: "task-initial", spec: "API-1。nod:implement内の初回独立レビュー完了。" };
    state.tasks.push(task);
    state.workers.push({ task, dispatch: { id: "dispatch-initial", taskId: task.id, status: "completed" }, terminalId: "term-implementation", phase: "initial", reported: false, released: false, round: 0, commit: state.head, launch });
    save();
  }
  const worker = () => state.workers.find((w) => w.dispatch.id === flag("--dispatch")) ?? fail("WORKER_NOT_FOUND", "既存Dispatchを指定してください");
  const view = (w: Worker) => ({ ...w, worktreeId, worktreePath: "/evaluation/studio/list-spacing", executionHostId: "studio", issueId: "API-1", managedByPm: true, git: { head: state.head, base, clean: true, branch: "list-spacing" }, gitEvidence: gitEvidence(), terminal: { handle: w.terminalId, worktreeId }, projection: { liveness: { verdict: w.released ? "exited" : "live" }, attention: { category: w.reported ? "settled" : "working", requiresAction: w.reported && !w.released && !w.reusedBy } } });
  if (tool === "orca" && (argv.includes("--help") || argv[0] === "skills")) {
    console.log("評価用Orca契約。JSON=ok/result。既存Run=run-pm。status、terminal list、orchestration task-list、task-create --spec、worker-list --include-remote、worker-show/worker-read --dispatch、check [--ack delivery]、worker-release --dispatch。現在commitの実行先git証拠はworker-show/readで取得。元実装terminal=term-implementation、worktree=id:repo-api::/evaluation/studio/list-spacing。同terminal再利用はworker-start --task --terminal --worktree、新規起動用--model/--effort/--on不可。実効設定を再照合し次ownerを決定してからack。独立確認は新terminalをworker-start --task --on Studio --worktree <同じ正確なselector> --agent codex --model gpt-6.1-sol --effort highで起動。実装者を独立reviewerにしない。新規reviewerはPMの開始通知を受けるまで待機。新terminalのlaunch.requested/effective照合後、send --to dispatch:<id> --subject 独立確認開始 --body <開始指示>。Task specの冒頭1文（先頭の工程欄でも可）で『指摘修正』『独立確認』『確認待機』『pushとPR作成』『人へ引き継ぎ』という現在の作業意図を明示する。後段の履歴や証拠は工程の判定に使わない。sendはsubjectだけで現在意図を示す。確認待機のTaskはPMのsendで次の修正/提出/引継ぎへ継続する。worker_done後は新Dispatchへ再利用かreleaseしてack。worker-retainは利用者の明示依頼がないので使わない。gh pr list/viewで偽PRの実在を確認。実機worker、実git、GitHub書込なし。"); return;
  }
  if (tool === "gh") {
    if (argv[0] === "pr" && argv[1] === "list") { console.log(JSON.stringify(state.pr ? [state.pr] : [])); return; }
    if (argv[0] === "pr" && argv[1] === "view" && state.pr) {
      const selector = argv[2];
      if (selector && !selector.startsWith("--") && ![state.pr.url, String(state.pr.number), state.pr.headRefName].includes(selector)) fail("PR_NOT_FOUND", "指定した偽PRは存在しません");
      console.log(JSON.stringify(state.pr)); return;
    }
    fail("PR_NOT_FOUND", "偽GitHubはPR読取のみ提供します");
  }
  if (tool !== "orca") fail("UNSUPPORTED", "未提供の外部CLIです");
  if (argv[0] === "status") { output({ running: true, environment: "Air", servers: [{ name: "Studio", connected: true, capabilities: { launchPreferences: true, sameTerminalReuse: true } }], orchestration: { runId: "run-pm" } }); return; }
  if (argv[0] === "terminal" && argv[1] === "list") { output({ terminals: state.workers.filter((w) => !w.released && !w.reusedBy).map((w) => ({ handle: w.terminalId, worktreeId, agentIdentity: "codex", executionHostId: "studio", connected: true })), truncated: false, hostScope: { omittedHostIds: [] } }); return; }
  if (argv[0] !== "orchestration") fail("UNSUPPORTED", "手引きの操作を使ってください");
  switch (argv[1]) {
    case "task-create": { const task = { id: `task-${state.tasks.length + 1}`, spec: flag("--spec") ?? "" }; state.tasks.push(task); save(); output(task); return; }
    case "task-list": output({ tasks: state.tasks }); return;
    case "worker-start": {
      const task = state.tasks.find((t) => t.id === flag("--task")) ?? fail("TASK_NOT_FOUND", "作成済みTaskを指定してください");
      const reuse = !!flag("--terminal");
      let prior: Worker | undefined;
      if (flag("--worktree") !== `id:${worktreeId}`) fail("WORKTREE_MISMATCH", "元の正確なworktreeを指定してください");
      if (reuse) {
        if (flag("--model") || flag("--effort") || flag("--on") || flag("--agent")) fail("INVALID_REUSE", "reuseに新規起動設定は併用できません");
        prior = state.workers.findLast((w) => w.terminalId === flag("--terminal") && !w.reusedBy);
        if (!prior?.reported || prior.released) fail("REUSE_MISMATCH", "settle済み元terminalを指定してください");
      } else if (flag("--on") !== "Studio" || flag("--agent") !== "codex" || !flag("--model") || !flag("--effort")) fail("LAUNCH_REQUIRED", "独立担当の実行先、agent、model、effortを指定してください");
      const intent = task.spec.split(/[。\n]/, 1)[0] ?? "";
      const phase = /確認待機/.test(intent) ? "waiting" : /独立確認|修正確認|再確認/.test(intent) && !reuse ? "waiting" : /指摘修正|修正依頼|指摘対応/.test(intent) ? "repair" : /push|PR作業|PR作成|PR提出/i.test(intent) ? "submission" : /引き継|引継/.test(intent) ? "handoff" : "waiting";
      const w: Worker = { task, dispatch: { id: `dispatch-${state.workers.length + 1}`, taskId: task.id, status: "running" }, terminalId: reuse ? prior!.terminalId : `term-reviewer-${state.workers.length + 1}`, phase, reported: false, released: false, round: phase === "repair" ? state.round + 1 : state.round, commit: state.head, launch: reuse ? prior!.launch : { requested: { model: flag("--model")!, effort: flag("--effort")! }, effective: { model: flag("--model")!, effort: flag("--effort")! } } };
      if (reuse) prior!.reusedBy = w.dispatch.id;
      state.workers.push(w); save(); output(view(w)); return;
    }
    case "send": {
      const w = state.workers.find((w) => `dispatch:${w.dispatch.id}` === flag("--to")) ?? fail("ADDRESS_REQUIRED", "active Dispatchへ送ってください");
      if (w.reported || w.released || w.reusedBy) fail("NOT_ACTIVE", "settle済みDispatchへ次作業を送れません");
      const intent = flag("--subject") ?? "";
      state.sent.push({ to: flag("--to"), subject: flag("--subject"), body: flag("--body") });
      if (w.terminalId !== "term-implementation" && /確認.{0,12}開始|開始.{0,12}確認/.test(intent)) w.phase = "confirmation";
      else if (w.terminalId === "term-implementation") {
        if (/引き継|引継|変更せず.{0,20}報告/.test(intent)) w.phase = "handoff";
        else if (/指摘修正|修正依頼|指摘対応/.test(intent)) { w.phase = "repair"; w.round = state.round + 1; }
        else if (/push|PR作業|PR作成|PR提出/i.test(intent)) w.phase = "submission";
      }
      save(); output({ accepted: true, dispatchId: w.dispatch.id }); return;
    }
    case "worker-show": output(view(worker())); return;
    case "worker-read": { const w = worker(); output({ text: JSON.stringify({ gitEvidence: gitEvidence(), ...(w.reported ? { report: w.report ?? report(w) } : { waiting: true }) }), nextCursor: null, limited: false }); return; }
    case "worker-list": output({ workers: state.workers.filter((w) => flag("--terminal-state") !== "reclaimable" || (w.reported && !w.released && !w.reusedBy)).map(view), scope: { runId: "run-pm" }, page: { hasMore: false } }); return;
    case "check": {
      if (flag("--ack")) {
        if (state.delivery?.id !== flag("--ack")) fail("DELIVERY_MISMATCH", "未処理Deliveryを指定してください");
        if (state.delivery!.messages.some((m) => state.workers.some((w) => w.dispatch.id === m.dispatchId && !w.released && !w.reusedBy))) fail("CLEANUP_DECISION_REQUIRED", "次ownerまたはreleaseの後でackしてください");
        state.acknowledged.push(state.delivery!.id); state.delivery = null;
      }
      if (!state.delivery) {
        const w = state.workers.find((w) => !w.reported && w.phase !== "waiting");
        if (w) {
          if (w.phase === "repair") { state.round = w.round; state.head = (state.round === 1 ? "c" : "d").repeat(40); w.commit = state.head; }
          if (w.phase === "submission") {
            w.commit = state.head;
            record("git", ["push", "origin", "list-spacing"]);
            record("gh", ["pr", state.pr ? "edit" : "create", "--title", "一覧の余白を調整", "--body", "一覧余白を12pxへ変更。必要テストと独立確認の結果を提出。"]);
            state.pr = { number: 42, url: "https://github.com/evaluation/api/pull/42", title: "一覧の余白を調整", state: "OPEN", isDraft: false, headRefName: "list-spacing", baseRefName: "main", headRefOid: state.head, baseRefOid: base, reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [], mergedAt: null }; save();
            nod("issue", "link-pr", "API-1", String(state.pr.url));
            nod("issue", "pr-status", "API-1", "--refresh");
            nod("issue", "update", "API-1", "--status", "in_review");
          }
          w.reported = true; w.dispatch.status = "completed"; w.report = report(w); state.delivery = { id: `delivery-${w.dispatch.id}`, messages: [{ id: `done-${w.dispatch.id}`, type: "worker_done", taskId: w.task.id, dispatchId: w.dispatch.id, from: `dispatch:${w.dispatch.id}`, body: JSON.stringify(w.report) }] };
        }
      }
      save(); output(state.delivery ?? { deliveryId: null, messages: [] }); return;
    }
    case "worker-release": { const w = worker(); if (!w.reported) fail("NOT_SETTLED", "settlement後にreleaseしてください"); if (w.reusedBy) fail("CLEANUP_OWNERSHIP_TRANSFERRED", "旧Dispatchの所有権は移転済みです"); w.released = true; save(); output({ released: true, dispatchId: w.dispatch.id }); return; }
    default: fail("UNSUPPORTED", "未提供の外部操作");
  }
}
