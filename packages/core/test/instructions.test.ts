import { describe, expect, test } from "bun:test";
import { startIssue } from "../src/ops/agent";
import {
  getAgentTargets,
  instructionMessage,
  listInstructions,
  recordInstruction,
  sendInstruction,
  takePendingInstructions,
} from "../src/ops/instructions";
import { archiveIssue, createIssue, getIssue } from "../src/ops/issues";
import type { OrcaRunner } from "../src/ops/orca";
import type { GhRunResult } from "../src/ops/pr-status";
import { codeOf, setup } from "./helpers";

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

  test("定型文は1行で、本文そのものは送らない", () => {
    const { me, ref } = working();
    const recorded = recordInstruction(me, ref, "秘密の長い指示\n2行目");
    expect(instructionMessage(recorded)).not.toContain("秘密の長い指示");
  });
});
