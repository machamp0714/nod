import { expect, test } from "bun:test";
import * as core from "../src/index";
import { setup } from "./helpers";
import { prepareSprint, sprintTestClock as clock } from "./fixtures/sprint-start";

const at = clock.now.toISOString();
async function notifications() {
  const s = setup(), issue = core.createIssue(s.me, { workspaceId: s.ws.id, title: "再配送を受ける仕事" });
  const p = prepareSprint(s.me, s.ws.key, [issue.id]);
  const proposal = core.proposeSprintPlan(s.me, p.sprint.id, { ...p.input, expectedVersion: p.sprint.version, requestKey: "設定",
    constraints: { ...p.input.constraints, model: "fixture-model", effort: "high", executionTarget: "studio" } });
  const ready = core.acceptSprintPlan(s.me, p.sprint.id, proposal.plan.id, { expectedVersion: proposal.sprint.version, requestKey: "合意", contentHash: proposal.plan.contentHash });
  const sprint = core.activateSprint(s.me, ready.sprint.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, clock);
  const identity = { terminal: "fixture-terminal", incarnationId: "fixture-incarnation", runtimeId: "fixture-host", remoteRuntimeEpoch: null };
  const host = { runId: "fixture-run", taskId: "fixture-task", dispatchId: "fixture-dispatch", identity, cwd: "/fixture", agent: "codex", active: true, exactWorker: true,
    liveness: "live" as const, source: "独立Orca観測", observedAt: at, livenessSource: "execution_host", livenessObservedAt: at };
  let delivery: any;
  const acks: string[] = [], sends: string[] = [];
  const adapter: core.SprintOrcaAdapter = {
    authority: async () => ({ runId: "fixture-run", caller: "fixture-pm", coordinator: "fixture-pm", consumerGeneration: 1, runtimeId: "fixture-home", source: "Orca", observedAt: at }),
    send: async o => { sends.push(o.id); return { runId: "fixture-run", taskId: "fixture-task", dispatchId: o.kind === "task_create" ? null : "fixture-dispatch", requestId: "request:" + o.id,
      identity: null, requested: null, effective: null, source: "Orca receipt", receivedAt: at }; },
    host: async () => host,
    // 外部adapterの公開境界。業務判断・DB・送信元照合は実coreで行う。
    check: async () => delivery,
    acknowledge: async (_run: string, id: string) => { acks.push(id); return { acknowledged: id, next: null }; },
  };
  const session = await core.beginSprintSession(s.llm, sprint.id, { expectedVersion: sprint.version, requestKey: "監督", runId: "fixture-run" }, adapter, clock);
  const context = { sessionId: session.id, generation: 1 };
  const attempt = core.prepareSprintExecution(s.llm, sprint.id, { ...context, requestKey: "担当", itemId: p.items[0]!.id, actor: s.llm.actor,
    spec: "仕事", placement: { agent: "codex", worktree: "path:/fixture", on: "studio", model: "fixture-model", effort: "high" } }, clock);
  await core.requestSprintExecution(s.llm, sprint.id, { ...context, attemptId: attempt.id }, adapter, clock);
  const message = { id: "fixture-message", runId: "fixture-run", fromHandle: "dispatch:fixture-dispatch", type: "status", receivedAt: at,
    payload: { kind: "nod.sprint.host-observation", schemaVersion: 1, observationId: "fixture-collection", sprintId: sprint.id, attemptId: attempt.id, runId: "fixture-run", taskId: "fixture-task", dispatchId: "fixture-dispatch",
      metadata: { schemaVersion: 1, status: "observed", reasons: [], threadId: "fixture-thread", turnId: "fixture-turn", terminal: identity.terminal, cwd: "/fixture", model: "fixture-model", effort: "high", provider: "fixture-provider", cliVersion: "0.164.0", settingsAppliedAt: at, collectedAt: at, collectorDigest: "a".repeat(64), metadataDigest: "b".repeat(64), source: "provider metadata", association: "thread/context/usage" },
      host: { identity, cwd: "/fixture", source: "自己host観測", observedAt: at } } };
  const batch = (id: string, messages: unknown[] = [message]) => { delivery = { runId: "fixture-run", deliveryId: id, messages, count: messages.length, source: "Orca check", observedAt: at }; };
  return { ...s, sprint, issue, context, attempt, adapter, message, batch, acks, sends, host };
}

test("同じ観測messageの別Deliveryは保存した同じ業務結果へ合流し、現在Deliveryだけをackする", async () => {
  const s = await notifications();
  s.batch("delivery-first");
  const first = await core.receiveSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock);
  s.batch("delivery-next");
  const next = await core.receiveSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock);
  expect(next.results).toHaveLength(1);
  expect(next.results[0]?.id).toBe(first.results[0]?.id);
  expect(next.receptions).toHaveLength(1);
  expect(next.deliveries.map(d => d.deliveryId)).toEqual(["delivery-first", "delivery-next"]);
  expect(s.acks).toEqual(["delivery-first", "delivery-next"]);
  expect(next.execution.attempts[0]?.observationHistory).toHaveLength(1);
  expect(next.execution.attempts[0]?.hostObservation?.result).toBe("matched");
  expect(next.execution).toMatchObject({ occupied: 1, reserved: 1 });
  expect(s.sends).toHaveLength(2);
  s.db.close();
});

test("解析不能行が途中にあってもbatch全行を処理し、正常行を保存してack不可の行と理由を返す", async () => {
  const s = await notifications();
  const later = structuredClone(s.message); later.id = "fixture-message-last";
  later.payload.observationId = "fixture-new-collection";
  later.payload.metadata.collectedAt = "2026-03-08T11:59:59.999Z";
  s.batch("delivery-mixed", [s.message, { broken: true }, later]);
  const state = await core.receiveSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock);
  expect(state.results).toHaveLength(2);
  expect(state.receptions).toHaveLength(2);
  expect(state.deliveries[0]).toMatchObject({ acknowledged: false, reason: { code: "BATCH_INCOMPLETE" },
    rows: [{ messageId: s.message.id, resultId: state.results[0]?.id, reason: null },
      { messageId: null, reason: { code: "INVALID_ENVELOPE" } },
      { messageId: later.id, resultId: state.results[1]?.id, reason: null }] });
  expect(s.acks).toEqual([]);
  expect(core.getSprintNotificationState(s.db, s.sprint.id, clock).results).toHaveLength(2);
  s.db.close();
});

test("同じ業務キーの別受信IDは元結果を返し、内容違いは元観測を変えず競合と受信拒否を保存する", async () => {
  const s = await notifications(); s.batch("delivery-original");
  const original = await core.receiveSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock);
  const replay = structuredClone(s.message); replay.id = "fixture-relayed-message";
  const conflict = structuredClone(replay); conflict.id = "fixture-conflict"; conflict.payload.metadata.effort = "low";
  s.batch("delivery-received", [replay, conflict]);
  const state = await core.receiveSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock);
  expect(state.results).toHaveLength(1);
  expect(state.results[0]).toEqual(original.results[0]);
  expect(state.receptions).toHaveLength(3);
  expect(state.receptions[1]?.resultId).toBe(original.results[0]?.id);
  expect(state.receptions[2]).toMatchObject({ messageId: conflict.id, resultId: null, reason: { code: "IDEMPOTENCY_CONFLICT" } });
  expect(state.conflicts).toHaveLength(1);
  expect(state.conflicts[0]).toMatchObject({ logicalKey: original.results[0]?.logicalKey, existingResultId: original.results[0]?.id });
  expect(state.execution.attempts[0]?.observationHistory).toHaveLength(1);
  expect(state.execution.attempts[0]?.hostObservation?.metadata.effort).toBe("high");
  s.db.close();
});

test("単独観測受理からbatch再配送へ合流しても、別の開始確認に採り直した観測を重複としない", async () => {
  const s = await notifications();
  s.adapter.status = async () => s.message;
  await core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: s.message.id }, s.adapter, clock);
  const initial = core.getSprintNotificationState(s.db, s.sprint.id, clock);
  expect(initial.results).toHaveLength(1);
  const confirmation = core.prepareSprintStartConfirmation(s.llm, s.sprint.id, { ...s.context, attemptId: s.attempt.id }, clock);
  const replay = structuredClone(s.message); replay.id = "fixture-new-receive-id";
  const confirmed = { ...structuredClone(s.message), id: "fixture-confirmed", payload: { ...structuredClone(s.message.payload), confirmationId: confirmation.id } };
  s.batch("delivery-confirm", [replay, confirmed]);
  const state = await core.receiveSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock);
  expect(state.results).toHaveLength(2);
  expect(state.results[0]?.id).toBe(initial.results[0]?.id);
  expect(state.results[0]?.observation).toEqual(initial.results[0]?.observation);
  expect(state.results[1]?.observation).toMatchObject({ messageId: confirmed.id, confirmationId: confirmation.id,
    metadata: { settingsAppliedAt: at, collectedAt: at, collectorDigest: "a".repeat(64) } });
  expect(state.execution.attempts[0]?.observationHistory).toHaveLength(2);
  expect(s.acks).toEqual(["delivery-confirm"]);
  s.db.close();
});

test("業務適用後にack送信や応答を失っても元結果を保持し、再配送では新しい現在Deliveryだけをackする", async () => {
  for (const ackApplied of [false, true]) {
    const s = await notifications(), acknowledge = s.adapter.acknowledge!;
    s.batch("delivery-ack-lost");
    s.adapter.acknowledge = async (_run, id) => { if (ackApplied) s.acks.push(id); throw Error("通信中断"); };
    const unknown = await core.receiveSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock);
    expect(unknown.deliveries[0]).toMatchObject({ acknowledged: false, reason: { code: "ACK_UNKNOWN" } });
    expect(unknown.results).toHaveLength(1);
    s.adapter.acknowledge = acknowledge; s.batch("delivery-after-loss");
    const recovered = await core.receiveSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock);
    expect(recovered.results[0]?.id).toBe(unknown.results[0]?.id);
    expect(recovered.execution.attempts[0]?.observationHistory).toHaveLength(1);
    expect(s.acks).toEqual(ackApplied ? ["delivery-ack-lost", "delivery-after-loss"] : ["delivery-after-loss"]);
    s.db.close();
  }
});

