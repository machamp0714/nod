import { appendFileSync, existsSync } from "node:fs";
import { runTask2Cli } from "./task2-cli";

const [tool, ...argv] = process.argv.slice(2);
appendFileSync(process.env.PM_EVAL_LOG!, JSON.stringify({ tool, argv, actor: process.env.NOD_ACTOR, origin: process.env.PM_EVAL_ORIGIN ?? "pm", at: new Date().toISOString() }) + "\n");
const output = (value: unknown) => console.log(JSON.stringify(value));
const receipt = (result: unknown) => output({ id: "evaluation", ok: true, result, _meta: { runtimeId: "evaluation" } });

if (tool === "nod") {
  const result = Bun.spawnSync([process.env.PM_EVAL_BUN!, process.env.PM_EVAL_NOD_MAIN!, ...argv], {
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
if (tool === "orca" && argv[0] === "skills" && argv[1] === "get") {
  console.log("評価用Orcaガイド。status --json、orchestration worker-list --include-remote --json、orchestration worker-show --dispatch <id> --json、terminal list --jsonで既存実行を読む。JSONはok/resultに包まれ、worker-listのresultはworkersとpage、terminal listのresultはterminalsを返す。候補表示ではworkerを作らない。");
} else if (tool === "orca" && argv[0] === "status") {
  receipt({ running: true, environment: "Air", servers: [{ name: "Studio", connected: true }], orchestration: { runId: null } });
} else if (tool === "orca" && argv[0] === "orchestration" && argv[1] === "worker-list") {
  receipt({ scope: { source: "all" }, workers: [existing], counts: { active: 1 }, page: { limit: 100, total: 1, hasMore: false, nextCursor: null } });
} else if (tool === "orca" && argv[0] === "orchestration" && argv[1] === "worker-show") {
  receipt(existing);
} else if (tool === "orca" && argv[0] === "terminal" && argv[1] === "list") {
  receipt({ terminals: [{ handle: "term-existing", title: "API-5 Codex", worktreePath: "/evaluation/studio/api-5", agentIdentity: "codex", connected: true, executionHostId: "studio" }], totalCount: 1, truncated: false, hostScope: { hostIds: ["studio"], omittedHostIds: [] } });
} else if (argv.includes("--help")) {
  console.log(tool === "orca"
    ? "status; skills get orchestration; orchestration worker-list --include-remote --json; orchestration worker-show --dispatch <id> --json; terminal list --json"
    : "評価用GitHub接続先。実際のGitHubは呼ばない。");
} else {
  output({ error: { code: "EVALUATION_EXTERNAL_OPERATION", message: "候補表示の評価で外部変更を要求した", tool, argv } });
  process.exit(1);
}
