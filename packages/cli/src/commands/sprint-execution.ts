import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { beginSprintSession, resumeSprintSession, observeSprintSession, getSprintExecutionState,
  prepareSprintExecution, requestSprintExecution, reconcileSprintExecution, recoverSprintExecution,
  createSprintOrcaAdapter, defaultOrcaRunner, collectSprintSelfMetadata, collectSprintSelfHost,
  receiveSprintHostObservation, prepareSprintStartConfirmation, requestSprintExecutionStart,
  receiveSprintNotifications, getSprintNotificationState, type SprintNotificationInput, type SprintNotificationState,
  ORCA_TIMEOUT_MS, NodError, type SprintExecutionState,
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
    `占有: ${state.occupied} / 上限 ${state.maxParallel ?? "未確認"}（主試行の予約: ${state.reserved}、通常所有の未照合: ${state.unreconciledOwnership.length}）  実装開始: ${state.canStart ? "許可あり・開始報告を確認" : "不可・理由を確認"}`,
    `保存状態の取得: ${state.observedAt}（Orcaの再照合日時とは別）`,
    `最終確認: ${current?.observedAt ?? "未取得"}（${state.stale ? "現在の監督状態は未確認" : "取得時点の状態"}）`,
    ...state.unreconciledOwnership.map(a => `${a.sourceIssueKey}  通常経路の既存所有: ${a.assignee ?? "担当未確認"}（${a.status}）\n  実行場所: ${a.worktree ?? a.branch ?? "未確認"}\n  理由: ${a.reason.code} ${a.reason.message}`),
    ...state.attempts.map(a => `${a.sourceIssueKey}  ${a.parentAttemptId ? "補助担当" : "主担当"}: ${a.actor}  試行: ${a.id}\n  Task: ${a.taskId ?? "未確認"}  Dispatch: ${a.dispatchId ?? "未確認"}\n  配置: ${a.placement.on ?? "Run home"} / ${a.placement.worktree}\n  理由: ${a.reason.code} ${a.reason.message}
  工程: ${a.phase} / 実行観測: ${a.executionLiveness?.verdict ?? "未取得"}（${a.executionLiveness?.observedAt ?? "未取得"} / ${a.executionLiveness?.source ?? "取得元未記録"}）
  要求した実行設定: ${a.settingsRequirement?.agent ?? a.placement.agent} / ${a.settingsRequirement?.model ?? "未指定・継承条件を確認"} / ${a.settingsRequirement?.effort ?? "未指定・継承条件を確認"} / ${a.settingsRequirement?.target ?? a.placement.on ?? a.placement.worktree}（取得元: 合意済み計画 ${a.planId}、要求記録日時: 未記録）
  起動receipt: ${JSON.stringify(state.operations.find(o => o.attemptId === a.id && o.kind === "worker_start")?.receipt ?? null)}
  ホストの実行設定: ${a.hostObservation?.metadata.model ?? "取得不能"} / ${a.hostObservation?.metadata.effort ?? "取得不能"}（取得元: ${a.hostObservation?.metadata.source ?? "未取得"}）
  設定適用: ${a.hostObservation?.metadata.settingsAppliedAt ?? "取得不能"} / 採取: ${a.hostObservation?.metadata.collectedAt ?? "未取得"} / Orca観測: ${a.hostObservation?.independent?.observedAt ?? "未取得"} / PM照合: ${a.hostObservation?.verifiedAt ?? "未取得"}
  起動: ${state.operations.find(o => o.attemptId === a.id && o.kind === "worker_start")?.state ?? "未記録"} / 開始許可通知: ${state.operations.find(o => o.attemptId === a.id && o.kind === "worker_begin")?.state ?? "未記録"} / 実開始報告: ${a.startedReport?.reportedAt ?? "未記録"}${a.phase === "completed" ? " / 担当終了確認・成果確認待ち" : ""}`),
    ...state.operations.map(o => `操作: ${o.id}  ${o.kind === "task_create" ? "Task作成" : o.kind === "worker_start" ? "担当起動" : "開始許可通知"}  ${o.state}\n  request: ${o.requestId ?? "未取得"}${o.reason ? `\n  理由: ${o.reason.code} ${o.reason.message}` : ""}`),
    "再照合手順は、元RunのOrca接続先と同じnod DBを使う端末で実行してください。保存状態の再取得だけではOrcaを再照合しません。",
    ...state.nextActions.map(action => `${action.description}\n  ${action.command}`),
  ].join("\n");
}
function describeNotifications(state: SprintNotificationState): string {
  return [describe(state.execution), `受理結果: ${state.results.length}  受信ID: ${state.receptions.length}  競合: ${state.conflicts.length}  隔離: ${state.quarantined.length}`,
    ...state.results.map(r => `受理結果: ${r.id}（${r.kind === "question" ? "相談" : r.kind === "completion" ? "完了通知" : r.kind === "observation" ? "ホスト観測" : r.kind === "notice" ? "通知" : "要求の拒否"}）${r.completion ? `\n  完了の照合: ${r.completion.state}  次所有者: ${r.completion.nextOwner ?? "未確定"}  解放: ${r.completion.ownership.state} / 物理解放receipt: ${r.completion.ownership.receipt?.state ?? "未取得"} / 解放operation: ${r.completion.releaseOperation?.state ?? "未記録"} / 理由: ${r.completion.ownership.receipt?.reason ?? "未取得"}` : ""}`),
    ...state.deliveries.map(d => `配送: ${d.deliveryId}  ack: ${d.acknowledged ? "確認済み" : "未確定"}${d.reason ? `\n  理由: ${d.reason.code} ${d.reason.message}` : ""}\n${d.rows.filter(r => r.reason).map(r => `  受信ID: ${r.messageId ?? "解析不能"}  ${r.reason!.code} ${r.reason!.message}`).join("\n")}`),
    ...state.quarantined.map(q => `隔離した受信ID: ${q.messageId}  ${q.reason.code} ${q.reason.message}`),
  ].join("\n");
}
export function registerSprintExecutionCommands(sprint: Command): void {
  const worker = sprint.command("worker").description("自己metadataの観測専用操作");
  worker.command("collect").description("自身の既定thread metadataだけを読む（nod DBは開かない）")
    .action(() => { process.stdout.write(JSON.stringify(collectSprintSelfMetadata(), null, 2) + "\n"); });
  worker.command("observe <sprint>").description("自身の観測専用statusを元Runへ送る（nod DBは開かない）")
    .requiredOption("--run <id>", "保存したRun").requiredOption("--task <id>", "現在のTask")
    .requiredOption("--dispatch <id>", "現在のDispatch").requiredOption("--attempt <id>", "保存した試行")
    .requiredOption("--dispatch-capability <value>", "現在のpreambleにあるDispatch capability")
    .option("--confirmation <id>", "新しい開始確認ID").option("--authorization <id>", "開始報告の対象許可ID")
    .action(async (ref: string, opts: { run: string; task: string; dispatch: string; attempt: string; dispatchCapability: string; confirmation?: string; authorization?: string }) => {
      const metadata = collectSprintSelfMetadata(), run = defaultOrcaRunner();
      if (!metadata.terminal) throw new NodError("SELF_IDENTITY_REQUIRED", "自身のOrca terminal identityを確認できません");
      if (!run) throw new NodError("ORCA_DISABLED", "元Runへの観測送信を利用できません");
      const host = await collectSprintSelfHost(run, metadata);
      const observationId = crypto.randomUUID();
      const payload = { kind: opts.authorization ? "nod.sprint.worker-started" : "nod.sprint.host-observation", schemaVersion: 1,
        observationId,
        sprintId: ref, attemptId: opts.attempt, runId: opts.run, taskId: opts.task, dispatchId: opts.dispatch, metadata, host,
        ...(opts.confirmation ? { confirmationId: opts.confirmation } : {}), ...(opts.authorization ? { authorizationId: opts.authorization } : {}) };
      const response = await run(["orchestration", "send", "--from", metadata.terminal, "--dispatch-capability", opts.dispatchCapability,
        "--type", "status", "--subject", "Sprint実行host観測", "--payload", JSON.stringify(payload), "--json"], { timeoutMs: ORCA_TIMEOUT_MS, maxStdoutBytes: 1024 * 1024 });
      // raw応答/本文/capabilityは出力しない。応答不明は再送せず、実requestを照合する。
      let envelope: any = {};
      if (response.kind === "exited") { try { envelope = JSON.parse(response.stdout); } catch { /* unknown */ } }
      const result = envelope.result ?? {}, relay = result.relay ?? {}, message = result.message ?? {};
      process.stdout.write(JSON.stringify({ accepted: envelope.ok === true && result.accepted === true,
        observationId,
        messageId: relay.messageId ?? message.id ?? null, requestId: result.mutation?.requestId ?? envelope.error?.data?.orchestrationRequestId ?? null,
        source: "Orca観測status送信receipt", receivedAt: new Date().toISOString(), metadataStatus: metadata.status }, null, 2) + "\n");
    });
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
  writable(execution.command("receive <sprint>").description("元Runの配送全行を受理し、必要な返信・次所有者を確定して現在Deliveryをackする"))
    .action(actAsync(async (cli, cmd, ref: string) => {
      const state = await receiveSprintNotifications(cli.ctx, ref, input<SprintNotificationInput>(cmd), external(cmd));
      print(cli, state, () => describeNotifications(state));
    }));
  execution.command("notifications <sprint>").description("保存した通知結果・受信ID・配送ackと未確定の理由を読む")
    .action(act((cli, _cmd, ref: string) => {
      const state = getSprintNotificationState(cli.db, ref); print(cli, state, () => describeNotifications(state));
    }));
  writable(execution.command("receive-observation <sprint>").description("実Orca statusと独立hostを照合して観測だけを記録する"))
    .action(actAsync(async (cli, cmd, ref: string) => {
      const state = await receiveSprintHostObservation(cli.ctx, ref, input<{ messageId: string }>(cmd), external(cmd));
      print(cli, state, () => describe(state));
    }));
  writable(execution.command("confirm-start <sprint>").description("現在の同担当に開始直前の再観測を求める確認IDを保存する"))
    .action(act((cli, cmd, ref: string) => {
      const value = prepareSprintStartConfirmation(cli.ctx, ref, input<SprintSessionContext & { attemptId: string }>(cmd));
      print(cli, value, () => `開始確認: ${value.id}\n同じ担当からこのIDを付けた観測statusを取得してください`);
    }));
  writable(execution.command("start <sprint>").description("同じ開始確認の新観測と着手条件を再検査し、同Task・Dispatchへ開始を通知する"))
    .action(actAsync(async (cli, cmd, ref: string) => {
      const state = await requestSprintExecutionStart(cli.ctx, ref, input<SprintSessionContext & { attemptId: string; messageId: string; confirmationId: string }>(cmd), external(cmd));
      print(cli, state, () => describe(state));
    }));
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
