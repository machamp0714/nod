import { appendFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// 評価者が明示した実回答だけを一時DBへ投入する。PMの推論や代理回答には使わない。
const [directory, issue, question, answer] = process.argv.slice(2);
if (!directory || !issue || !question || !answer) throw new Error("使い方: task3-human.ts <評価dir> <IssueID> <質問ID> <実回答原文>");
const dir = resolve(directory);
if (!existsSync(join(dir, "task3-state.json"))) throw new Error("Task3の一時評価環境だけを指定してください");
const argv = ["-w", "API", "answer", issue, answer, "--question", question, "--json"];
appendFileSync(join(dir, "operations.jsonl"), JSON.stringify({ tool: "nod", argv, actor: "me", origin: "evaluator", at: new Date().toISOString() }) + "\n");
const result = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../../../../../packages/cli/src/main.ts"), ...argv], { env: { ...process.env, NOD_DB: join(dir, "nod.db"), NOD_ACTOR: "me", NOD_ORCA: "0", NOD_DOCS_DIR: join(dir, "documents"), NOD_ATTACHMENTS_DIR: join(dir, "attachments") }, stdout: "inherit", stderr: "inherit" });
process.exit(result.exitCode);
