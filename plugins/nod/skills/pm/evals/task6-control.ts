import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

// 評価者だけが使う外部障害の解除。PMの採否判断やnod記録を変更しない。
const [directory, action] = process.argv.slice(2);
if (!directory || action !== "recover") throw new Error("使い方: bun task6-control.ts <評価directory> recover（評価者専用）");
const path = join(directory, "task6-state.json");
const state = JSON.parse(readFileSync(path, "utf8"));
if (state.variant !== "unknown") throw new Error("recoverはunknownシナリオ専用");
const worker = state.workers.find((w: { dispatch: { id: string } }) => w.dispatch.id === "dispatch-api1");
worker.phase = "waiting";
worker.launch.effective = { model: "gpt-6.1-sol", effort: "high" };
state.requests["op-api1-launch"] = { status: "completed", receipt: { taskId: "task-api1", dispatchId: "dispatch-api1", terminalId: "term-api1" } };
writeFileSync(path, JSON.stringify(state));
appendFileSync(join(directory, "operations.jsonl"), JSON.stringify({ tool: "control", argv: ["recover"], origin: "evaluator" }) + "\n");
console.log(JSON.stringify({ recovered: true, dispatchId: "dispatch-api1" }));
