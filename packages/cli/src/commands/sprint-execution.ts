import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { beginSprintSession, resumeSprintSession, observeSprintSession, getSprintExecutionState,
  prepareSprintExecution, requestSprintExecution, reconcileSprintExecution, recoverSprintExecution,
  createSprintOrcaAdapter, defaultOrcaRunner, NodError, type SprintExecutionState,
  type SprintSessionContext, type SprintSessionInput, type PrepareSprintExecutionInput } from "@nod/core";
import { act, actAsync } from "../context";
import { print } from "../output";

function input<T>(cmd: Command): T {
  const file = (cmd.opts() as { input: string }).input;
  let text: string;
  try { text = readFileSync(file === "-" ? 0 : file, "utf8"); }
  catch { throw new NodError("FILE_NOT_FOUND", "JSON入力を読み込めません"); }
  try { return JSON.parse(text) as T; }
  catch { throw new NodError("INVALID_ARGS", "入力をJSONとして読めません"); }
}
function external(cmd: Command) {
  const opts = cmd.opts() as { from?: string; environment?: string };
  return createSprintOrcaAdapter(defaultOrcaRunner(), { from: opts.from, environment: opts.environment });
}
function writable(command: Command): Command {
  return command.requiredOption("--input <file>", "JSONファイルまたは -（stdin）。保存したsessionId/generationと操作対象を指定")
    .option("--from <handle>", "現在のOrca監督端末（省略時は現在端末）")
    .option("--environment <name>", "元RunがあるOrcaの接続先");
}
function describe(state: SprintExecutionState): string {
  const current = state.session;
  return [
    `現在の監督: ${current ? `${current.caller}（世代${current.generation}、${current.state === "handover" ? "引継ぎ待ち" : "所有中"}）` : "未登録"}`,
    `元Run: ${current?.runId ?? "未確認"}  計画: ${current?.planId ?? "未確認"}  hash: ${current?.planHash ?? "未確認"}`,
    `占有: ${state.occupied}  予約: ${state.reserved}  実装開始: 確認待ち`,
    `最終確認: ${current?.observedAt ?? "未取得"}（${state.stale ? "現在の監督状態は未確認" : "取得時点の状態"}）`,
    ...state.unreconciledOwnership.map(a => `${a.sourceIssueKey}  通常経路の既存所有: ${a.assignee ?? "担当未確認"}（${a.status}）\n  実行場所: ${a.worktree ?? a.branch ?? "未確認"}\n  理由: ${a.reason.code} ${a.reason.message}`),
    ...state.attempts.map(a => `${a.sourceIssueKey}  ${a.parentAttemptId ? "補助担当" : "主担当"}: ${a.actor}  試行: ${a.id}\n  Task: ${a.taskId ?? "未確認"}  Dispatch: ${a.dispatchId ?? "未確認"}\n  配置: ${a.placement.on ?? "Run home"} / ${a.placement.worktree}\n  理由: ${a.reason.code} ${a.reason.message}`),
    ...state.operations.map(o => `操作: ${o.id}  ${o.kind === "task_create" ? "Task作成" : "担当起動"}  ${o.state}\n  request: ${o.requestId ?? "未取得"}${o.reason ? `\n  理由: ${o.reason.code} ${o.reason.message}` : ""}`),
    ...state.nextActions.map(action => `${action.description}\n  ${action.argv.join(" ")}${action.input ? `\n  入力JSON: ${JSON.stringify(action.input)}` : ""}`),
  ].join("\n");
}
export function registerSprintExecutionCommands(sprint: Command): void {
  const session = sprint.command("session").description("元Runと保存した監督の開始・引継ぎ・観測");
  writable(session.command("begin <sprint>").description("合意済み計画と元Runの現在権限を照合して監督を登録する"))
    .action(actAsync(async (cli, cmd, ref: string) => {
      const result = await beginSprintSession(cli.ctx, ref, input<SprintSessionInput>(cmd), external(cmd));
      print(cli, result, () => `現在の監督: ${result.caller}（世代${result.generation}）\n元Run: ${result.runId}\n計画: ${result.planId} ${result.planHash}`);
    }));
  writable(session.command("resume <sprint>").description("旧監督の新規許可を止め、元要求を照合して世代を交代する"))
    .action(actAsync(async (cli, cmd, ref: string) => {
      const result = await resumeSprintSession(cli.ctx, ref, input<SprintSessionContext & { requestKey: string }>(cmd), external(cmd));
      print(cli, result, () => `${describe(result.state)}${result.snapshot.reason ? `\n引継ぎ待ち: ${result.snapshot.reason.message}` : ""}`);
    }));
  writable(session.command("observe <sprint>").description("元Runの権限・Task・Dispatch・未確定操作を観測する"))
    .action(actAsync(async (cli, cmd, ref: string) => {
      const snapshot = await observeSprintSession(cli.ctx, ref, input<SprintSessionContext>(cmd), external(cmd));
      const state = getSprintExecutionState(cli.db, ref);
      print(cli, { state, snapshot }, () => `${describe(state)}\n照合: ${snapshot.reason?.message ?? "対応を確認しました"}`);
    }));
  const execution = sprint.command("execution").description("実行予約・元要求への合流と不明状態の確認");
  execution.command("show <sprint>").description("監督・所有・予約・拒否理由と照合手順を読む")
    .action(act((cli, _cmd, ref: string) => {
      const state = getSprintExecutionState(cli.db, ref); print(cli, state, () => describe(state));
    }));
  writable(execution.command("request <sprint>").description("同じ主試行を予約し、開始確認待ちの担当を依頼する"))
    .action(actAsync(async (cli, cmd, ref: string) => {
      const request = input<PrepareSprintExecutionInput | (SprintSessionContext & { attemptId: string })>(cmd);
      const attemptId = "attemptId" in request ? request.attemptId : prepareSprintExecution(cli.ctx, ref, request).id;
      const state = await requestSprintExecution(cli.ctx, ref, { sessionId: request.sessionId, generation: request.generation, attemptId }, external(cmd));
      print(cli, state, () => describe(state));
    }));
  writable(execution.command("reconcile <sprint>").description("保存した元request・Task・Dispatchへ送信せず合流する"))
    .action(actAsync(async (cli, cmd, ref: string) => {
      const state = await reconcileSprintExecution(cli.ctx, ref, input<SprintSessionContext>(cmd), external(cmd));
      print(cli, state, () => describe(state));
    }));
  writable(execution.command("recover <sprint>").description("元操作の非稼働証拠とOrcaの回復手順が揃った既知requestを回復する"))
    .action(actAsync(async (cli, cmd, ref: string) => {
      const state = await recoverSprintExecution(cli.ctx, ref, input<SprintSessionContext & { operationId: string }>(cmd), external(cmd));
      print(cli, state, () => describe(state));
    }));
}