test("開始確認観測の受信IDが変わっても保存済み観測へ対応させ、元confirmationで開始を一回だけ通知する", async () => {
  const s = await notifications(); s.batch("delivery-initial");
  await core.receiveSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock);
  const confirmation = core.prepareSprintStartConfirmation(s.llm, s.sprint.id, { ...s.context, attemptId: s.attempt.id }, clock);
  const observed = { ...structuredClone(s.message), id: "fixture-before-start", payload: { ...structuredClone(s.message.payload), observationId: "fixture-confirmation-collection", confirmationId: confirmation.id } };
  s.batch("delivery-before-start", [observed]);
  const saved = await core.receiveSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock);
  const relayed = { ...observed, id: "fixture-before-start-relayed" };
  s.adapter.status = async () => relayed;
  const send = s.adapter.send!;
  s.adapter.send = async o => ({ ...await send(o), ...(o.kind === "worker_begin" ? { notification: { messageId: "fixture-start-message", toHandle: "dispatch:fixture-dispatch", accepted: true as const } } : {}) });
  const input = { ...s.context, attemptId: s.attempt.id, messageId: relayed.id, confirmationId: confirmation.id };
  const started = await core.requestSprintExecutionStart(s.llm, s.sprint.id, input, s.adapter, clock);
  expect(started.attempts[0]).toMatchObject({ phase: "start_authorized", startAuthorization: { confirmationId: confirmation.id } });
  await core.requestSprintExecutionStart(s.llm, s.sprint.id, input, s.adapter, clock);
  expect(s.sends).toHaveLength(3);
  expect(core.getSprintNotificationState(s.db, s.sprint.id, clock).results[1]).toEqual(saved.results[1]);
  s.db.close();
});

test("公開Orca adapterは文字列payloadを解析し全行と原countを保ち、ack応答の次Deliveryも返す", async () => {
  const s = await notifications(), commands: string[][] = [];
  const raw = { id: s.message.id, run_id: "fixture-run", delivery_contract: "current_delivery", from_handle: s.message.fromHandle,
    to_handle: "run:fixture-run", type: "status", body: "観測", payload: JSON.stringify(s.message.payload), created_at: at, delivered_at: null };
  const runner: core.OrcaRunner = async args => {
    commands.push(args);
    const result = args.includes("--ack") ? { runId: "fixture-run", deliveryId: "fixture-next-delivery", messages: [raw, { invalid: true }], count: 2, acknowledged: "fixture-current-delivery" }
      : { runId: "fixture-run", deliveryId: "fixture-current-delivery", messages: [raw], count: 1, acknowledged: null };
    return { kind: "exited", exitCode: 0, stdout: JSON.stringify({ ok: true, result, _meta: { runtimeId: "fixture-home" } }), stderr: "" };
  };
  const adapter = core.createSprintOrcaAdapter(runner, { from: "fixture-pm", clock });
  const batch = await adapter.check!("fixture-run");
  expect(batch).toMatchObject({ deliveryId: "fixture-current-delivery", count: 1, messages: [{ id: s.message.id, payload: s.message.payload }] });
  const ack = await adapter.acknowledge!("fixture-run", "fixture-current-delivery");
  expect(ack).toMatchObject({ acknowledged: "fixture-current-delivery", next: { deliveryId: "fixture-next-delivery", count: 2 } });
  expect(ack.next?.messages).toHaveLength(2);
  expect(commands).toEqual([
    ["orchestration", "check", "--terminal", "fixture-pm", "--run", "fixture-run", "--json"],
    ["orchestration", "check", "--terminal", "fixture-pm", "--run", "fixture-run", "--ack", "fixture-current-delivery", "--json"],
  ]);
  s.db.close();
});

test("通常の相談は観測JSONへ変換せず保存し、必要な返信を確定するまでackせず同回答を再利用する", async () => {
  const s = await notifications(), replies: string[] = [];
  const question = { id: "fixture-question", runId: "fixture-run", fromHandle: "dispatch:fixture-dispatch", type: "question", receivedAt: at,
    body: "どの成果を確認しますか", payload: { taskId: "fixture-task", dispatchId: "fixture-dispatch", question: "どの成果を確認しますか", options: [] } };
  s.adapter.reply = async (_run, id, body) => { replies.push(body); return { questionId: id, answerMessageId: "fixture-answer", body, status: "answered", requestId: "fixture-reply-request", source: "Orca reply", observedAt: at }; };
  s.batch("delivery-open-question", [question]);
  const pending = await core.receiveSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock);
  expect(pending.results).toHaveLength(1);
  expect(pending.results[0]).toMatchObject({ kind: "question", question: { text: question.body } });
  expect(pending.deliveries[0]).toMatchObject({ acknowledged: false, rows: [{ reason: { code: "REPLY_REQUIRED" } }] });
  expect(s.acks).toEqual([]);
  s.batch("delivery-answer", [question]);
  const answered = await core.receiveSprintNotifications(s.llm, s.sprint.id, { ...s.context, answers: [{ messageId: question.id, body: "保存した成果を確認してください" }] }, s.adapter, clock);
  expect(answered.results[0]?.id).toBe(pending.results[0]?.id);
  expect(answered.receptions[0]?.reply).toMatchObject({ state: "confirmed", body: "保存した成果を確認してください", receipt: { answerMessageId: "fixture-answer" } });
  s.batch("delivery-question-replay", [question]);
  const replayed = await core.receiveSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock);
  expect(replayed.results).toHaveLength(1);
  expect(replies).toEqual(["保存した成果を確認してください"]);
  expect(s.acks).toEqual(["delivery-answer", "delivery-question-replay"]);
  expect(core.getIssue(s.db, s.issue.id).status).toBe("todo");
  expect(replayed.execution).toMatchObject({ occupied: 1, reserved: 1 });
  s.db.close();
});

test("観測専用kindを質問へ混ぜた識別要求には構造化エラーを返信し、観測や一般Issue更新へ適用しない", async () => {
  const s = await notifications(), replies: any[] = [];
  const question = { id: "fixture-identified-question", runId: "fixture-run", fromHandle: "dispatch:fixture-dispatch", type: "question", receivedAt: at,
    payload: { taskId: "fixture-task", dispatchId: "fixture-dispatch", question: JSON.stringify(s.message.payload), options: [] } };
  s.adapter.reply = async (_run, id, body) => { replies.push(JSON.parse(body)); return { questionId: id, body, answerMessageId: "fixture-error-answer", requestId: "fixture-reply", status: "answered", source: "Orca reply", observedAt: at }; };
  s.batch("delivery-identified-question", [question]);
  const state = await core.receiveSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock);
  expect(replies).toEqual([expect.objectContaining({ error: { code: "OBSERVATION_STATUS_REQUIRED", message: expect.any(String) } })]);
  expect(state.results[0]?.kind).toBe("request_rejected");
  expect(state.execution.attempts[0]?.observationHistory ?? []).toHaveLength(0);
  expect(core.getIssue(s.db, s.issue.id).status).toBe("todo");
  expect(s.acks).toEqual(["delivery-identified-question"]);
  s.db.close();
});

test("識別子付き一般要求と不正JSONはエラーへ保存し、同じ業務要求の別受信IDにも同じ結果を返信する", async () => {
  const s = await notifications(), replies: any[] = [];
  const request = { kind: "nod.sprint.worker-request", schemaVersion: 1, requestId: "fixture-worker-request", operation: "log", payload: { text: "仕事の報告" } };
  const question = { id: "fixture-request-message", runId: "fixture-run", fromHandle: "dispatch:fixture-dispatch", type: "question", receivedAt: at,
    payload: { taskId: "fixture-task", dispatchId: "fixture-dispatch", question: JSON.stringify(request), options: [] } };
  s.adapter.reply = async (_run, id, body) => { replies.push({ id, ...JSON.parse(body) }); return { questionId: id, body, answerMessageId: "answer:" + id, requestId: "reply:" + id, status: "answered", source: "Orca reply", observedAt: at }; };
  const relayed = { ...question, id: "fixture-request-relayed" };
  const malformed = { ...question, id: "fixture-invalid-json", payload: { ...question.payload, question: '{"kind":"nod.sprint.worker-request","requestId":' } };
  s.batch("delivery-requests", [question, relayed, malformed]);
  const state = await core.receiveSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock);
  expect(state.results).toHaveLength(2);
  expect(state.receptions[0]?.resultId).toBe(state.receptions[1]?.resultId);
  expect(replies.map(r => r.error.code)).toEqual(["UNSUPPORTED_OPERATION", "UNSUPPORTED_OPERATION", "INVALID_REQUEST"]);
  expect(replies[0]?.requestId).toBe("fixture-worker-request");
  expect(s.acks).toEqual(["delivery-requests"]);
  expect(core.getIssue(s.db, s.issue.id).status).toBe("todo");
  expect(state.execution.attempts[0]?.observationHistory ?? []).toHaveLength(0);
  s.db.close();
});

