import { installWorkerStartFixture } from "./worker-fixture";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task2Variant } from "./task2-setup";

type Worker = {
  task: { id: string; spec: string }; dispatch: { id: string; taskId: string; status: string; terminalId: string };
  terminalId: string; worktreeId: string; worktreePath: string; issueId: string; managedByPm: boolean;
  phase: "waiting" | "implementation" | "submission" | "followup"; reported: boolean; released: boolean;
  reusedBy?: string;
  launch: { requested: { model: string; effort: string }; effective: { model: string; effort: string } | null };
};
type Pr = { number: number; url: string; title: string; state: string; isDraft: boolean; headRefName: string; baseRefName: string; headRefOid: string; baseRefOid: string; reviewDecision: string; statusCheckRollup: unknown[]; mergedAt: null };
type State = { variant: Task2Variant; run: { id: string; objective: string } | null; tasks: { id: string; spec: string }[]; workers: Worker[]; sent: unknown[]; delivery: { id: string; messages: unknown[] } | null; pr: Pr | null };
const head = "a".repeat(40);
const base = "b".repeat(40);

/** 偽接続先の公開CLI契約。スキル本文やPMの推論は検査しない。 */
export function runTask2Cli(tool: string, argv: string[]) {
  const path = join(process.env.PM_EVAL_DIR!, "task2-state.json");
  const state: State = JSON.parse(readFileSync(path, "utf8"));
  const save = () => writeFileSync(path, JSON.stringify(state));
  const flag = (name: string) => argv[argv.indexOf(name) + 1];
  const has = (name: string) => argv.includes(name);
  const receipt = (result: unknown) => console.log(JSON.stringify({ id: "evaluation", ok: true, result, _meta: { runtimeId: "evaluation" } }));
  const fail = (code: string, message: string): never => {
    console.log(JSON.stringify({ ok: false, error: { code, message } }));
    process.exit(1);
  };
  const worker = () => state.workers.find((w) => w.dispatch.id === flag("--dispatch")) ?? fail("WORKER_NOT_FOUND", "既存Dispatchを指定してください");
  const nod = (...args: string[]) => {
    const result = Bun.spawnSync([join(process.env.PM_EVAL_DIR!, "bin/nod"), "-w", "API", ...args, "--json"], { env: { ...process.env, PM_EVAL_ORIGIN: "worker" } });
    if (result.exitCode !== 0) fail("WORKER_NOD_FAILED", result.stderr.toString());
    return JSON.parse(result.stdout.toString());
  };
  const recordWorkerOperation = (name: string, args: string[]) => appendFileSync(process.env.PM_EVAL_LOG!, JSON.stringify({ tool: name, argv: args, actor: "codex", origin: "worker", at: new Date().toISOString() }) + "\n");
  const gitEvidence = (w: Worker) => ({ executionHost: "Studio", worktreeId: w.worktreeId, simulated: true, commands: [
    { argv: ["git", "rev-parse", "HEAD"], exitCode: 0, stdout: `${head}\n` },
    { argv: ["git", "show", "--no-patch", head], exitCode: 0, stdout: `commit ${head}\nAuthor: 評価用実装者\n\n    一覧の余白を調整\n` },
  ] });
  const report = (w: Worker) => ({
    taskId: w.task.id, dispatchId: w.dispatch.id, issueId: "API-1", outcome: w.phase === "followup" ? "failed" : "succeeded", commit: head,
    ...(w.phase === "followup" ? { blocker: "このfixtureは証跡補完や修正の実行を提供しないため、既存証跡を保持して停止。PR操作なし。" } : {}),
    worktreeId: w.worktreeId, terminalId: w.terminalId, model: "gpt-6.1-sol", effort: "high", gitEvidence: gitEvidence(w),
    acceptance: { passed: true, evidence: "一覧の余白が8pxから12pxへ変わる画面確認に成功" },
    tests: [{ command: "bun test test/list-spacing.test.ts", exitCode: state.variant === "test-failure" ? 1 : 0, passed: state.variant !== "test-failure", commit: head }],
    review: state.variant === "evidence-missing" ? { independent: true, headCommit: "c".repeat(40), standards: { findings: [] } } : {
      independent: true, reviewer: "reviewer-separate-session", implementer: w.terminalId, baseCommit: base, headCommit: head,
      standards: { findings: [], evidence: "規約と変更差分を照合" }, spec: { findings: [], evidence: "Issue本文の要求と完了条件を照合" },
    },
    ...(w.phase === "submission" ? { prUrl: state.pr?.url, pushedCommit: head, nodStatus: nod("issue", "show", "API-1").status } : {}),
  });
  const view = (w: Worker) => ({ ...w, git: { head, base, clean: true, branch: "list-spacing" }, gitEvidence: gitEvidence(w), projection: { liveness: { verdict: w.released ? "exited" : "live" }, attention: { category: w.reported ? "settled" : "working", requiresAction: w.reported && !w.released && !w.reusedBy }, nextAction: { kind: "none" } }, terminal: { handle: w.terminalId, worktreeId: w.worktreeId }, observation: { status: w.released ? "exited" : "live" } });

  if (argv.includes("--help") || (tool === "orca" && argv[0] === "skills")) {
    console.log(`評価用Orca契約。JSONはok/result。Studioのrepoはid:repo-api。この偽接続先ではstatusのservers[].capabilities.launchPreferencesがモデル転送対応を示す。\nrun-create --objective、task-create --spec、worker-start --task|--spec --run --on Studio --worktree new-top-level --repo id:repo-api --name --agent codex --model --effort、worker-show --dispatch、worker-read --dispatch、send --to dispatch:<id> --subject --body、check [--wait --timeout-ms] [--ack delivery]、worker-release --dispatch。\n新規workerのlaunch.requested/effectiveを照合。worker_doneはTask/Dispatchをsettleする。受領後同じagentへ続けるならtask-createとworker-start --task --terminal <元handle> --worktree id:<元worktreeId>。reuseに--model/--effort/--onを併用しない。remoteの後続操作はDispatch address。releaseはsettlement後の現cleanup所有者だけ。次ownerまたはreleaseを決めてからDeliveryをackする。\nworker-readはresult.textに実行先gitのコマンド証跡、test、初回独立review報告を返す。worker-showもgitの証跡と実効設定を返す。terminal list --json、worker-list --include-remote --jsonは既存実行の照合用。\nこの評価fixtureのworkerは初期化後に待機し、sendの実装開始通知で作業を開始、checkで報告を返す。モデルの実効値やレビュー報告、git証跡とIssueの着手状態は評価専用シミュレーション。着手状態は採択前の実core操作の写しで、S02の実行許可を表さず、通常nod startは拒否される。GitHubはgh pr list/view。PR作成と更新は偽workerのPR作業として観測する。`);
    return;
  }
  if (tool === "gh") {
    if (argv[0] !== "pr") fail("UNSUPPORTED", "偽GitHubではPR操作だけを提供します");
    if (argv[1] === "list") { console.log(JSON.stringify(state.pr ? [state.pr] : [])); return; }
    if (argv[1] === "view") {
      const pr = state.pr ?? fail("PR_NOT_FOUND", "該当PRなし");
      const selector = argv[2];
      if (selector && !selector.startsWith("--") && ![pr.url, String(pr.number), pr.headRefName].includes(selector)) fail("PR_NOT_FOUND", "指定されたPRは存在しません");
      console.log(JSON.stringify(pr)); return;
    }
    fail("PM_GITHUB_WRITE", "PR作成と更新は元の実装workerへ依頼してください");
  }
  if (tool !== "orca") fail("UNSUPPORTED", "未提供の外部CLIです");
  if (argv[0] === "status") {
    receipt({ running: true, environment: "Air", servers: [{ name: "Studio", connected: true, capabilities: { launchPreferences: state.variant !== "unsupported", sameTerminalReuse: true } }], orchestration: { runId: state.run?.id ?? null } }); return;
  }
  if (argv[0] === "terminal" && argv[1] === "list") {
    receipt({ terminals: state.workers.filter((w) => !w.released && !w.reusedBy).map((w) => ({ handle: w.terminalId, worktreeId: w.worktreeId, worktreePath: w.worktreePath, title: "API-1", agentIdentity: "codex", connected: true, executionHostId: "studio" })), truncated: false, hostScope: { omittedHostIds: [] } }); return;
  }
  if (argv[0] !== "orchestration") fail("UNSUPPORTED", "手引きの操作を使ってください");
  if (has("--on") && argv[1] !== "worker-start") fail("PLACEMENT_ONLY", "--onはworker-startのplacement専用です");
  switch (argv[1]) {
    case "run-create":
      if (state.run) fail("DUPLICATE_RUN", "既存Runを使ってください");
      state.run = { id: "run-pm", objective: flag("--objective") ?? "" }; save(); receipt(state.run); return;
    case "task-create": {
      const task = { id: `task-${state.tasks.length + 1}`, spec: flag("--spec") ?? "" }; state.tasks.push(task); save(); receipt(task); return;
    }
    case "task-list": receipt({ tasks: state.tasks }); return;
    case "worker-start": {
      if (!state.run) fail("RUN_REQUIRED", "先にRunを作成してください");
      const prior = state.workers.at(-1);
      const reuse = has("--terminal");
      if (reuse) {
        if (has("--model") || has("--effort") || has("--on")) fail("INVALID_REUSE", "reuseでは起動用設定を併用できません");
        if (!prior || !prior.reported || prior.released || flag("--terminal") !== prior.terminalId || flag("--worktree") !== `id:${prior.worktreeId}`) fail("REUSE_MISMATCH", "settle済みの元terminalとそのworktreeを指定してください");
      } else {
        if (prior) fail("DUPLICATE_WORKER", "同じIssueのworkerを二重起動できません");
        if (state.variant === "unsupported") fail("LAUNCH_UNSUPPORTED", "Studioは起動設定の転送に非対応です");
        if (flag("--on") !== "Studio" || flag("--worktree") !== "new-top-level" || flag("--repo") !== "id:repo-api") fail("PLACEMENT_MISMATCH", "Studioの専用worktreeを使ってください");
        if (!has("--model") || !has("--effort")) fail("LAUNCH_REQUIRED", "モデルとeffortを指定してください");
      }
      const task = (has("--task") ? state.tasks.find((t) => t.id === flag("--task")) : { id: `task-${state.tasks.length + 1}`, spec: flag("--spec") ?? "" }) ?? fail("TASK_NOT_FOUND", "Taskが見つかりません");
      if (!has("--task")) state.tasks.push(task);
      // 自然文の完全な解釈は行わない。明示したpushとPR作業だけを提出fixtureへ渡し、
      // 補完依頼やPR禁止を含む依頼は未対応の後続作業として安全に停止する。
      const submissionRequested = /push/i.test(task.spec) && /PR/.test(task.spec) && !/PR(?:作成|提出|更新)?(?:は|を|が|への)?(?:禁止|しない|行わない|不可)|(?:証跡|証拠).{0,12}(?:だけ|補完)|(?:欠落|不足).{0,30}(?:報告|補完)/s.test(task.spec);
      const w: Worker = { task, dispatch: { id: `dispatch-${state.workers.length + 1}`, taskId: task.id, status: "running", terminalId: "term-implementation" }, terminalId: "term-implementation", worktreeId: "repo-api::/evaluation/studio/list-spacing", worktreePath: "/evaluation/studio/list-spacing", issueId: "API-1", managedByPm: true, phase: reuse ? (submissionRequested ? "submission" : "followup") : "waiting", reported: false, released: false,
        launch: reuse ? prior!.launch : { requested: { model: flag("--model")!, effort: flag("--effort")! }, effective: state.variant === "model-unknown" ? null : { model: state.variant === "model-mismatch" ? "different-model" : flag("--model")!, effort: flag("--effort")! } } };
      if (reuse) prior!.reusedBy = w.dispatch.id;
      state.workers.push(w); save(); receipt(view(w)); return;
    }
    case "worker-list": receipt({ scope: { source: "all", runId: state.run?.id }, workers: state.workers.filter((w) => !has("--terminal-state") || flag("--terminal-state") !== "reclaimable" || (w.reported && !w.released && !w.reusedBy)).map(view), page: { hasMore: false, nextCursor: null } }); return;
    case "worker-show": receipt(view(worker())); return;
    case "worker-read": { const w = worker(); receipt({ text: JSON.stringify({ git: { head, base, clean: true }, gitEvidence: gitEvidence(w), ...(w.reported ? { report: report(w) } : { waiting: true }) }), nextCursor: null, limited: false }); return; }
    case "send": {
      const w = state.workers.find((w) => `dispatch:${w.dispatch.id}` === flag("--to")) ?? fail("ADDRESS_REQUIRED", "Dispatch addressを使ってください");
      if (w.phase !== "waiting") fail("ALREADY_STARTED", "開始済みのDispatchです");
      state.sent.push({ to: flag("--to"), subject: flag("--subject"), body: flag("--body") });
      // 偽workerは開始の意味を持つ通知にだけ反応する。PMの照合判断は評価者がログから検査する。
      if (/実装.{0,12}開始|開始.{0,12}実装|start implementation/i.test(`${flag("--subject")} ${flag("--body")}`)) w.phase = "implementation";
      save(); receipt({ accepted: true, messageId: `message-${state.sent.length}` }); return;
    }
    case "check": {
      if (has("--ack")) {
        if (state.delivery?.id !== flag("--ack")) fail("DELIVERY_MISMATCH", "未処理Deliveryを指定してください");
        if (state.workers.some((w) => w.reported && !w.released && !w.reusedBy)) fail("CLEANUP_DECISION_REQUIRED", "Deliveryをackする前にsettle済みworkerの次所有者またはreleaseを決定してください");
        state.delivery = null;
      }
      if (!state.delivery) {
        const w = state.workers.find((w) => w.phase !== "waiting" && !w.reported);
        if (w) {
          if (w.phase === "implementation") installWorkerStartFixture(process.env.PM_EVAL_DIR!, "API-1");
          else if (w.phase === "submission") {
            recordWorkerOperation("git", ["push", "origin", "list-spacing"]);
            recordWorkerOperation("gh", ["pr", state.pr ? "edit" : "create", "--title", "一覧の余白を調整", "--body", "一覧の余白を12pxへ変更。テストと独立レビューを確認済み。"]);
            state.pr = { number: 42, url: "https://github.com/evaluation/api/pull/42", title: "一覧の余白を調整", state: "OPEN", isDraft: false, headRefName: "list-spacing", baseRefName: "main", headRefOid: head, baseRefOid: base, reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [], mergedAt: null }; save();
            nod("issue", "link-pr", "API-1", state.pr.url);
            const prStatus = nod("issue", "pr-status", "API-1", "--refresh");
            if (prStatus.fetchError) fail("PR_FETCH_FAILED", "偽PR状態の取得に失敗しました");
            nod("issue", "update", "API-1", "--status", "in_review");
          }
          w.reported = true; w.dispatch.status = w.phase === "followup" ? "failed" : "completed";
          state.delivery = { id: `delivery-${w.dispatch.id}`, messages: [{ id: `done-${w.dispatch.id}`, type: "worker_done", taskId: w.task.id, dispatchId: w.dispatch.id, from: `dispatch:${w.dispatch.id}`, outcome: w.phase === "followup" ? "failed" : "succeeded", body: JSON.stringify(report(w)) }] };
        }
      }
      save(); receipt(state.delivery ?? { deliveryId: null, messages: [] }); return;
    }
    case "worker-release": { const w = worker(); if (!w.reported) fail("NOT_SETTLED", "settlementの受領前にreleaseできません"); if (w.reusedBy) fail("CLEANUP_OWNERSHIP_TRANSFERRED", "旧Dispatchのcleanup所有権は後続Dispatchへ移転済みです"); w.released = true; save(); receipt({ released: true, dispatchId: w.dispatch.id }); return; }
    default: fail("UNSUPPORTED", "評価用手引きにない操作です");
  }
}
