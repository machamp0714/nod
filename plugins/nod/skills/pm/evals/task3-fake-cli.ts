import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTask2Cli } from "./task2-cli";

type Message = { id: string; type: string; taskId: string; dispatchId: string; from: string; body: string };
type State = { variant: string; pending: Message[]; replied: { id: string; body: string }[]; delivery: { id: string; messages: Message[] } | null; acknowledged: string[]; sent: unknown[] };
const [tool, ...argv] = process.argv.slice(2);
const dir = process.env.PM_EVAL_DIR!;
appendFileSync(process.env.PM_EVAL_LOG!, JSON.stringify({ tool, argv, actor: "codex", origin: "pm", at: new Date().toISOString() }) + "\n");
const output = (result: unknown) => console.log(JSON.stringify({ ok: true, result }));
const fail = (code: string, message: string): never => { console.log(JSON.stringify({ ok: false, error: { code, message } })); process.exit(1); };
const flag = (name: string) => argv[argv.indexOf(name) + 1];
if (tool === "nod") {
  const result = Bun.spawnSync([process.env.PM_EVAL_BUN!, "--no-env-file", process.env.PM_EVAL_NOD_MAIN!, ...argv], { env: { ...process.env, NOD_DB: join(dir, "nod.db"), NOD_ACTOR: "codex", NOD_ORCA: "0", NOD_DOCS_DIR: join(dir, "documents"), NOD_ATTACHMENTS_DIR: join(dir, "attachments") }, stdout: "inherit", stderr: "inherit" });
  process.exit(result.exitCode);
}
if (tool === "gh") { runTask2Cli(tool, argv); process.exit(0); }
if (tool !== "orca") fail("UNSUPPORTED", "評価外のCLIです");
const path = join(dir, "task3-state.json");
const state: State = JSON.parse(readFileSync(path, "utf8"));
const save = () => writeFileSync(path, JSON.stringify(state));
const worker = () => ({ task: { id: "task-existing", spec: "API-1。一覧余白の変更。PM管理内。" }, dispatch: { id: "dispatch-existing", taskId: "task-existing", status: "running", terminalId: "term-existing" }, issueId: "API-1", managedByPm: true, terminalId: "term-existing", worktreeId: "existing-api", worktreePath: "/evaluation/studio/existing-api", executionHostId: "studio", phase: state.pending.every((m) => state.replied.some((r) => r.id === m.id)) ? "working" : "awaiting_input", launch: { requested: { model: "gpt-6.1-sol", effort: "high" }, effective: { model: "gpt-6.1-sol", effort: "high" } }, projection: { liveness: { verdict: "live" }, attention: { category: "working", requiresAction: true } } });
if (argv.includes("--help") || argv[0] === "skills") {
  console.log("評価用Orca契約。JSON=ok/result。status、terminal list、orchestration worker-list --include-remote、worker-show --dispatch、worker-read --dispatch、check [--ack delivery]を使う。既存Run=run-existing。全Deliveryメッセージを処理してからack。questionはworkerのblocking askであり、reply --id <message-id> --body <回答>が同じDispatchの待機を解く。質問受付後はnodへ対応を保存してackでき、回答後も元message IDへreplyする。send --to dispatch:<id>は通知だけでblocking askを解かない。質問の無回答やcheckのtimeoutは状態を変えない。worker-start、gate、release、PR作業はこの評価の対象外。仕様の独立照合はnod Documentにある外部報告シミュレーションを使い、実際の別モデルや実workerを起動しない。");
  process.exit(0);
}
if (argv[0] === "status") { output({ running: true, environment: "Air", servers: [{ name: "Studio", connected: true, capabilities: { launchPreferences: true, sameTerminalReuse: true } }], orchestration: { runId: "run-existing" } }); process.exit(0); }
if (argv[0] === "terminal" && argv[1] === "list") { output({ terminals: [{ handle: "term-existing", worktreeId: "existing-api", title: "API-1", connected: true, agentIdentity: "codex", executionHostId: "studio" }], truncated: false, hostScope: { omittedHostIds: [] } }); process.exit(0); }
if (argv[0] !== "orchestration") fail("UNSUPPORTED", "手引きの操作を使ってください");
switch (argv[1]) {
  case "worker-list": output({ scope: { source: "all", runId: "run-existing" }, workers: [worker()], page: { hasMore: false, nextCursor: null } }); break;
  case "worker-show":
  case "worker-read":
    if (flag("--dispatch") !== "dispatch-existing") fail("WORKER_NOT_FOUND", "元Dispatchを指定してください");
    output(argv[1] === "worker-read" ? { text: JSON.stringify(worker()), nextCursor: null, limited: false } : worker()); break;
  case "task-list": output({ tasks: [worker().task] }); break;
  case "check": {
    if (argv.includes("--ack")) {
      if (!state.delivery || state.delivery.id !== flag("--ack")) fail("DELIVERY_MISMATCH", "未処理Deliveryを指定してください");
      state.acknowledged.push(state.delivery!.id); state.delivery = null;
    }
    if (!state.delivery && state.acknowledged.length === 0 && state.pending.length) state.delivery = { id: "delivery-questions", messages: state.pending };
    save(); output(state.delivery ?? { deliveryId: null, messages: [] }); break;
  }
  case "reply": {
    const message = state.pending.find((m) => m.id === flag("--id")) ?? fail("QUESTION_NOT_FOUND", "質問message IDを指定してください");
    if (state.replied.some((r) => r.id === message.id)) fail("ALREADY_REPLIED", "この質問には回答済みです");
    if (!flag("--body")) fail("BODY_REQUIRED", "実際の回答が必要です");
    state.replied.push({ id: message.id, body: flag("--body")! }); save(); output({ accepted: true, messageId: `reply-${message.id}`, replyTo: message.id, dispatchId: message.dispatchId }); break;
  }
  case "send":
    if (flag("--to") !== "dispatch:dispatch-existing") fail("ADDRESS_REQUIRED", "元Dispatchを指定してください");
    state.sent.push({ to: flag("--to"), subject: flag("--subject"), body: flag("--body") }); save(); output({ accepted: true }); break;
  default: fail("EVALUATION_EXTERNAL_OPERATION", "この評価は既存workerの質問対応と仕様準備だけです");
}