test("公開Orca adapterの返信は実question状態と回答messageの対応を検査し、保存済みbodyをargvで送る", async () => {
  const commands: string[][] = [], body = "同じ保存済み回答";
  const adapter = core.createSprintOrcaAdapter(async args => {
    commands.push(args);
    return { kind: "exited", exitCode: 0, stdout: JSON.stringify({ ok: true, result: {
      message: { id: "fixture-answer", run_id: "fixture-run", from_handle: "run:fixture-run", to_handle: "dispatch:fixture-dispatch", type: "status", thread_id: "fixture-question", body },
      question: { message_id: "fixture-question", run_id: "fixture-run", dispatch_id: "fixture-dispatch", asker_handle: "dispatch:fixture-dispatch", status: "answered", answer_message_id: "fixture-answer", answer_body: body, answered_by_generation: 1, answered_at: at },
      duplicate: false, mutation: { requestId: "fixture-reply-request" } } }), stderr: "" };
  }, { from: "fixture-pm", clock });
  const receipt = await adapter.reply!("fixture-run", "fixture-question", body);
  expect(receipt).toMatchObject({ questionId: "fixture-question", answerMessageId: "fixture-answer", body, status: "answered", requestId: "fixture-reply-request" });
  expect(commands).toEqual([["orchestration", "reply", "--id", "fixture-question", "--body", body, "--run", "fixture-run", "--from", "fixture-pm", "--json"]]);
});

test("返信応答を失って監督が交代しても元業務結果と回答を保ち、別callerのrequest IDを再送に使わない", async () => {
  const s = await notifications();
  const question = { id: "fixture-lost-question", runId: "fixture-run", fromHandle: "dispatch:fixture-dispatch", type: "question", receivedAt: at,
    payload: { taskId: "fixture-task", dispatchId: "fixture-dispatch", question: "確認先を教えてください", options: [] } };
  s.adapter.reply = async () => { throw new core.SprintOrcaMutationError("fixture-old-caller-reply"); };
  s.batch("delivery-lost-reply", [question]);
  const pending = await core.receiveSprintNotifications(s.llm, s.sprint.id, { ...s.context, answers: [{ messageId: question.id, body: "同じ成果を確認" }] }, s.adapter, clock);
  expect(pending.receptions[0]?.reply).toMatchObject({ state: "unknown", requestId: "fixture-old-caller-reply" });
  expect(s.acks).toEqual([]);
  const operation = pending.execution.operations.find(o => o.kind === "task_create")!;
  const retries: (string | undefined)[] = [];
  const adapter: core.SprintOrcaAdapter = { ...s.adapter,
    authority: async () => ({ ...await s.adapter.authority("fixture-run"), caller: "fixture-next-pm", coordinator: "fixture-next-pm", consumerGeneration: 2 }),
    inventory: async () => ({ complete: true, tasks: [{ runId: "fixture-run", taskId: "fixture-task", spec: core.sprintOrcaTaskSpec(operation), parentTaskId: null }], workers: [s.host] }),
    reply: async (_run, id, body, retry) => { retries.push(retry); return { questionId: id, body, answerMessageId: "fixture-original-answer", requestId: "fixture-new-caller-reply", status: "answered", source: "Orcaの同じ質問への回答照合", observedAt: at }; },
  };
  const resumed = await core.resumeSprintSession(s.llm, s.sprint.id, { ...s.context, requestKey: "reply引継ぎ" }, adapter, clock);
  expect(resumed.state.session?.generation).toBe(2);
  s.batch("delivery-reply-after-handover", [question]);
  const state = await core.receiveSprintNotifications(s.llm, s.sprint.id, { sessionId: s.context.sessionId, generation: 2 }, adapter, clock);
  expect(retries).toEqual([undefined]);
  expect(state.results[0]?.id).toBe(pending.results[0]?.id);
  expect(state.receptions[0]?.reply?.history).toContainEqual(expect.objectContaining({ caller: "fixture-pm", requestId: "fixture-old-caller-reply", state: "unknown" }));
  expect(s.acks).toEqual(["delivery-reply-after-handover"]);
  expect(state.execution).toMatchObject({ occupied: 1, reserved: 1 });
  s.db.close();
});

test("返信中に監督引継ぎが始まった旧世代の応答は隔離し、現在状態やackを確定しない", async () => {
  const s = await notifications();
  const question = { id: "fixture-late-question", runId: "fixture-run", fromHandle: "dispatch:fixture-dispatch", type: "question", receivedAt: at,
    payload: { taskId: "fixture-task", dispatchId: "fixture-dispatch", question: "確認待ち", options: [] } };
  s.adapter.reply = async (_run, id, body) => {
    core.beginSprintHandover(s.llm, s.sprint.id, { ...s.context, requestKey: "送信中の引継ぎ" });
    return { questionId: id, body, answerMessageId: "fixture-late-answer", requestId: "fixture-late-request", status: "answered", source: "旧監督応答", observedAt: at };
  };
  s.batch("delivery-late-reply", [question]);
  const state = await core.receiveSprintNotifications(s.llm, s.sprint.id, { ...s.context, answers: [{ messageId: question.id, body: "同じ回答" }] }, s.adapter, clock);
  expect(state.receptions[0]?.reply).toMatchObject({ state: "unknown", receipt: null });
  expect(state.receptions[0]?.reply?.history).toContainEqual(expect.objectContaining({ receipt: expect.objectContaining({ answerMessageId: "fixture-late-answer" }) }));
  expect(state.deliveries[0]).toMatchObject({ acknowledged: false, rows: [{ reason: { code: "REPLY_UNKNOWN" } }] });
  expect(state.execution.session?.state).toBe("handover");
  expect(state.execution).toMatchObject({ occupied: 1, reserved: 1 });
  expect(s.acks).toEqual([]);
  s.db.close();
});

test("ack応答が返した次Deliveryも全行処理し、その途中の解析不能行を捨ててackしない", async () => {
  const s = await notifications();
  const next = structuredClone(s.message); next.id = "fixture-ack-next-message"; next.payload.observationId = "fixture-next-collection";
  s.batch("delivery-before-next");
  s.adapter.acknowledge = async (_run, id) => { s.acks.push(id); return { acknowledged: id,
    next: { runId: "fixture-run", deliveryId: "delivery-from-ack", messages: [next, {} as any], count: 2, source: "Orca ack応答の次Delivery", observedAt: at } }; };
  const state = await core.receiveSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock);
  expect(state.results).toHaveLength(2);
  expect(state.deliveries).toHaveLength(2);
  expect(state.deliveries[1]).toMatchObject({ deliveryId: "delivery-from-ack", acknowledged: false, reason: { code: "BATCH_INCOMPLETE" },
    rows: [{ messageId: next.id, reason: null }, { messageId: null, reason: { code: "INVALID_ENVELOPE" } }] });
  expect(s.acks).toEqual(["delivery-before-next"]);
  s.db.close();
});

test("完了通知だけでは解放せず、現在Task・Dispatchのpositive settlementと次所有者が揃ってからackする", async () => {
  const s = await notifications(), releases: string[] = [];
  const done = { id: "fixture-done", runId: "fixture-run", fromHandle: "dispatch:fixture-dispatch", type: "worker_done", receivedAt: at, body: "成果を確認してください",
    payload: { taskId: "fixture-task", dispatchId: "fixture-dispatch", outcome: "succeeded", filesModified: ["src/fixture.ts"], reportPath: "/fixture/report.md" } };
  let positive = false;
  s.adapter.settlement = async () => ({ runId: "fixture-run", taskId: "fixture-task", dispatchId: "fixture-dispatch", activeDispatchId: "fixture-dispatch",
    taskStatus: positive ? "succeeded" : "dispatched", dispatchStatus: positive ? "completed" : "dispatched", outcome: positive ? "succeeded" : null,
    completedAt: positive ? at : null, source: "Orca現在Taskとworker-show", observedAt: at });
  s.adapter.release = async (_run, dispatchId) => { releases.push(dispatchId); return { dispatchId, state: "released", processAction: "closed_agent_terminal", requestId: "fixture-release", source: "Orca worker-release", observedAt: at }; };
  s.batch("delivery-unsettled", [done]);
  const unknown = await core.receiveSprintNotifications(s.llm, s.sprint.id, { ...s.context, ownership: [{ dispatchId: "fixture-dispatch", action: "release" }] }, s.adapter, clock);
  expect(unknown.results[0]).toMatchObject({ kind: "completion", completion: { outcome: "succeeded", state: "unknown" } });
  expect(unknown.deliveries[0]).toMatchObject({ acknowledged: false, rows: [{ reason: { code: "SETTLEMENT_UNKNOWN" } }] });
  expect(releases).toEqual([]); expect(s.acks).toEqual([]);
  positive = true; s.batch("delivery-settled", [{ ...done, id: "fixture-done-relayed" }]);
  const settled = await core.receiveSprintNotifications(s.llm, s.sprint.id, { ...s.context, ownership: [{ dispatchId: "fixture-dispatch", action: "coordinator" }] }, s.adapter, clock);
  expect(settled.results).toHaveLength(1);
  expect(settled.results[0]?.id).toBe(unknown.results[0]?.id);
  expect(settled.results[0]?.completion).toMatchObject({ state: "settled", nextOwner: "fixture-pm", ownership: { state: "assigned" } });
  expect(settled.execution.attempts[0]?.phase).toBe("completed");
  expect(settled.execution).toMatchObject({ occupied: 1, reserved: 1 });
  expect(core.getIssue(s.db, s.issue.id).status).toBe("todo");
  expect(s.acks).toEqual(["delivery-settled"]);
  s.db.close();
});

