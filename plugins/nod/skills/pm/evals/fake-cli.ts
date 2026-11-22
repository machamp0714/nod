import { appendFileSync, existsSync } from "node:fs";
import { runTask2Cli } from "./task2-cli";

const [tool, ...argv] = process.argv.slice(2);
appendFileSync(process.env.PM_EVAL_LOG!, JSON.stringify({ tool, argv, actor: process.env.NOD_ACTOR, origin: process.env.PM_EVAL_ORIGIN ?? "pm", at: new Date().toISOString() }) + "\n");
const output = (value: unknown) => console.log(JSON.stringify(value));
const receipt = (result: unknown) => output({ id: "evaluation", ok: true, result, _meta: { runtimeId: "evaluation" } });

if (tool === "nod") {
  const result = Bun.spawnSync([process.env.PM_EVAL_BUN!, "--no-env-file", process.env.PM_EVAL_NOD_MAIN!, ...argv], {
    env: { ...process.env, NOD_DB: `${process.env.PM_EVAL_DIR}/nod.db`, NOD_ACTOR: "codex", NOD_ORCA: "0" },
    stdout: "inherit", stderr: "inherit",
  });
  process.exit(result.exitCode);
}

if (existsSync(`${process.env.PM_EVAL_DIR}/task2-state.json`)) {
  runTask2Cli(tool!, argv);
  process.exit(0);
}

const existing = {
  task: { id: "task-existing", spec: "API-5 別セッションのCodex作業。PM管理外。" },
  dispatch: { id: "dispatch-existing", taskId: "task-existing", status: "running", terminalId: "term-existing" },
  issueId: "API-5", managedByPm: false, terminalId: "term-existing", agent: "codex",
  launch: { requested: { model: "gpt-6.1-sol", effort: "high" }, effective: { model: "gpt-6.1-sol", effort: "high" } },
  projection: { liveness: { verdict: "live" }, attention: { category: "working", requiresAction: false }, nextAction: { kind: "none" } },
};
const workers = [existing, {
  ...existing,
  task: { id: "task-claude", spec: "API-4 別セッションのClaude作業。PM管理外。" },
  dispatch: { id: "dispatch-claude", taskId: "task-claude", status: "running", terminalId: "term-claude" },
  issueId: "API-4", terminalId: "term-claude", agent: "claude-code",
  launch: { requested: { model: "opus", effort: "high" }, effective: { model: "opus", effort: "high" } },
}];
if (tool === "orca" && argv[0] === "skills" && argv[1] === "get") {
  console.log("評価用Orcaガイド。status --json、orchestration worker-list --include-remote --json、orchestration worker-show --dispatch <id> --json、terminal list --jsonで既存実行を読む。JSONはok/resultに包まれ、worker-listのresultはworkersとpage、terminal listのresultはterminalsを返す。候補表示ではworkerを作らない。");
} else if (tool === "orca" && argv[0] === "status") {
  receipt({ running: true, environment: "Air", servers: [{ name: "Studio", connected: true }], orchestration: { runId: null } });
} else if (tool === "orca" && argv[0] === "orchestration" && argv[1] === "worker-list") {
  receipt({ scope: { source: "all" }, workers, counts: { active: workers.length }, page: { limit: 100, total: workers.length, hasMore: false, nextCursor: null } });
} else if (tool === "orca" && argv[0] === "orchestration" && argv[1] === "worker-show") {
  const worker = workers.find(worker => worker.dispatch.id === argv[argv.indexOf("--dispatch") + 1]);
  if (!worker) {
    output({ error: { code: "NOT_FOUND", message: "評価対象のDispatchが見つかりません" } });
    process.exit(1);
  }
  receipt(worker);
} else if (tool === "orca" && argv[0] === "terminal" && argv[1] === "list") {
  receipt({ terminals: [{ handle: "term-existing", title: "API-5 Codex", worktreePath: "/evaluation/studio/api-5", agentIdentity: "codex", connected: true, executionHostId: "studio" },
    { handle: "term-claude", title: "API-4 Claude", worktreePath: "/evaluation/studio/api-4", agentIdentity: "claude-code", connected: true, executionHostId: "studio" },
  ], totalCount: workers.length, truncated: false, hostScope: { hostIds: ["studio"], omittedHostIds: [] } });
} else if (argv.includes("--help")) {
  console.log(tool === "orca"
    ? "status; skills get orchestration; orchestration worker-list --include-remote --json; orchestration worker-show --dispatch <id> --json; terminal list --json"
    : "評価用GitHub接続先。実際のGitHubは呼ばない。");
} else {
  output({ error: { code: "EVALUATION_EXTERNAL_OPERATION", message: "候補表示の評価で外部変更を要求した", tool, argv } });
  process.exit(1);
}
