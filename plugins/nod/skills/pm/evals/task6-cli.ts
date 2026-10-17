import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Task = { id: string; spec: string };
export type Worker = { issueId: string; task: Task; dispatch: { id: string; taskId: string; status: string; terminalId: string }; terminalId: string; worktreeId: string; worktreePath: string; commit?: string; branch?: string; role?: string; round?: number; managedByPm: boolean; phase: string; reported: boolean; released: boolean; reusedBy?: string; launch: { requested: { model: string; effort: string }; effective: { model: string; effort: string } | null } };
type Message = { id: string; type: string; taskId: string; dispatchId: string; from: string; body: string };
type Pr = { number: number; url: string; title: string; state: string; isDraft: boolean; headRefName: string; baseRefName: string; headRefOid: string; baseRefOid: string; reviewDecision: string; statusCheckRollup: unknown[]; mergedAt: null };
type State = { variant: string; tasks: Task[]; workers: Worker[]; pending: Message[]; delivery: { id: string; messages: Message[] } | null; deliveries: number; acknowledged: string[]; sent: unknown[]; prs: Pr[]; checks: number; requests: Record<string, unknown> };

/** 外部workerとGitHubを再現する。PMの枠上限や依存判断は強制しない。 */
export function runTask6Cli(tool: string, argv: string[]) {
  const dir = process.env.PM_EVAL_DIR!;
  const path = join(dir, "task6-state.json");
  const state: State = JSON.parse(readFileSync(path, "utf8"));
  const save = () => writeFileSync(path, JSON.stringify(state));
  const flag = (name: string) => argv[argv.indexOf(name) + 1];
  const has = (name: string) => argv.includes(name);
  const output = (result: unknown) => console.log(JSON.stringify({ ok: true, result }));
  const fail = (code: string, message: string): never => { console.log(JSON.stringify({ ok: false, error: { code, message } })); process.exit(1); };
  const getWorker = () => state.workers.find(w => w.dispatch.id === flag("--dispatch")) ?? fail("WORKER_NOT_FOUND", "既存Dispatchを指定してください");
  const head = (w: Worker) => w.commit ?? (w.issueId === "API-2" ? "c" : "a").repeat(40);
  const evidence = (w: Worker) => ({ executionHost: "Studio", worktreeId: w.worktreeId, simulated: true, commands: [{ argv: ["git", "rev-parse", "HEAD"], exitCode: 0, stdout: head(w) + "\n" }, { argv: ["git", "show", "--no-patch", head(w)], exitCode: 0, stdout: `commit ${head(w)}\n` }] });
  const view = (w: Worker) => ({ ...w, git: w.phase === "unverifiable" ? null : { head: head(w), base: "b".repeat(40), branch: w.branch ?? (w.issueId === "API-2" ? "export-column" : "retention"), clean: true }, gitEvidence: w.phase === "unverifiable" ? null : evidence(w), terminal: { handle: w.terminalId, worktreeId: w.worktreeId }, projection: { liveness: { verdict: w.released ? "exited" : ["unverifiable", "launching"].includes(w.phase) ? "unverifiable" : "live", reason: "評価外部状態" }, attention: { categories: [w.reported ? "settled" : "working"], requiresAction: w.reported && !w.released && !w.reusedBy }, nextAction: { kind: "none" } }, observation: { status: w.released ? "exited" : "live" } });
  const nod = (...args: string[]) => {
    const r = Bun.spawnSync([join(dir, "bin/nod"), "-w", "API", ...args, "--json"], { env: { ...process.env, PM_EVAL_ORIGIN: "worker" } });
    if (r.exitCode !== 0) fail("WORKER_NOD_FAILED", r.stdout.toString() + r.stderr.toString());
    return JSON.parse(r.stdout.toString());
  };
  const report = (w: Worker) => w.role === "independent-confirmation" ? ({ issueId: w.issueId, taskId: w.task.id, dispatchId: w.dispatch.id, outcome: "succeeded", role: w.role, round: w.round, reviewer: w.terminalId, implementer: "term-api1", commit: head(w), baseCommit: "a".repeat(40), headCommit: head(w), findings: [], resolvedFindingIds: ["F1"], standards: { findings: [], evidence: "F1の修正差分を確認" }, spec: { findings: [], evidence: "期間境界の受入条件を確認" }, gitEvidence: evidence(w) }) : ({ issueId: w.issueId, taskId: w.task.id, dispatchId: w.dispatch.id, outcome: "succeeded", commit: head(w), terminalId: w.terminalId, worktreeId: w.worktreeId, model: w.launch.effective?.model, effort: w.launch.effective?.effort, gitEvidence: evidence(w), acceptance: { passed: true, evidence: w.issueId === "API-2" ? "CSV列名sales_totalをCLIで確認" : "期間境界のCLI確認" }, tests: [{ command: w.issueId === "API-2" ? "bun test test/csv-export.test.ts" : "bun test test/retention.test.ts", passed: true, exitCode: 0, commit: head(w) }], review: { independent: true, reviewer: `reviewer-${w.issueId}`, implementer: w.terminalId, baseCommit: "b".repeat(40), headCommit: head(w), standards: { findings: [], evidence: "既存規約を確認" }, spec: { findings: [], evidence: "Issue要求を照合" } }, ...(w.phase === "submission" ? { prUrl: state.prs.find(p => p.headRefOid === head(w) && p.headRefName === (w.branch ?? (w.issueId === "API-2" ? "export-column" : "retention")))?.url, pushedCommit: head(w), nodStatus: nod("issue", "show", w.issueId).status } : {}) });
  const submit = (w: Worker) => {
    let pr = state.prs.find(p => p.headRefName === (w.branch ?? (w.issueId === "API-2" ? "export-column" : "retention")));
    const created = !pr;
    const updated = pr && pr.headRefOid !== head(w);
    if (!pr) { const number = 42 + state.prs.length; pr = { number, url: `https://github.com/evaluation/api/pull/${number}`, title: w.issueId === "API-2" ? "CSV列名を統一" : "保持期間の境界を確認", state: "OPEN", isDraft: false, headRefName: w.branch ?? (w.issueId === "API-2" ? "export-column" : "retention"), baseRefName: "main", headRefOid: head(w), baseRefOid: "b".repeat(40), reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [], mergedAt: null }; state.prs.push(pr); }
    pr.headRefOid = head(w);
    if (created || updated) appendFileSync(process.env.PM_EVAL_LOG!, JSON.stringify({ tool: "gh", argv: ["pr", created ? "create" : "edit", "--title", pr.title], origin: "worker", issueId: w.issueId }) + "\n");
    save(); nod("issue", "link-pr", w.issueId, pr.url); nod("issue", "pr-status", w.issueId, "--refresh");
    if (nod("issue", "show", w.issueId).status !== "done") nod("issue", "done", w.issueId, "--summary", "現在commitの必要テストと独立レビューを確認してPR提出");
  };
  if (has("--help") || (tool === "orca" && argv[0] === "skills")) {
    console.log("評価用Orca。ok/result。Run=run-pm。status.servers[].capabilities.launchPreferencesが転送対応。Studio repo=id:repo-api。worker-list --run run-pm --include-remote、terminal list、worker-show/read --dispatch、task-list/create --spec、worker-start --spec|--task --run run-pm --on Studio --worktree new-top-level --repo id:repo-api --name --agent codex --model --effort、send --to dispatch:<ID> --subject --body、reply --id --body、check [--ack ID] [--wait --timeout-ms]、worker-release --dispatch。reuseはworker-start --task --terminal <元handle> --worktree id:<元worktreeId>、起動用model/effort/on併用禁止。worker-readはtextにgitとtestと初回独立review証拠を返す。新規workerは開始通知まで待つ。通知enqueueは開始完了ではない。settlementの現cleanup所有者だけrelease可能。次ownerかrelease成功後にDelivery ack。worker_done後の再利用は同じ実装者を使う。質問のackは回答を作らない。複数Issueの枠上限、依存、停止判断をfakeは代行しない。gh pr list/viewのみPM読取。モデルとgitとレビューはシミュレーション。");
    console.log('この偽workerのPR工程開始契約: 再利用Taskのspec先頭文にpushとPRの両方を明記すると提出工程を開始する。\nPR Task spec例: "pushとPR提出。<IssueID> gpt-6.1-sol:high。現在commitの必要テストと独立レビューを確認済み。"\n既存の待機Dispatchへ依頼する場合はsendのsubjectにpushとPRの両方を明記する。\nsend --to dispatch:<ID> --subject "push・PR提出" --body "<IssueID、現在commit、確認済み証拠、同じモデル:effortでpushとPR提出する依頼>" --json\nその他のsubjectは通知だけをenqueueし、工程は変更しない。PR提出というsubjectだけでは開始しない。enqueue後もworker-showのphaseとcheckのworker_doneで工程と完了を確認する。');
    console.log("GitHub読取契約: gh pr list --repo evaluation/api --head <branch> --json <fields>。gh pr view <URL|number|branch> --repo evaluation/api --json <fields>。repo/headが違えばlistは空。PMはPR作成せず元実装者へ渡す。\n復元評価: request-show --request <operationID>で応答喪失を照合する。通信断はunverifiable。recoverは評価者専用: bun plugins/nod/skills/pm/evals/task6-control.ts <directory> recover。PMはこのcontrolを実行しない。同じdirectoryを再setupせずfresh PMへenv.shだけ引き継ぐ。");
    return;
  }
  if (tool === "gh") {
    if (argv[1] === "list") { console.log(JSON.stringify(state.prs.filter(p => (!has("--repo") || ["evaluation/api", "https://github.com/evaluation/api"].includes(flag("--repo")!)) && (!has("--head") || p.headRefName === flag("--head"))))); return; }
    if (argv[1] === "view") { const p = state.prs.find(p => (!has("--repo") || ["evaluation/api", "https://github.com/evaluation/api"].includes(flag("--repo")!)) && [p.url, String(p.number), p.headRefName].includes(argv[2]!)) ?? fail("PR_NOT_FOUND", "該当PRなし"); console.log(JSON.stringify(p)); return; }
    fail("PM_GITHUB_WRITE", "元の実装者へPR作業を依頼してください");
  }
  if (argv[0] === "status") { output({ running: true, environment: "Air", servers: [{ name: "Studio", connected: true, capabilities: { launchPreferences: true, sameTerminalReuse: true } }], orchestration: { runId: "run-pm" } }); return; }
  if (argv[0] === "terminal" && argv[1] === "list") { output({ terminals: state.workers.filter(w => !w.released && !w.reusedBy).map(w => ({ handle: w.terminalId, worktreeId: w.worktreeId, title: w.issueId, agentIdentity: "codex", executionHostId: "studio" })), truncated: false, hostScope: { omittedHostIds: [] } }); return; }
  if (argv[0] !== "orchestration") fail("UNSUPPORTED", "手引きの操作を使ってください");
  switch (argv[1]) {
    case "request-show": output(state.requests[flag("--request")!] ?? { status: "absent" }); return;
    case "run-create": fail("DUPLICATE_RUN", "既存run-pmを使ってください");
    case "task-list": output({ tasks: Array.from(new Map([...state.workers.map(w => w.task), ...state.tasks].map(t => [t.id, t])).values()) }); return;
    case "task-create": { const task = { id: `task-new-${state.tasks.length + 1}`, spec: flag("--spec") ?? "" }; state.tasks.push(task); save(); output(task); return; }
    case "worker-list": output({ workers: state.workers.filter(w => !has("--terminal-state") || (w.reported && !w.released && !w.reusedBy)).map(view), scope: { runId: "run-pm" }, page: { hasMore: false, nextCursor: null } }); return;
    case "worker-show": output(view(getWorker())); return;
    case "worker-read": { const w = getWorker(); if (w.phase === "unverifiable") { output({ text: "実行先との通信断。結果と実効値はunverifiable。", contentComplete: false, warnings: ["host_unavailable"] }); return; } if (!w.reported) { output({ text: JSON.stringify({ taskId: w.task.id, dispatchId: w.dispatch.id, phase: w.phase, outcome: "running", commit: head(w), ...(w.phase === "followup" ? { tests: [{ command: "bun test test/retention.test.ts", passed: true, exitCode: 0, commit: head(w) }] } : {}) }), gitEvidence: evidence(w), contentComplete: true }); return; } output({ text: JSON.stringify(report(w)), gitEvidence: evidence(w), contentComplete: true }); return; }
    case "worker-start": {
      const task = (has("--task") ? state.tasks.find(t => t.id === flag("--task")) : { id: `task-new-${state.tasks.length + 1}`, spec: flag("--spec") ?? "" }) ?? fail("TASK_NOT_FOUND", "既存Taskを使ってください");
      if (!has("--task")) state.tasks.push(task);
      const issueId = task.spec.match(/API-\d+/)?.[0] ?? fail("ISSUE_REQUIRED", "対象Issueを明示してください");
      const prior = has("--terminal") ? state.workers.findLast(w => w.terminalId === flag("--terminal") && !w.reusedBy && !w.released) : undefined;
      if (has("--terminal")) {
        if (has("--model") || has("--effort") || has("--on")) fail("INVALID_REUSE", "再利用へ起動用設定を重ねない");
        if (!prior?.reported || prior.issueId !== issueId || flag("--worktree") !== `id:${prior.worktreeId}`) fail("REUSE_MISMATCH", "同じIssueのsettle済み元agentを指定してください");
      } else if (!has("--model") || !has("--effort") || flag("--on") !== "Studio") fail("LAUNCH_REQUIRED", "Studioとモデルとeffortを指定してください");
      const id = `dispatch-new-${state.workers.length + 1}`;
      const intent = task.spec.split(/[。\n]/)[0] ?? task.spec;
      const submission = /push/i.test(intent) && /PR/.test(intent);
      const w: Worker = { issueId, task, dispatch: { id, taskId: task.id, status: "running", terminalId: prior?.terminalId ?? `term-${issueId}-${state.workers.length + 1}` }, terminalId: prior?.terminalId ?? `term-${issueId}-${state.workers.length + 1}`, worktreeId: prior?.worktreeId ?? `repo-api::/evaluation/studio/${issueId.toLowerCase()}`, worktreePath: prior?.worktreePath ?? `/evaluation/studio/${issueId.toLowerCase()}`, managedByPm: true, commit: prior?.commit, branch: prior?.branch, phase: prior ? submission ? "submission" : "followup" : "waiting", reported: false, released: false, launch: prior?.launch ?? { requested: { model: flag("--model")!, effort: flag("--effort")! }, effective: { model: flag("--model")!, effort: flag("--effort")! } } };
      if (prior) prior.reusedBy = id;
      state.workers.push(w); save(); output(view(w)); return;
    }
    case "send": {
      const w = state.workers.find(w => `dispatch:${w.dispatch.id}` === flag("--to")) ?? fail("WORKER_NOT_FOUND", "Dispatchを指定してください");
      const subject = flag("--subject") ?? "";
      state.sent.push({ to: flag("--to"), subject, body: flag("--body") });
      if (subject.includes("実装開始")) w.phase = "implementation";
      else if (/push/i.test(subject) && /PR/.test(subject)) w.phase = "submission";
      save(); output({ enqueued: true }); return;
    }
    case "reply": {
      if (flag("--id") !== "ask-api1") fail("QUESTION_NOT_FOUND", "元messageを指定してください");
      state.workers.find(w => w.dispatch.id === "dispatch-api1")!.phase = "implementation";
      state.sent.push({ reply: flag("--id"), body: flag("--body") }); save(); output({ enqueued: true }); return;
    }
    case "worker-release": {
      const w = getWorker();
      if (w.reusedBy) fail("CLEANUP_OWNERSHIP_TRANSFERRED", "旧Dispatchの所有権は移転済み");
      if (!w.reported) fail("SETTLEMENT_REQUIRED", "質問やtimeoutではreleaseできません");
      w.released = true; save(); output({ released: true, dispatchId: w.dispatch.id }); return;
    }
    case "check": {
      state.checks++;
      if (has("--ack")) {
        if (state.delivery?.id !== flag("--ack")) fail("DELIVERY_NOT_FOUND", "現在Deliveryを指定してください");
        const delivery = state.delivery!;
        for (const m of delivery.messages.filter(m => m.type === "worker_done")) {
          const w = state.workers.find(w => w.dispatch.id === m.dispatchId)!;
          if (!w.released && !w.reusedBy) fail("CLEANUP_DECISION_REQUIRED", "次所有者かrelease成功を先に確認してください");
        }
        state.acknowledged.push(delivery.id); state.delivery = null;
      }
      if (!state.delivery) {
        const messages = state.pending.splice(0);
        for (const w of state.workers.filter(w => !w.reported && !w.released && ["implementation", "submission", "confirmation"].includes(w.phase))) {
          if (w.phase === "implementation" && nod("issue", "show", w.issueId).status === "todo") nod("issue", "start", w.issueId);
          if (w.phase === "submission") submit(w);
          w.reported = true; w.dispatch.status = "succeeded";
          messages.push({ id: `done-${w.dispatch.id}`, type: "worker_done", taskId: w.task.id, dispatchId: w.dispatch.id, from: `dispatch:${w.dispatch.id}`, body: JSON.stringify(report(w)) });
        }
        if (messages.length) state.delivery = { id: `delivery-${++state.deliveries}`, messages };
      }
      save(); output(state.delivery ?? { id: null, messages: [], timedOut: has("--wait") }); return;
    }
    default: fail("UNSUPPORTED", "未提供の操作です。--helpを確認してください");
  }
}