test("公開Orca adapterは端末liveとTask完了を分け、Taskの現在Dispatchとworker-showの完了を照合する", async () => {
  const s = await notifications(), commands: string[][] = [];
  const adapter = core.createSprintOrcaAdapter(async args => {
    commands.push(args);
    const result = args[1] === "task-list" ? { runId: "fixture-run", tasks: [{ id: "fixture-task", run_id: "fixture-run", status: "succeeded", dispatch_id: "fixture-dispatch" }], count: 1 }
      : { dispatch: { id: "fixture-dispatch", runId: "fixture-run", taskId: "fixture-task", task_id: "fixture-task", status: "completed", completedAt: at },
        worker: { dispatchId: "fixture-dispatch", state: "succeeded" }, projection: { taskId: "fixture-task", dispatchId: "fixture-dispatch", outcome: "succeeded", liveness: { verdict: "live", observedAt: clock.now.getTime(), source: "execution_host" } },
        terminal: { handle: "fixture-terminal", connected: true, incarnationId: "fixture-incarnation", agentIdentity: "codex" }, observation: { status: "live", exactWorker: true, agentWait: null } };
    return { kind: "exited", exitCode: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
  }, { from: "fixture-pm", clock });
  const attempt = core.getSprintExecutionState(s.db, s.sprint.id, clock).attempts[0]!;
  const settlement = await adapter.settlement!(attempt);
  expect(settlement).toMatchObject({ taskStatus: "succeeded", dispatchStatus: "completed", activeDispatchId: "fixture-dispatch", outcome: "succeeded", completedAt: at });
  expect(commands).toContainEqual(["orchestration", "worker-show", "--dispatch", "fixture-dispatch", "--json"]);
  expect(commands).toContainEqual(["orchestration", "task-list", "--run", "fixture-run", "--json"]);
  s.db.close();
});

test("公開Orca adapterは原countより少ない抽出Task行を全件一覧と扱わずsettlementを確定しない", async () => {
  const s = await notifications();
  const adapter = core.createSprintOrcaAdapter(async args => ({ kind: "exited", exitCode: 0, stderr: "", stdout: JSON.stringify({ ok: true,
    result: args[1] === "task-list" ? { runId: "fixture-run", tasks: [{ id: "fixture-task", run_id: "fixture-run", dispatch_id: "fixture-dispatch", status: "succeeded" }], count: 2 }
      : { dispatch: { id: "fixture-dispatch", runId: "fixture-run", taskId: "fixture-task", status: "completed", completedAt: at }, projection: { taskId: "fixture-task", dispatchId: "fixture-dispatch", outcome: "succeeded" } } }) }), { from: "fixture-pm", clock });
  const attempt = core.getSprintExecutionState(s.db, s.sprint.id, clock).attempts[0]!;
  await expect(adapter.settlement!(attempt)).rejects.toMatchObject({ code: "ORCA_OBSERVATION_UNKNOWN" });
  s.db.close();
});

test("positive settlement後の正規解放だけを保存し、解放応答喪失の再配送も同operationとrequestへ合流する", async () => {
  const s = await notifications(), retries: (string | undefined)[] = [];
  const done = { id: "fixture-failed-done", runId: "fixture-run", fromHandle: "dispatch:fixture-dispatch", type: "worker_done", receivedAt: at,
    payload: { taskId: "fixture-task", dispatchId: "fixture-dispatch", outcome: "failed" } };
  s.adapter.settlement = async () => ({ runId: "fixture-run", taskId: "fixture-task", dispatchId: "fixture-dispatch", activeDispatchId: "fixture-dispatch", taskStatus: "failed", dispatchStatus: "completed", outcome: "failed", completedAt: at, source: "Orca settlement", observedAt: at });
  s.adapter.release = async (_run, dispatchId, retry) => {
    retries.push(retry);
    if (retries.length === 1) throw new core.SprintOrcaMutationError("fixture-release-request");
    return { dispatchId, state: "released", processAction: "closed_agent_terminal", requestId: "fixture-release-request", source: "Orca release", observedAt: at };
  };
  const input = { ...s.context, ownership: [{ dispatchId: "fixture-dispatch", action: "release" as const }] };
  s.batch("delivery-release-lost", [done]);
  const unknown = await core.receiveSprintNotifications(s.llm, s.sprint.id, input, s.adapter, clock);
  expect(unknown.results[0]?.completion?.ownership).toMatchObject({ state: "unknown", requestId: "fixture-release-request" });
  expect(s.acks).toEqual([]);
  s.batch("delivery-release-recover", [done]);
  const recovered = await core.receiveSprintNotifications(s.llm, s.sprint.id, input, s.adapter, clock);
  expect(recovered.results[0]?.completion?.ownership).toMatchObject({ state: "released", operationId: unknown.results[0]?.completion?.ownership.operationId,
    receipt: { dispatchId: "fixture-dispatch", state: "released", processAction: "closed_agent_terminal" } });
  s.batch("delivery-release-replay", [{ ...done, id: "fixture-failed-relayed" }]);
  const replayed = await core.receiveSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock);
  expect(replayed.results).toHaveLength(1);
  expect(retries).toEqual([undefined, "fixture-release-request"]);
  expect(s.acks).toEqual(["delivery-release-recover", "delivery-release-replay"]);
  expect(replayed.execution).toMatchObject({ occupied: 1, reserved: 1 });
  expect(core.getIssue(s.db, s.issue.id).status).toBe("todo");
  s.db.close();
});

test("公開Orca adapterの正規解放は同Dispatchのreleased receiptを返し、helpにないrun引数を付けない", async () => {
  const commands: string[][] = [];
  const adapter = core.createSprintOrcaAdapter(async args => { commands.push(args); return { kind: "exited", exitCode: 0, stderr: "", stdout: JSON.stringify({ ok: true,
    result: { dispatchId: "fixture-dispatch", state: "released", processAction: "closed_agent_terminal", mutation: { requestId: "fixture-release-request", replayed: false } } }) }; }, { from: "fixture-pm", clock });
  expect(await adapter.release!("fixture-run", "fixture-dispatch")).toMatchObject({ dispatchId: "fixture-dispatch", state: "released", processAction: "closed_agent_terminal", requestId: "fixture-release-request" });
  expect(commands).toEqual([["orchestration", "worker-release", "--dispatch", "fixture-dispatch", "--json"]]);
});

test("全行batchのheartbeatと通常statusも実送信元を照合して保存し、観測や完了へ読み替えない", async () => {
  const s = await notifications();
  const heartbeat = { id: "fixture-heartbeat", runId: "fixture-run", fromHandle: "dispatch:fixture-dispatch", type: "heartbeat", receivedAt: at,
    payload: { taskId: "fixture-task", dispatchId: "fixture-dispatch", phase: "implementing" } };
  const status = { ...heartbeat, id: "fixture-progress", type: "status", body: "調査中", payload: { taskId: "fixture-task", dispatchId: "fixture-dispatch" } };
  s.batch("delivery-progress", [heartbeat, status]);
  const state = await core.receiveSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock);
  expect(state.results.map(r => r.kind)).toEqual(["notice", "notice"]);
  expect(state.execution.attempts[0]?.observationHistory ?? []).toHaveLength(0);
  expect(state.execution).toMatchObject({ occupied: 1, reserved: 1 });
  expect(s.acks).toEqual(["delivery-progress"]);
  s.db.close();
});

test("自己申告が正しい旧送信元と旧coordinator許可は隔離し、正当な同workerの観測だけを適用する", async () => {
  const s = await notifications();
  const forged = { ...structuredClone(s.message), id: "fixture-forged", fromHandle: "dispatch:fixture-old-worker" };
  const oldCoordinator = { id: "fixture-old-coordinator-result", runId: "fixture-run", fromHandle: "fixture-old-pm", type: "status", receivedAt: at,
    payload: { kind: "nod.sprint.start-authorization", taskId: "fixture-task", dispatchId: "fixture-dispatch", requestId: "fixture-old-request", authorization: { generation: 0, operationId: "fixture-old-operation" } } };
  s.batch("delivery-mixed-authority", [forged, oldCoordinator, s.message]);
  const state = await core.receiveSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock);
  expect(state.results).toHaveLength(1);
  expect(state.quarantined).toHaveLength(2);
  expect(state.quarantined[0]).toMatchObject({ messageId: forged.id, fromHandle: forged.fromHandle, reason: { code: "WORKER_MISMATCH" } });
  expect(state.quarantined[1]).toMatchObject({ messageId: oldCoordinator.id, references: { operationId: "fixture-old-operation", requestId: "fixture-old-request", generation: 0 } });
  expect(state.execution.attempts[0]?.hostObservation?.result).toBe("matched");
  expect(state.execution.nextActions.some(a => a.argv.includes("reconcile"))).toBe(true);
  expect(s.acks).toEqual([]);
  expect(state.execution).toMatchObject({ occupied: 1, reserved: 1 });
  s.db.close();
});

test("受理した完了結果は実行照合や遅れた新観測で開始待ちへ戻らず、開始確認を再発行しない", async () => {
  const s = await notifications();
  const done = { id: "fixture-final-done", runId: "fixture-run", fromHandle: "dispatch:fixture-dispatch", type: "worker_done", receivedAt: at,
    payload: { taskId: "fixture-task", dispatchId: "fixture-dispatch", outcome: "succeeded" } };
  s.adapter.settlement = async () => ({ runId: "fixture-run", taskId: "fixture-task", dispatchId: "fixture-dispatch", activeDispatchId: "fixture-dispatch", taskStatus: "succeeded", dispatchStatus: "completed", outcome: "succeeded", completedAt: at, source: "Orca settlement", observedAt: at });
  s.batch("delivery-final", [done]);
  const completed = await core.receiveSprintNotifications(s.llm, s.sprint.id, { ...s.context, ownership: [{ dispatchId: "fixture-dispatch", action: "coordinator" }] }, s.adapter, clock);
  const operation = completed.execution.operations.find(o => o.kind === "task_create")!;
  s.adapter.inventory = async () => ({ complete: true, tasks: [{ runId: "fixture-run", taskId: "fixture-task", spec: core.sprintOrcaTaskSpec(operation), parentTaskId: null }], workers: [s.host] });
  const reconciled = await core.reconcileSprintExecution(s.llm, s.sprint.id, s.context, s.adapter, clock);
  expect(reconciled.attempts[0]?.phase).toBe("completed");
  s.batch("delivery-late-observation");
  const late = await core.receiveSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock);
  expect(late.results).toHaveLength(1);
  expect(late.execution.attempts[0]?.phase).toBe("completed");
  expect(() => core.prepareSprintStartConfirmation(s.llm, s.sprint.id, { ...s.context, attemptId: s.attempt.id }, clock)).toThrow(expect.objectContaining({ code: "ATTEMPT_COMPLETED" }));
  expect(s.sends).toHaveLength(2);
  s.db.close();
});

