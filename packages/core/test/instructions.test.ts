import { describe, expect, test } from "bun:test";
import { completeIssue, startIssue } from "../src/ops/agent";
import { rejectReview } from "../src/ops/human";
import {
  getAgentTargets,
  instructionMessage,
  listInstructions,
  recordInstruction,
  acknowledgeShownInstructions,
  SENDING_STALE_MS,
  sendInstruction,
  takePendingInstructions,
} from "../src/ops/instructions";
import { archiveIssue, createIssue, getIssue } from "../src/ops/issues";
import type { OrcaRunner } from "../src/ops/orca";
import type { GhRunResult } from "../src/ops/pr-status";
import { codeOf, eventsOf, setup } from "./helpers";

const WT = "/tmp/orca/workspaces/api/feat-search";
const ok = (result: unknown): GhRunResult => ({ kind: "exited", exitCode: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" });
const agent = (extra: Record<string, unknown> = {}) => ({
  handle: "term_a",
  title: "claude",
  worktreePath: WT,
  connected: true,
  writable: true,
  agentIdentity: "claude",
  ...extra,
});
const LIST_ONE = ok({ terminals: [agent(), agent({ handle: "term_sh", agentIdentity: null })] });

// orca の代わり。サブコマンドごとの結果（関数なら呼び出しごとに決める）を返し、呼び出しを記録する
function stubOrca(results: Record<string, GhRunResult | (() => GhRunResult)>): { run: OrcaRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: OrcaRunner = async (args) => {
    calls.push(args);
    const r = results[`${args[0]} ${args[1]}`];
    return typeof r === "function" ? r() : (r ?? { kind: "not_found" });
  };
  return { run, calls };
}

function working() {
  const s = setup();
  const issue = createIssue(s.me, { workspaceId: s.ws.id, title: "検索" });
  startIssue(s.llm, issue.id, { location: { worktree: WT, branch: "feat-search" } });
  return { ...s, ref: issue.id };
}

describe("追加指示の記録（#51）", () => {
  test("コメントとして残し、Activity と pendingInstructions に種類つきで出す", () => {
    const { me, db, ref } = working();
    const recorded = recordInstruction(me, ref, "テストも追加して");
    expect(recorded).toMatchObject({ issueId: ref, kind: "instruction", body: "テストも追加して", createdBy: "me", sendState: "unsent", sentAt: null, acknowledgedAt: null });
    const detail = getIssue(db, ref);
    const comment = detail.activity.find((a) => a.kind === "comment" && a.id === recorded.commentId);
    expect(comment).toMatchObject({ kind: "comment", body: "テストも追加して", logKind: null, instruction: { id: recorded.id, kind: "instruction" } });
    expect(detail.pendingInstructions.map((i) => i.id)).toEqual([recorded.id]);
    expect(listInstructions(db, ref)).toHaveLength(1);
  });

  test("通常のコメントには instruction を付けない", () => {
    const { db, ref } = working();
    expect(getIssue(db, ref).activity.every((a) => a.kind !== "comment" || !("instruction" in a))).toBe(true);
  });

  test("LLM は記録できず、空の本文・アーカイブ済みの Issue も拒否する", () => {
    const { me, llm, ref } = working();
    expect(codeOf(() => recordInstruction(llm, ref, "x"))).toBe("FORBIDDEN_FOR_LLM");
    expect(codeOf(() => recordInstruction(me, ref, "  "))).toBe("INVALID_ARGS");
    archiveIssue(me, ref);
    expect(codeOf(() => recordInstruction(me, ref, "x"))).toBe("ISSUE_ARCHIVED");
  });
});

describe("LLM の受け取り", () => {
  test("LLM の takePendingInstructions で確認済みになり、次からは返さない。人では確認済みにしない", () => {
    const { me, llm, db, ref } = working();
    const recorded = recordInstruction(me, ref, "テストも追加して");
    expect(takePendingInstructions(me, ref).map((i) => i.id)).toEqual([recorded.id]);
    expect(takePendingInstructions(llm, ref).map((i) => i.id)).toEqual([recorded.id]);
    expect(takePendingInstructions(llm, ref)).toEqual([]);
    expect(getIssue(db, ref).pendingInstructions).toEqual([]);
    expect(listInstructions(db, ref)[0]).toMatchObject({ acknowledgedBy: "claude-code" });
  });

  test("担当の LLM が show で読んだ指示だけを確認済みにし、次の start では渡さない。人・担当でない LLM では変えない", () => {
    const { me, llm, db, ref } = working();
    const first = recordInstruction(me, ref, "テストも追加して");
    const shown = getIssue(db, ref).pendingInstructions;
    expect(acknowledgeShownInstructions(me, ref, shown)).toBe(0);
    expect(acknowledgeShownInstructions({ db, actor: "codex" }, ref, shown)).toBe(0);
    expect(getIssue(db, ref).pendingInstructions.map((i) => i.id)).toEqual([first.id]);
    // 読んだあとに記録された指示は未確認のまま残る
    const later = recordInstruction(me, ref, "README も直して");
    expect(acknowledgeShownInstructions(llm, ref, shown)).toBe(1);
    expect(listInstructions(db, ref)[0]).toMatchObject({ acknowledgedBy: "claude-code" });
    expect(takePendingInstructions(llm, ref).map((i) => i.id)).toEqual([later.id]);
  });
});

describe("送信先の候補", () => {
  test("worktree の稼働中の LLM の端末だけを返す", async () => {
    const { db, ref } = working();
    const { run, calls } = stubOrca({
      "terminal list": ok({ terminals: [agent(), agent({ handle: "sh", agentIdentity: null }), agent({ handle: "gone", connected: false }), agent({ handle: "orphan", orphaned: true })] }),
    });
    const targets = await getAgentTargets(db, ref, run);
    expect(targets).toMatchObject({ issueId: ref, worktree: WT, failure: null });
    expect(targets.terminals.map((t) => t.handle)).toEqual(["term_a"]);
    expect(calls).toEqual([["terminal", "list", "--worktree", `path:${WT}`, "--json"]]);
  });

  test("端末が無い・orca が無い・NOD_ORCA=0・worktree 未記録なら理由を返す", async () => {
    const { db, ref } = working();
    expect((await getAgentTargets(db, ref, stubOrca({ "terminal list": ok({ terminals: [agent({ agentIdentity: null })] }) }).run)).failure?.code).toBe("NO_TERMINAL");
    expect((await getAgentTargets(db, ref, stubOrca({}).run)).failure?.code).toBe("ORCA_NOT_INSTALLED");
    expect((await getAgentTargets(db, ref, null)).failure?.code).toBe("DISABLED");
    const s = setup();
    const bare = createIssue(s.me, { workspaceId: s.ws.id, title: "未着手" });
    expect(await getAgentTargets(s.db, bare.id, stubOrca({}).run)).toMatchObject({ worktree: null, terminals: [], failure: { code: "NO_WORKTREE" } });
  });
});

describe("追加指示の送信", () => {
  test("選んだ端末に定型文を送り、送信済みにする。二度目は送らない", async () => {
    const { me, db, ref } = working();
    const recorded = recordInstruction(me, ref, "テストも追加して");
    const { run, calls } = stubOrca({ "terminal list": LIST_ONE, "terminal send": ok({ accepted: true, requestId: "req_1" }) });
    const sent = await sendInstruction(me, ref, recorded.id, { terminal: "term_a" }, run);
    expect(sent).toMatchObject({ sendState: "sent", sentBy: "me", sentTerminal: "term_a", sentAgent: "claude", sendError: null });
    expect(sent.sentAt).not.toBeNull();
    expect(calls[1]).toEqual([
      "terminal", "send", "--terminal", "term_a",
      "--text", `nod: ${ref} に追加指示があります（#${recorded.id}）。nod issue show ${ref} で読んでください`,
      "--enter", "--json",
    ]);
    let code: string | undefined;
    await sendInstruction(me, ref, recorded.id, { terminal: "term_a" }, run).catch((e) => (code = e.code));
    expect(code).toBe("INSTRUCTION_ALREADY_SENT");
    expect(calls).toHaveLength(2);
    expect(getIssue(db, ref).activity.find((a) => a.kind === "comment")).toMatchObject({ instruction: { sendState: "sent" } });
  });

  test("同時に2回送っても orca terminal send は1回だけ", async () => {
    const { me, ref } = working();
    const recorded = recordInstruction(me, ref, "x");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let sends = 0;
    const run: OrcaRunner = async (args) => {
      if (args[1] === "list") return LIST_ONE;
      sends++;
      await gate;
      return ok({ accepted: true });
    };
    const first = sendInstruction(me, ref, recorded.id, { terminal: "term_a" }, run);
    const second = sendInstruction(me, ref, recorded.id, { terminal: "term_a" }, run).catch((e) => e.code);
    await new Promise((r) => setTimeout(r, 20));
    release();
    expect((await first).sendState).toBe("sent");
    expect(await second).toBe("INSTRUCTION_SENDING");
    expect(sends).toBe(1);
  });

  test("LLM は送信できない", async () => {
    const { me, llm, ref } = working();
    const recorded = recordInstruction(me, ref, "x");
    const { run, calls } = stubOrca({ "terminal list": LIST_ONE });
    let code: string | undefined;
    await sendInstruction(llm, ref, recorded.id, { terminal: "term_a" }, run).catch((e) => (code = e.code));
    expect(code).toBe("FORBIDDEN_FOR_LLM");
    expect(calls).toEqual([]);
  });

  test("選んだ端末が一覧に無ければ送らずに失敗にし、送り直せる", async () => {
    const { me, ref } = working();
    const recorded = recordInstruction(me, ref, "x");
    const { run, calls } = stubOrca({ "terminal list": LIST_ONE, "terminal send": ok({ accepted: true }) });
    const failed = await sendInstruction(me, ref, recorded.id, { terminal: "term_sh" }, run);
    expect(failed).toMatchObject({ sendState: "failed", sendError: { code: "TERMINAL_NOT_FOUND" } });
    expect(calls.some((c) => c[1] === "send")).toBe(false);
    expect((await sendInstruction(me, ref, recorded.id, { terminal: "term_a" }, run)).sendState).toBe("sent");
  });

  test("orca が無いなど明確な失敗は failed にして理由を残す", async () => {
    const { me, ref } = working();
    const recorded = recordInstruction(me, ref, "x");
    const res = await sendInstruction(me, ref, recorded.id, { terminal: "term_a" }, stubOrca({}).run);
    expect(res).toMatchObject({ sendState: "failed", sendError: { code: "ORCA_NOT_INSTALLED" } });
    const disabled = await sendInstruction(me, ref, recorded.id, { terminal: "term_a" }, null);
    expect(disabled).toMatchObject({ sendState: "failed", sendError: { code: "DISABLED" } });
  });

  test("時間切れは結果不明にし、再試行は受付 ID で --retry-request を使う", async () => {
    const { me, ref } = working();
    const recorded = recordInstruction(me, ref, "x");
    const results: Record<string, GhRunResult | (() => GhRunResult)> = { "terminal list": LIST_ONE, "terminal send": { kind: "timeout" } };
    const { run, calls } = stubOrca(results);
    const unknown = await sendInstruction(me, ref, recorded.id, { terminal: "term_a" }, run);
    expect(unknown).toMatchObject({ sendState: "unconfirmed", sendError: { code: "TIMEOUT" }, sentAt: null });
    // 受付 ID が無い結果不明は、人が届いていないと確かめるまで送り直さない
    let code: string | undefined;
    await sendInstruction(me, ref, recorded.id, { terminal: "term_a" }, run).catch((e) => (code = e.code));
    expect(code).toBe("SEND_UNCONFIRMED");
    results["terminal send"] = { kind: "exited", exitCode: 1, stdout: JSON.stringify({ ok: false, error: { code: "transport_failed", message: "lost" }, requestId: "req_9" }), stderr: "" };
    const again = await sendInstruction(me, ref, recorded.id, { terminal: "term_a", confirmResend: true }, run);
    expect(again).toMatchObject({ sendState: "unconfirmed", sendError: { code: "ORCA_ERROR" } });
    results["terminal send"] = ok({ accepted: true });
    const retried = await sendInstruction(me, ref, recorded.id, { terminal: "term_a" }, run);
    expect(retried.sendState).toBe("sent");
    expect(calls.at(-1)?.slice(-2)).toEqual(["--retry-request", "req_9"]);
  });

  test("受付 ID のある結果不明は、別の端末には再試行しない", async () => {
    const { me, ref } = working();
    const recorded = recordInstruction(me, ref, "x");
    const { run } = stubOrca({ "terminal list": LIST_ONE, "terminal send": { kind: "exited", exitCode: 1, stdout: '{"ok":false,"error":{"code":"x"},"requestId":"r"}', stderr: "" } });
    await sendInstruction(me, ref, recorded.id, { terminal: "term_a" }, run);
    let code: string | undefined;
    await sendInstruction(me, ref, recorded.id, { terminal: "term_other" }, run).catch((e) => (code = e.code));
    expect(code).toBe("INVALID_ARGS");
  });

  test("受付 ID のない非0終了・未知のエラーコード・出力過大は結果不明、orca が起動しない・端末が無いは失敗", async () => {
    const cases: [GhRunResult, string, string][] = [
      [{ kind: "exited", exitCode: 1, stdout: "", stderr: "boom" }, "unconfirmed", "ORCA_ERROR"],
      [{ kind: "exited", exitCode: 1, stdout: JSON.stringify({ ok: false, error: { code: "something_new", message: "?" } }), stderr: "" }, "unconfirmed", "ORCA_ERROR"],
      [{ kind: "too_large", limitBytes: 1024 }, "unconfirmed", "ORCA_ERROR"],
      [{ kind: "timeout" }, "unconfirmed", "TIMEOUT"],
      [{ kind: "not_found" }, "failed", "ORCA_NOT_INSTALLED"],
      [{ kind: "spawn_failed", detail: "EACCES" }, "failed", "ORCA_ERROR"],
      [{ kind: "exited", exitCode: 1, stdout: JSON.stringify({ ok: false, error: { code: "terminal_not_found" } }), stderr: "" }, "failed", "TERMINAL_NOT_FOUND"],
      [{ kind: "exited", exitCode: 1, stdout: JSON.stringify({ ok: false, error: { code: "terminal_handle_stale" } }), stderr: "" }, "failed", "TERMINAL_NOT_FOUND"],
    ];
    for (const [result, state, code] of cases) {
      const { me, ref } = working();
      const recorded = recordInstruction(me, ref, "x");
      const { run } = stubOrca({ "terminal list": LIST_ONE, "terminal send": result });
      const res = await sendInstruction(me, ref, recorded.id, { terminal: "term_a" }, run);
      expect({ kind: result.kind, state: res.sendState as string, code: res.sendError?.code as string | undefined }).toEqual({ kind: result.kind, state, code });
    }
  });

  test("送信中に結果不明とみなされ送り直されたら、先の送信の結果で上書きしない", async () => {
    const { me, db, ref } = working();
    const recorded = recordInstruction(me, ref, "x");
    const run: OrcaRunner = async (args) => {
      if (args[1] === "list") return LIST_ONE;
      // 送信中に、別の操作が送信中にし直した（send_attempted_at が変わった）
      db.query("UPDATE agent_instructions SET send_state = 'sending', send_attempted_at = ? WHERE id = ?").run("2099-01-01T00:00:00.000Z", recorded.id);
      return { kind: "exited", exitCode: 1, stdout: "", stderr: "late failure" };
    };
    await sendInstruction(me, ref, recorded.id, { terminal: "term_a" }, run);
    const row = db.query("SELECT send_state, send_attempted_at, send_error_code FROM agent_instructions WHERE id = ?").get(recorded.id);
    expect(row).toEqual({ send_state: "sending", send_attempted_at: "2099-01-01T00:00:00.000Z", send_error_code: null });
  });

  test("accepted: false は failed", async () => {
    const { me, ref } = working();
    const recorded = recordInstruction(me, ref, "x");
    const { run } = stubOrca({ "terminal list": LIST_ONE, "terminal send": ok({ accepted: false }) });
    expect((await sendInstruction(me, ref, recorded.id, { terminal: "term_a" }, run)).sendState).toBe("failed");
  });

  test("別の Issue の指示や存在しない指示は NOT_FOUND", async () => {
    const { me, ws, ref } = working();
    const other = createIssue(me, { workspaceId: ws.id, title: "別" });
    const recorded = recordInstruction(me, ref, "x");
    let code: string | undefined;
    await sendInstruction(me, other.id, recorded.id, { terminal: "term_a" }, null).catch((e) => (code = e.code));
    expect(code).toBe("NOT_FOUND");
  });

  test("送信中のまま残った記録は、時間が経つと結果不明として見せる", () => {
    const { me, db, ref } = working();
    const recorded = recordInstruction(me, ref, "x");
    db.query("UPDATE agent_instructions SET send_state = 'sending', send_attempted_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", recorded.id);
    expect(listInstructions(db, ref)[0]).toMatchObject({ sendState: "unconfirmed", sendError: { code: "TIMEOUT" } });
  });

  test("結果不明とみなすのは送信を始めてから60秒を過ぎたとき", () => {
    expect(SENDING_STALE_MS).toBe(60_000);
    const { me, db, ref } = working();
    const recorded = recordInstruction(me, ref, "x");
    const at = (ms: number) => new Date(Date.now() - ms).toISOString();
    const set = db.query("UPDATE agent_instructions SET send_state = 'sending', send_attempted_at = ? WHERE id = ?");
    set.run(at(55_000), recorded.id);
    expect(listInstructions(db, ref)[0]?.sendState).toBe("sending");
    set.run(at(61_000), recorded.id);
    expect(listInstructions(db, ref)[0]?.sendState).toBe("unconfirmed");
  });

  test("定型文は1行で、本文そのものは送らない", () => {
    const { me, ref } = working();
    const recorded = recordInstruction(me, ref, "秘密の長い指示\n2行目");
    expect(instructionMessage(recorded)).not.toContain("秘密の長い指示");
  });

  test("定型文から \\r と制御文字を除く", () => {
    const { me, db, llm, ref } = working();
    completeIssue(llm, ref, { summary: "直した" });
    rejectReview(me, ref, "テスト\r\x1b[2Jが\x07落ちる\x7f", { delegate: "review_fix" });
    const message = instructionMessage(listInstructions(db, ref).at(-1) as ReturnType<typeof listInstructions>[number]);
    expect(message).toContain("テスト [2Jが 落ちる ");
    expect(message).not.toMatch(/[\u0000-\u001f\u007f]/);
  });
});

describe("差し戻しの対応依頼（#58）", () => {
  function inReview() {
    const s = working();
    completeIssue(s.llm, s.ref, { summary: "直した" });
    return s;
  }

  test("delegate を付けると、理由を構造化した対応依頼として記録し、理由だけのコメントは残さない", () => {
    const { me, db, ref } = inReview();
    const rejected = rejectReview(me, ref, "署名ヘッダが無いリクエストのテストが無い", { delegate: "review_fix" });
    expect(rejected.status).toBe("in_progress");
    expect(rejected.instruction).toMatchObject({ kind: "review_fix", createdBy: "me", sendState: "unsent" });
    expect(rejected.instruction?.body).toBe(
      [
        "差し戻しの対応依頼（指摘対応）",
        "理由: 署名ヘッダが無いリクエストのテストが無い",
        "手順:",
        `1. nod issue start ${ref} で再開する`,
        "2. 理由に書かれた指摘に対応する",
        `3. テストを実行し、nod issue done ${ref} --summary "<対応の要約>" で再提出する`,
      ].join("\n"),
    );
    const detail = getIssue(db, ref);
    const comments = detail.activity.filter((a) => a.kind === "comment");
    expect(comments.filter((c) => c.kind === "comment" && c.body === "署名ヘッダが無いリクエストのテストが無い")).toEqual([]);
    expect(comments.filter((c) => c.kind === "comment" && c.instruction?.kind === "review_fix")).toHaveLength(1);
    expect(detail.pendingInstructions.map((i) => i.kind)).toEqual(["review_fix"]);
    expect(eventsOf(db, ref).at(-1)).toMatchObject({ type: "review_rejected", data: { reason: "署名ヘッダが無いリクエストのテストが無い", delegate: "review_fix" } });
  });

  test("rebase の手順と端末への定型文", () => {
    const { me, ref } = inReview();
    const { instruction } = rejectReview(me, ref, "main が進んだので追従して\n詳細は PR に", { delegate: "rebase" });
    expect(instruction?.body).toContain("2. ベースブランチの最新に rebase し、競合を解消する");
    expect(instructionMessage(instruction!)).toBe(
      `nod: ${ref} が差し戻されました。対応依頼（rebase）: main が進んだので追従して。nod issue start ${ref} で再開し、nod issue show ${ref} で指示を読んでください`,
    );
  });

  test("delegate なしは従来どおり理由のコメントだけ。LLM の対応依頼と不正な値は拒否する", () => {
    const { me, llm, db, ref } = inReview();
    expect(codeOf(() => rejectReview(llm, ref, "x", { delegate: "rebase" }))).toBe("FORBIDDEN_FOR_LLM");
    expect(codeOf(() => rejectReview(me, ref, "x", { delegate: "instruction" as never }))).toBe("INVALID_ARGS");
    expect(getIssue(db, ref).status).toBe("in_review");
    const plain = rejectReview(me, ref, "理由だけ");
    expect("instruction" in plain).toBe(false);
    expect(listInstructions(db, ref)).toEqual([]);
    expect(eventsOf(db, ref).at(-1)?.data).toEqual({ reason: "理由だけ" });
  });

  test("LLM は start で対応依頼を受け取る（next では拾わない）", () => {
    const { me, llm, ref } = inReview();
    rejectReview(me, ref, "テスト不足", { delegate: "review_fix" });
    expect(takePendingInstructions(llm, ref).map((i) => i.kind)).toEqual(["review_fix"]);
  });
});