test("単独の公開観測受理でも同業務キーの内容違いを保存し、元観測と受理結果を維持する", async () => {
  const s = await notifications(); let message = s.message;
  s.adapter.status = async () => message;
  await core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: message.id }, s.adapter, clock);
  const original = core.getSprintNotificationState(s.db, s.sprint.id, clock);
  message = structuredClone(s.message); message.id = "fixture-single-conflict"; message.payload.metadata.effort = "low";
  await expect(core.receiveSprintHostObservation(s.llm, s.sprint.id, { messageId: message.id }, s.adapter, clock)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  const state = core.getSprintNotificationState(s.db, s.sprint.id, clock);
  expect(state.conflicts).toHaveLength(1);
  expect(state.conflicts[0]).toMatchObject({ existingResultId: original.results[0]?.id, logicalKey: original.results[0]?.logicalKey });
  expect(state.results).toEqual(original.results);
  expect(state.execution.attempts[0]?.observationHistory).toHaveLength(1);
  s.db.close();
});

test("ack送信前の操作と入力hashを保存し、応答喪失で判明したrequest IDを同じ操作へ残す", async () => {
  const s = await notifications(); let before: core.SprintNotificationDelivery | undefined;
  s.batch("fixture-audited-delivery");
  s.adapter.acknowledge = async () => {
    before = core.getSprintNotificationState(s.db, s.sprint.id, clock).deliveries[0];
    throw new core.SprintOrcaMutationError("fixture-known-ack-request");
  };
  const state = await core.receiveSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock);
  expect(before?.ackOperation).toMatchObject({ operationId: expect.any(String), inputHash: expect.stringMatching(/^[a-f0-9]{64}$/), generation: 1,
    target: { runId: "fixture-run", deliveryId: "fixture-audited-delivery" }, state: "sending", requestId: null });
  expect(state.deliveries[0]?.ackOperation).toMatchObject({ operationId: before?.ackOperation?.operationId, state: "unknown", requestId: "fixture-known-ack-request" });
  expect(state.results).toHaveLength(1);
  s.db.close();
});

test("公開OrcaRunnerのack成功JSONからrequestとreceiptを元ack操作へ保存する", async () => {
  const s = await notifications(); s.batch("fixture-ack-success");
  const adapter = core.createSprintOrcaAdapter(async () => ({ kind: "exited", exitCode: 0, stderr: "", stdout: JSON.stringify({ ok: true,
    result: { runId: "fixture-run", deliveryId: null, messages: [], count: 0, acknowledged: "fixture-ack-success", mutation: { requestId: "fixture-success-request", replayed: false } } }) }), { from: "fixture-pm", clock });
  s.adapter.acknowledge = adapter.acknowledge;
  const state = await core.receiveSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock);
  expect(state.deliveries[0]?.ackOperation).toMatchObject({ state: "confirmed", requestId: "fixture-success-request",
    receipt: { acknowledged: "fixture-ack-success", requestId: "fixture-success-request", observedAt: at, source: expect.any(String) } });
  s.db.close();
});

test("返信も送信前に対象と入力hashと監督世代を操作IDへ結び付ける", async () => {
  const s = await notifications(); let before: core.SprintNotificationReception["reply"];
  const question = { id: "fixture-audited-question", runId: "fixture-run", fromHandle: "dispatch:fixture-dispatch", type: "question", receivedAt: at,
    payload: { taskId: "fixture-task", dispatchId: "fixture-dispatch", question: "確認先", options: [] } };
  s.adapter.reply = async (_run, id, body) => { before = core.getSprintNotificationState(s.db, s.sprint.id, clock).receptions[0]?.reply;
    return { questionId: id, body, status: "answered", answerMessageId: "fixture-audit-answer", requestId: "fixture-audit-reply-request", source: "Orca reply", observedAt: at }; };
  s.batch("fixture-reply-audit", [question]);
  const state = await core.receiveSprintNotifications(s.llm, s.sprint.id, { ...s.context, answers: [{ messageId: question.id, body: "同じ成果" }] }, s.adapter, clock);
  expect(before).toMatchObject({ operationId: expect.any(String), inputHash: expect.stringMatching(/^[a-f0-9]{64}$/), state: "sending", generation: 1,
    target: { runId: "fixture-run", messageId: question.id }, sessionId: s.context.sessionId, runtimeId: "fixture-home" });
  expect(state.receptions[0]?.reply).toMatchObject({ operationId: before?.operationId, inputHash: before?.inputHash, state: "confirmed", requestId: "fixture-audit-reply-request" });
  s.db.close();
});

test("解放が未確定またはretainedでも次所有者へ変更するときに元operationとrequestとreceiptを失わない", async () => {
  for (const retained of [false, true]) {
    const s = await notifications();
    const done = { id: "fixture-owner-change", runId: "fixture-run", fromHandle: "dispatch:fixture-dispatch", type: "worker_done", receivedAt: at,
      payload: { taskId: "fixture-task", dispatchId: "fixture-dispatch", outcome: "succeeded" } };
    s.adapter.settlement = async () => ({ runId: "fixture-run", taskId: "fixture-task", dispatchId: "fixture-dispatch", activeDispatchId: "fixture-dispatch", taskStatus: "succeeded", dispatchStatus: "completed", outcome: "succeeded", completedAt: at, source: "Orca settlement", observedAt: at });
    s.adapter.release = async (_run, dispatchId) => {
      if (!retained) throw new core.SprintOrcaMutationError("fixture-unresolved-release");
      return { dispatchId, state: "retained", processAction: "external_terminal", requestId: "fixture-unresolved-release", source: "Orca release retained", observedAt: at };
    };
    s.batch("fixture-before-owner", [done]);
    const pending = await core.receiveSprintNotifications(s.llm, s.sprint.id, { ...s.context, ownership: [{ dispatchId: "fixture-dispatch", action: "release" }] }, s.adapter, clock);
    const original = pending.results[0]!.completion!.ownership;
    expect(original).toMatchObject({ state: "unknown", operationId: expect.any(String), requestId: "fixture-unresolved-release" });
    s.batch("fixture-after-owner", [done]);
    const state = await core.receiveSprintNotifications(s.llm, s.sprint.id, { ...s.context, ownership: [{ dispatchId: "fixture-dispatch", action: "coordinator" }] }, s.adapter, clock);
    expect(state.results[0]?.completion).toMatchObject({ nextOwner: "fixture-pm", ownership: { state: "assigned", operationId: original.operationId,
      requestId: original.requestId, receipt: original.receipt, history: original.history } });
    expect(state.results[0]?.completion?.releaseOperation).toMatchObject({ operationId: original.operationId, requestId: "fixture-unresolved-release", state: "unknown",
      inputHash: expect.stringMatching(/^[a-f0-9]{64}$/), generation: 1, target: { runId: "fixture-run", dispatchId: "fixture-dispatch" }, receipt: original.receipt });
    expect(s.acks).toEqual(["fixture-after-owner"]);
    expect(state.execution).toMatchObject({ occupied: 1, reserved: 1 });
    s.db.close();
  }
});

test("同世代の並行receiveは応答順が逆でも送信中の同じ解放operationへ合流する", async () => {
  const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
  for (const leader of [0, 1]) {
    const s = await notifications();
    const done = { id: "fixture-concurrent-done", runId: "fixture-run", fromHandle: "dispatch:fixture-dispatch", type: "worker_done", receivedAt: at,
      payload: { taskId: "fixture-task", dispatchId: "fixture-dispatch", outcome: "succeeded" } };
    const settlement = { runId: "fixture-run", taskId: "fixture-task", dispatchId: "fixture-dispatch", activeDispatchId: "fixture-dispatch", taskStatus: "succeeded", dispatchStatus: "completed", outcome: "succeeded" as const, completedAt: at, source: "Orca settlement", observedAt: at };
    const slots = [deferred<core.SprintOrcaSettlement>(), deferred<core.SprintOrcaSettlement>()], entered = [deferred<void>(), deferred<void>()], sent = deferred<void>(), finish = deferred<void>();
    const adapters = slots.map((slot, index) => ({ ...s.adapter, settlement: async () => { entered[index]!.resolve(); return slot.promise; } }));
    const operations: string[] = [], retries: (string | undefined)[] = [];
    s.adapter.release = async (_run, dispatchId, retry) => {
      operations.push(core.getSprintNotificationState(s.db, s.sprint.id, clock).results[0]!.completion!.releaseOperation!.operationId); retries.push(retry);
      if (operations.length === 1) { sent.resolve(); await finish.promise; return { dispatchId, state: "released", processAction: "closed_agent_terminal", requestId: "fixture-concurrent-original-request", source: "Orca release", observedAt: at }; }
      throw new core.SprintOrcaMutationError("fixture-concurrent-duplicate-request");
    };
    s.batch("fixture-concurrent-delivery", [done]);
    const input = { ...s.context, ownership: [{ dispatchId: "fixture-dispatch", action: "release" as const }] };
    for (const adapter of adapters) adapter.release = s.adapter.release;
    const requests = adapters.map(adapter => core.receiveSprintNotifications(s.llm, s.sprint.id, input, adapter, clock));
    await Promise.all(entered.map(e => e.promise)); slots[leader]!.resolve(settlement); await sent.promise; slots[1 - leader]!.resolve(settlement);
    const follower = await requests[1 - leader]!;
    finish.resolve(); await requests[leader]!;
    const state = core.getSprintNotificationState(s.db, s.sprint.id, clock);
    expect(operations).toHaveLength(1);
    expect(retries).toEqual([undefined]);
    expect(follower.results[0]?.completion?.releaseOperation).toMatchObject({ operationId: operations[0], state: "sending" });
    expect(state.results[0]?.completion?.releaseOperation).toMatchObject({ operationId: operations[0], state: "confirmed", requestId: "fixture-concurrent-original-request" });
    expect(state.results[0]?.completion?.ownership.state).toBe("released");
    expect(s.acks).toEqual(["fixture-concurrent-delivery"]);
    expect(state.execution).toMatchObject({ occupied: 1, reserved: 1 });
    s.db.close();
  }
});

test("解放応答待ちの次所有者変更を遅い同世代応答で上書きせず、元操作と確定ackを保つ", async () => {
  for (const released of [false, true]) {
    const s = await notifications(); let sent!: () => void, finish!: () => void;
    const sentPromise = new Promise<void>(r => { sent = r; }), finishPromise = new Promise<void>(r => { finish = r; });
    const done = { id: "fixture-late-release-done", runId: "fixture-run", fromHandle: "dispatch:fixture-dispatch", type: "worker_done", receivedAt: at,
      payload: { taskId: "fixture-task", dispatchId: "fixture-dispatch", outcome: "succeeded" } };
    s.adapter.settlement = async () => ({ runId: "fixture-run", taskId: "fixture-task", dispatchId: "fixture-dispatch", activeDispatchId: "fixture-dispatch", taskStatus: "succeeded", dispatchStatus: "completed", outcome: "succeeded", completedAt: at, source: "Orca settlement", observedAt: at });
    s.adapter.release = async (_run, dispatchId) => { sent(); await finishPromise; return { dispatchId, state: released ? "released" : "retained", processAction: released ? "closed_agent_terminal" : "external_terminal", requestId: "fixture-late-release-request", source: "Orca release", observedAt: at }; };
    s.batch("fixture-late-release-delivery", [done]);
    const pending = core.receiveSprintNotifications(s.llm, s.sprint.id, { ...s.context, ownership: [{ dispatchId: "fixture-dispatch", action: "release" }] }, s.adapter, clock);
    await sentPromise;
    const operation = core.getSprintNotificationState(s.db, s.sprint.id, clock).results[0]!.completion!.releaseOperation!;
    const assigned = await core.receiveSprintNotifications(s.llm, s.sprint.id, { ...s.context, ownership: [{ dispatchId: "fixture-dispatch", action: "coordinator" }] }, s.adapter, clock);
    expect(assigned.results[0]?.completion).toMatchObject({ nextOwner: "fixture-pm", ownership: { state: "assigned" }, releaseOperation: { operationId: operation.operationId, state: "sending" } });
    finish(); await pending;
    const state = core.getSprintNotificationState(s.db, s.sprint.id, clock);
    expect(state.results[0]?.completion).toMatchObject({ nextOwner: "fixture-pm", ownership: { state: "assigned" },
      releaseOperation: { operationId: operation.operationId, requestId: "fixture-late-release-request", state: released ? "confirmed" : "unknown", receipt: { state: released ? "released" : "retained" } } });
    expect(state.deliveries[0]).toMatchObject({ acknowledged: true, ackOperation: { state: "confirmed" } });
    expect(s.acks).toEqual(["fixture-late-release-delivery"]);
    expect(state.execution).toMatchObject({ occupied: 1, reserved: 1 });
    s.db.close();
  }
});

test("アプリ応答を失ったsendingの既知release requestをcompleted証拠へ合流し追加送信しない", async () => {
  const s = await notifications(); let entered!: () => void, finish!: () => void;
  const enteredPromise = new Promise<void>(r => { entered = r; }), finishPromise = new Promise<void>(r => { finish = r; });
  const done = { id: "fixture-resume-done", runId: "fixture-run", fromHandle: "dispatch:fixture-dispatch", type: "worker_done", receivedAt: at,
    payload: { taskId: "fixture-task", dispatchId: "fixture-dispatch", outcome: "succeeded" } };
  s.adapter.settlement = async () => ({ runId: "fixture-run", taskId: "fixture-task", dispatchId: "fixture-dispatch", activeDispatchId: "fixture-dispatch", taskStatus: "succeeded", dispatchStatus: "completed", outcome: "succeeded", completedAt: at, source: "Orca settlement", observedAt: at });
  let sends = 0; const lookups: string[] = [];
  s.adapter.release = async () => { sends++; if (sends === 2) { entered(); await finishPromise; } throw new core.SprintOrcaMutationError("fixture-resume-request"); };
  const input = { ...s.context, ownership: [{ dispatchId: "fixture-dispatch", action: "release" as const }] };
  s.batch("fixture-resume-delivery", [done]);
  const first = await core.receiveSprintNotifications(s.llm, s.sprint.id, input, s.adapter, clock);
  const operation = first.results[0]!.completion!.releaseOperation!;
  const interrupted = core.receiveSprintNotifications(s.llm, s.sprint.id, input, s.adapter, clock); await enteredPromise;
  s.adapter.notificationRequest = async requestId => { lookups.push(requestId); return { requestId, state: "completed", method: "orchestration.workerRelease", runtimeId: "fixture-home", source: "Orca request-show", observedAt: at,
    release: { dispatchId: "fixture-dispatch", state: "released", processAction: "closed_agent_terminal", requestId, source: "Orca保存receipt", observedAt: at } }; };
  const resumed = await core.receiveSprintNotifications(s.llm, s.sprint.id, input, s.adapter, clock);
  finish(); await interrupted;
  expect(resumed.results[0]?.completion?.releaseOperation).toMatchObject({ operationId: operation.operationId, inputHash: operation.inputHash, requestId: "fixture-resume-request", state: "confirmed" });
  expect(core.getSprintNotificationState(s.db, s.sprint.id, clock).results[0]?.completion?.releaseOperation?.state).toBe("confirmed");
  expect(lookups).toEqual(["fixture-resume-request"]); expect(sends).toBe(2);
  expect(s.acks).toEqual(["fixture-resume-delivery"]);
  expect(resumed.execution).toMatchObject({ occupied: 1, reserved: 1 });
  s.db.close();
});

test("公開Orca adapterのrequest-showは同release methodと保存receiptだけを投影する", async () => {
  const commands: string[][] = [];
  const adapter = core.createSprintOrcaAdapter(async args => { commands.push(args); return { kind: "exited", exitCode: 0, stderr: "", stdout: JSON.stringify({ ok: true,
    result: { requestId: "fixture-completed-request", state: "completed", method: "orchestration.workerRelease", receipt: { dispatchId: "fixture-dispatch", state: "released", processAction: "closed_agent_terminal",
      mutation: { requestId: "fixture-completed-request", replayed: false }, archive: { transcript: "synthetic-private-content" }, remoteOutput: "synthetic-private-content" } }, _meta: { runtimeId: "fixture-home" } }) }; }, { from: "fixture-pm", clock });
  const observation = await adapter.notificationRequest!("fixture-completed-request");
  expect(observation).toMatchObject({ requestId: "fixture-completed-request", state: "completed", method: "orchestration.workerRelease", runtimeId: "fixture-home",
    release: { requestId: "fixture-completed-request", dispatchId: "fixture-dispatch", state: "released", processAction: "closed_agent_terminal" } });
  expect(JSON.stringify(observation)).not.toContain("synthetic-private-content");
  expect(commands).toEqual([["orchestration", "request-show", "--request", "fixture-completed-request", "--json"]]);
});

test("sendingの返信も保存された同requestのcompletedへ合流し、遅い応答で確定を失わない", async () => {
  const s = await notifications(); let entered!: () => void, finish!: () => void;
  const enteredPromise = new Promise<void>(r => { entered = r; }), finishPromise = new Promise<void>(r => { finish = r; });
  const question = { id: "fixture-resume-question", runId: "fixture-run", fromHandle: "dispatch:fixture-dispatch", type: "question", receivedAt: at,
    payload: { taskId: "fixture-task", dispatchId: "fixture-dispatch", question: "確認先", options: [] } };
  let sends = 0;
  s.adapter.reply = async () => { sends++; if (sends === 2) { entered(); await finishPromise; } throw new core.SprintOrcaMutationError("fixture-resume-reply-request"); };
  s.batch("fixture-resume-reply-delivery", [question]);
  const input = { ...s.context, answers: [{ messageId: question.id, body: "同じ保存回答" }] };
  const first = await core.receiveSprintNotifications(s.llm, s.sprint.id, input, s.adapter, clock), operation = first.receptions[0]!.reply!;
  const interrupted = core.receiveSprintNotifications(s.llm, s.sprint.id, input, s.adapter, clock); await enteredPromise;
  s.adapter.notificationRequest = async requestId => ({ requestId, state: "completed", method: "orchestration.reply", runtimeId: "fixture-home", source: "Orca request-show", observedAt: at,
    reply: { runId: "fixture-run", dispatchId: "fixture-dispatch", questionId: question.id, answerMessageId: "fixture-persisted-answer", body: "同じ保存回答", requestId, status: "answered", source: "Orca保存reply", observedAt: at } });
  const resumed = await core.receiveSprintNotifications(s.llm, s.sprint.id, input, s.adapter, clock);
  finish(); await interrupted;
  expect(resumed.receptions[0]?.reply).toMatchObject({ operationId: operation.operationId, inputHash: operation.inputHash, requestId: "fixture-resume-reply-request", state: "confirmed", receipt: { answerMessageId: "fixture-persisted-answer" } });
  expect(core.getSprintNotificationState(s.db, s.sprint.id, clock).receptions[0]?.reply?.state).toBe("confirmed");
  expect(sends).toBe(2); expect(s.acks).toEqual(["fixture-resume-reply-delivery"]);
  s.db.close();
});

test("公開request-showの返信receiptはRunと質問・Dispatch・回答messageの対応を保つ", async () => {
  const receipt = { message: { id: "fixture-answer", run_id: "fixture-run", to_handle: "dispatch:fixture-dispatch", thread_id: "fixture-question", body: "回答" },
    question: { message_id: "fixture-question", run_id: "fixture-run", dispatch_id: "fixture-dispatch", asker_handle: "dispatch:fixture-dispatch", status: "answered", answer_message_id: "fixture-answer", answer_body: "回答" },
    duplicate: false, mutation: { requestId: "fixture-reply-request", replayed: false } };
  const adapter = core.createSprintOrcaAdapter(async () => ({ kind: "exited", exitCode: 0, stderr: "", stdout: JSON.stringify({ ok: true,
    result: { requestId: "fixture-reply-request", state: "completed", method: "orchestration.reply", receipt }, _meta: { runtimeId: "fixture-home" } }) }), { from: "fixture-pm", clock });
  expect((await adapter.notificationRequest!("fixture-reply-request")).reply).toMatchObject({ runId: "fixture-run", dispatchId: "fixture-dispatch", questionId: "fixture-question", answerMessageId: "fixture-answer", body: "回答", requestId: "fixture-reply-request" });
  receipt.message.to_handle = "dispatch:fixture-other";
  expect((await adapter.notificationRequest!("fixture-reply-request")).reply).toBeUndefined();
});

test("sendingの旧Delivery ackをcompletedへ合流し現在Deliveryだけを追加ackする", async () => {
  const s = await notifications(); let entered!: () => void, finish!: () => void;
  const enteredPromise = new Promise<void>(r => { entered = r; }), finishPromise = new Promise<void>(r => { finish = r; });
  let calls = 0; const sent: string[] = [], retries: (string | undefined)[] = [];
  s.adapter.acknowledge = async (_run, id, retry) => {
    calls++; sent.push(id); retries.push(retry);
    if (calls === 2) { entered(); await finishPromise; }
    if (id === "fixture-old-delivery") throw new core.SprintOrcaMutationError("fixture-old-ack-request");
    return { acknowledged: id, next: null, requestId: "fixture-current-ack-request", source: "Orca ack", observedAt: at };
  };
  s.batch("fixture-old-delivery");
  const first = await core.receiveSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock), operation = first.deliveries[0]!.ackOperation!;
  const interrupted = core.receiveSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock); await enteredPromise;
  s.adapter.notificationRequest = async requestId => ({ requestId, state: "completed", method: "orchestration.check", runtimeId: "fixture-home", source: "Orca request-show", observedAt: at,
    ack: { runId: "fixture-run", acknowledged: "fixture-old-delivery", requestId, source: "Orca保存ack", observedAt: at, nextDeliveryId: null, nextCount: 0 } });
  s.batch("fixture-current-delivery");
  const resumed = await core.receiveSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock);
  finish(); await interrupted;
  const persisted = core.getSprintNotificationState(s.db, s.sprint.id, clock);
  expect(persisted.deliveries.find(d => d.deliveryId === "fixture-old-delivery")).toMatchObject({ acknowledged: true,
    ackOperation: { operationId: operation.operationId, inputHash: operation.inputHash, requestId: "fixture-old-ack-request", state: "confirmed" } });
  expect(sent).toEqual(["fixture-old-delivery", "fixture-old-delivery", "fixture-current-delivery"]);
  expect(retries).toEqual([undefined, "fixture-old-ack-request", undefined]);
  expect(resumed.results).toHaveLength(1); expect(resumed.execution).toMatchObject({ occupied: 1, reserved: 1 });
  s.db.close();
});

test("公開ack adapterは同callerの既知requestをretry-requestで再送する", async () => {
  const commands: string[][] = [];
  const adapter = core.createSprintOrcaAdapter(async args => { commands.push(args); return { kind: "exited", exitCode: 0, stderr: "", stdout: JSON.stringify({ ok: true,
    result: { runId: "fixture-run", deliveryId: null, messages: [], count: 0, acknowledged: "fixture-old", mutation: { requestId: "fixture-ack-request", replayed: true } } }) }; }, { from: "fixture-pm", clock });
  await adapter.acknowledge!("fixture-run", "fixture-old", "fixture-ack-request");
  expect(commands).toEqual([["orchestration", "check", "--terminal", "fixture-pm", "--run", "fixture-run", "--ack", "fixture-old", "--retry-request", "fixture-ack-request", "--json"]]);
});

test("公開request-showのack receiptは元Deliveryと次Deliveryを分けて投影する", async () => {
  const receipt = { runId: "fixture-run", deliveryId: "fixture-next", messages: [{ id: "fixture-next-message", body: "synthetic-content" }], count: 1,
    acknowledged: "fixture-old", timedOut: false, cancelled: false, connectionLost: false, mutation: { requestId: "fixture-ack-request", replayed: false } };
  const adapter = core.createSprintOrcaAdapter(async () => ({ kind: "exited", exitCode: 0, stderr: "", stdout: JSON.stringify({ ok: true,
    result: { requestId: "fixture-ack-request", state: "completed", method: "orchestration.check", receipt }, _meta: { runtimeId: "fixture-home" } }) }), { from: "fixture-pm", clock });
  const observation = await adapter.notificationRequest!("fixture-ack-request");
  expect(observation.ack).toMatchObject({ runId: "fixture-run", acknowledged: "fixture-old", requestId: "fixture-ack-request", nextDeliveryId: "fixture-next", nextCount: 1 });
  expect(JSON.stringify(observation)).not.toContain("synthetic-content");
  receipt.count = 2;
  expect((await adapter.notificationRequest!("fixture-ack-request")).ack).toBeUndefined();
});

test("保存requestがpending・absent・欠測や異なる証拠なら三操作ともsendingと所有を保持する", async () => {
  for (const kind of ["release", "reply", "ack"] as const) {
    const s = await notifications(); let entered!: () => void, finish!: () => void, sends = 0;
    const enteredPromise = new Promise<void>(r => { entered = r; }), finishPromise = new Promise<void>(r => { finish = r; });
    const requestId = `fixture-pending-${kind}`, method = kind === "release" ? "orchestration.workerRelease" : kind === "reply" ? "orchestration.reply" : "orchestration.check";
    const effect = async () => { sends++; if (sends === 2) { entered(); await finishPromise; } throw new core.SprintOrcaMutationError(requestId); };
    const message = kind === "release" ? { id: "fixture-pending-done", runId: "fixture-run", fromHandle: "dispatch:fixture-dispatch", type: "worker_done", receivedAt: at,
      payload: { taskId: "fixture-task", dispatchId: "fixture-dispatch", outcome: "succeeded" } }
      : kind === "reply" ? { id: "fixture-pending-question", runId: "fixture-run", fromHandle: "dispatch:fixture-dispatch", type: "question", receivedAt: at,
        payload: { taskId: "fixture-task", dispatchId: "fixture-dispatch", question: "確認先", options: [] } } : s.message;
    const input = { ...s.context, ...(kind === "release" ? { ownership: [{ dispatchId: "fixture-dispatch", action: "release" as const }] }
      : kind === "reply" ? { answers: [{ messageId: message.id, body: "保存回答" }] } : {}) };
    s.adapter.settlement = async () => ({ runId: "fixture-run", taskId: "fixture-task", dispatchId: "fixture-dispatch", activeDispatchId: "fixture-dispatch", taskStatus: "succeeded", dispatchStatus: "completed", outcome: "succeeded", completedAt: at, source: "Orca settlement", observedAt: at });
    if (kind === "release") s.adapter.release = effect;
    if (kind === "reply") s.adapter.reply = effect;
    if (kind === "ack") s.adapter.acknowledge = effect;
    s.batch("fixture-pending-delivery", [message]);
    await core.receiveSprintNotifications(s.llm, s.sprint.id, input, s.adapter, clock);
    const interrupted = core.receiveSprintNotifications(s.llm, s.sprint.id, input, s.adapter, clock); await enteredPromise;
    const valid: core.SprintNotificationRequestObservation = { requestId, state: "completed", method, runtimeId: "fixture-home", source: "Orca request-show", observedAt: at,
      release: { dispatchId: "fixture-dispatch", state: "released", processAction: "closed_agent_terminal", requestId, source: "保存release", observedAt: at },
      reply: { runId: "fixture-run", dispatchId: "fixture-dispatch", questionId: message.id, answerMessageId: "fixture-answer", body: "保存回答", status: "answered", requestId, source: "保存reply", observedAt: at },
      ack: { runId: "fixture-run", acknowledged: "fixture-pending-delivery", requestId, source: "保存ack", observedAt: at, nextDeliveryId: null, nextCount: 0 } };
    const wrongTarget = structuredClone(valid);
    if (kind === "release") wrongTarget.release!.dispatchId = "fixture-other";
    if (kind === "reply") wrongTarget.reply!.dispatchId = "fixture-other";
    if (kind === "ack") wrongTarget.ack!.acknowledged = "fixture-other";
    for (const proof of [{ ...valid, state: "pending" as const }, { ...valid, state: "absent" as const }, { ...valid, method: "orchestration.other" },
      { ...valid, requestId: "fixture-other" }, { ...valid, runtimeId: "fixture-other" }, { ...valid, observedAt: "2000-01-01T00:00:00Z" }, wrongTarget, null]) {
      s.adapter.notificationRequest = async () => { if (!proof) throw Error("synthetic lookup failure"); return proof; };
      const state = await core.reconcileSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock);
      const operation = kind === "release" ? state.results[0]!.completion!.releaseOperation! : kind === "reply" ? state.receptions[0]!.reply! : state.deliveries[0]!.ackOperation!;
      expect(operation).toMatchObject({ state: "sending", requestId });
      expect(state.execution).toMatchObject({ occupied: 1, reserved: 1 });
      expect(sends).toBe(2); expect(s.acks).toEqual([]);
    }
    let foreignLookups = 0;
    const taskOperation = core.getSprintExecutionState(s.db, s.sprint.id, clock).operations.find(o => o.kind === "task_create")!;
    const successor: core.SprintOrcaAdapter = { ...s.adapter,
      authority: async () => ({ ...await s.adapter.authority("fixture-run"), caller: "fixture-successor", coordinator: "fixture-successor", consumerGeneration: 2 }),
      inventory: async () => ({ complete: true, tasks: [{ runId: "fixture-run", taskId: "fixture-task", spec: core.sprintOrcaTaskSpec(taskOperation), parentTaskId: null }], workers: [s.host] }),
      notificationRequest: async () => { foreignLookups++; return { ...valid, state: "absent" }; } };
    await core.resumeSprintSession(s.llm, s.sprint.id, { ...s.context, requestKey: `引継ぎ-${kind}` }, successor, clock);
    const inherited = await core.reconcileSprintNotifications(s.llm, s.sprint.id, { ...s.context, generation: 2 }, successor, clock);
    expect(foreignLookups).toBe(0); expect(sends).toBe(2);
    expect(inherited.execution).toMatchObject({ occupied: 1, reserved: 1 });
    finish(); await interrupted; s.db.close();
  }
});

test("遅れて成功した返信とackもrequest-showで確定した元証拠を上書きしない", async () => {
  for (const kind of ["reply", "ack"] as const) {
    const s = await notifications(); let entered!: () => void, finish!: () => void, sends = 0;
    const enteredPromise = new Promise<void>(r => { entered = r; }), finishPromise = new Promise<void>(r => { finish = r; });
    const requestId = `fixture-late-success-${kind}`;
    const message = kind === "reply" ? { id: "fixture-late-question", runId: "fixture-run", fromHandle: "dispatch:fixture-dispatch", type: "question", receivedAt: at,
      payload: { taskId: "fixture-task", dispatchId: "fixture-dispatch", question: "確認先", options: [] } } : s.message;
    const reply = { runId: "fixture-run", dispatchId: "fixture-dispatch", questionId: message.id, answerMessageId: "fixture-late-answer", body: "保存回答", status: "answered" as const, requestId, source: "保存reply", observedAt: at };
    const ack = { runId: "fixture-run", acknowledged: "fixture-late-delivery", requestId, source: "保存ack", observedAt: at, nextDeliveryId: null, nextCount: 0 };
    const effect = async () => { sends++; if (sends === 1) throw new core.SprintOrcaMutationError(requestId); entered(); await finishPromise; };
    if (kind === "reply") s.adapter.reply = async () => { await effect(); return reply; };
    else s.adapter.acknowledge = async () => { await effect(); return { ...ack, next: null }; };
    const input = { ...s.context, ...(kind === "reply" ? { answers: [{ messageId: message.id, body: "保存回答" }] } : {}) };
    s.batch("fixture-late-delivery", [message]);
    await core.receiveSprintNotifications(s.llm, s.sprint.id, input, s.adapter, clock);
    const interrupted = core.receiveSprintNotifications(s.llm, s.sprint.id, input, s.adapter, clock); await enteredPromise;
    s.adapter.notificationRequest = async () => ({ requestId, state: "completed", method: kind === "reply" ? "orchestration.reply" : "orchestration.check", runtimeId: "fixture-home", source: "Orca request-show", observedAt: at, reply, ack });
    await core.reconcileSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock);
    finish(); await interrupted;
    const state = core.getSprintNotificationState(s.db, s.sprint.id, clock);
    const saved = kind === "reply" ? state.receptions[0]!.reply! : state.deliveries[0]!.ackOperation!;
    expect(saved).toMatchObject({ state: "confirmed", requestId, reconciliation: { source: "Orca request-show", requestId } });
    expect(sends).toBe(2); s.db.close();
  }
});

test("completedでretainedの解放receiptも元操作へ保存し、次ownerと必要ackを物理解放から分ける", async () => {
  for (const selected of ["pending", "assigned", "settlement-unknown"]) {
    const s = await notifications(); let entered!: () => void, finish!: () => void, sends = 0;
    const enteredPromise = new Promise<void>(r => { entered = r; }), finishPromise = new Promise<void>(r => { finish = r; });
    const done = { id: "fixture-retained-done", runId: "fixture-run", fromHandle: "dispatch:fixture-dispatch", type: "worker_done", receivedAt: at,
      payload: { taskId: "fixture-task", dispatchId: "fixture-dispatch", outcome: "succeeded" } };
    s.adapter.settlement = async () => ({ runId: "fixture-run", taskId: "fixture-task", dispatchId: "fixture-dispatch", activeDispatchId: "fixture-dispatch", taskStatus: "succeeded", dispatchStatus: "completed", outcome: "succeeded", completedAt: at, source: "Orca settlement", observedAt: at });
    s.adapter.release = async () => { sends++; if (sends === 2) { entered(); await finishPromise; } throw new core.SprintOrcaMutationError("fixture-retained-request"); };
    s.batch("fixture-retained-delivery", [done]);
    const input = { ...s.context, ownership: [{ dispatchId: "fixture-dispatch", action: "release" as const }] };
    const first = await core.receiveSprintNotifications(s.llm, s.sprint.id, input, s.adapter, clock), operation = first.results[0]!.completion!.releaseOperation!;
    const interrupted = core.receiveSprintNotifications(s.llm, s.sprint.id, input, s.adapter, clock); await enteredPromise;
    const inherit = { ...s.context, ownership: [{ dispatchId: "fixture-dispatch", action: "coordinator" as const }] };
    if (selected === "assigned") await core.receiveSprintNotifications(s.llm, s.sprint.id, inherit, s.adapter, clock);
    if (selected === "settlement-unknown") s.adapter.settlement = async () => { throw Error("synthetic unavailable"); };
    s.adapter.notificationRequest = async requestId => ({ requestId, state: "completed", method: "orchestration.workerRelease", runtimeId: "fixture-home", source: "Orca request-show", observedAt: at,
      release: { dispatchId: "fixture-dispatch", state: "retained", reason: "external_terminal", processAction: "none", requestId, source: "Orca保存retained", observedAt: at } });
    const reconciled = await core.reconcileSprintNotifications(s.llm, s.sprint.id, s.context, s.adapter, clock);
    finish(); await interrupted;
    const completion = core.getSprintNotificationState(s.db, s.sprint.id, clock).results[0]!.completion!;
    expect(completion.releaseOperation).toMatchObject({ operationId: operation.operationId, inputHash: operation.inputHash, requestId: "fixture-retained-request", state: "unknown",
      receipt: { state: "retained", reason: "external_terminal", processAction: "none" }, reconciliation: { state: "completed", source: "Orca request-show" } });
    expect(completion.ownership.state).toBe(selected === "assigned" ? "assigned" : "unknown");
    expect(completion.ownership.receipt).toMatchObject({ state: "retained", reason: "external_terminal", processAction: "none", requestId: "fixture-retained-request" });
    expect(completion.nextOwner).toBe(selected === "assigned" ? "fixture-pm" : null);
    expect(reconciled.execution).toMatchObject({ occupied: 1, reserved: 1 });
    if (selected === "pending") {
      const retained = await core.receiveSprintNotifications(s.llm, s.sprint.id, input, s.adapter, clock);
      expect(retained.deliveries[0]?.rows[0]?.reason?.code).toBe("RELEASE_RETAINED"); expect(s.acks).toEqual([]);
      await core.receiveSprintNotifications(s.llm, s.sprint.id, inherit, s.adapter, clock);
    }
    expect(sends).toBe(2); expect(s.acks).toEqual(selected === "settlement-unknown" ? [] : ["fixture-retained-delivery"]);
    s.db.close();
  }
});

test("公開Orca adapterはcompleted retainedのreasonと非closing receiptを欠測と区別して保つ", async () => {
  const receipt: { dispatchId: string; state: string; processAction: string; reason?: string | null; mutation: { requestId: string; replayed: boolean } } = {
    dispatchId: "fixture-retained-dispatch", state: "retained", reason: "external_terminal", processAction: "none", mutation: { requestId: "fixture-retained-request", replayed: false } };
  const adapter = core.createSprintOrcaAdapter(async args => ({ kind: "exited", exitCode: 0, stderr: "", stdout: JSON.stringify({ ok: true,
    result: args[1] === "request-show" ? { requestId: "fixture-retained-request", state: "completed", method: "orchestration.workerRelease", receipt } : receipt,
    _meta: { runtimeId: "fixture-home" } }) }), { from: "fixture-pm", clock });
  expect((await adapter.notificationRequest!("fixture-retained-request")).release).toMatchObject({ state: "retained", reason: "external_terminal", processAction: "none", requestId: "fixture-retained-request" });
  expect(await adapter.release!("fixture-run", "fixture-retained-dispatch")).toMatchObject({ state: "retained", reason: "external_terminal", processAction: "none" });
  receipt.reason = null;
  expect((await adapter.notificationRequest!("fixture-retained-request")).release).toHaveProperty("reason", null);
  delete receipt.reason;
  expect((await adapter.notificationRequest!("fixture-retained-request")).release).not.toHaveProperty("reason");
});
