import { describe, expect, test } from "bun:test";
import type { OpCtx } from "../src/ctx";
import { acceptTriage, declineTriage, duplicateTriage, snoozeTriage } from "../src/ops/human";
import { archiveIssue, createIssue, unarchiveIssue, updateIssue } from "../src/ops/issues";
import { deleteNotifications, listNotifications, markNotificationsRead, restoreNotifications, snoozeNotifications } from "../src/ops/notifications";
import { listTriageProposalCounts, listTriageProposals, proposeTriage, withdrawTriageProposal } from "../src/ops/triage-proposals";
import { addProjectRow, codeOf, setup } from "./helpers";

function seed() {
  const s = setup();
  const create = (ctx: OpCtx, title: string) => createIssue(ctx, { workspaceId: s.ws.id, title });
  const tables = s.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('triage_proposals', 'notifications') ORDER BY name").all() as { name: string }[];
  // 提案と通知以外のすべての表の中身。提案が Triage の状態を変えないことを確かめる（通知は #125 で me に届ける）
  const snapshot = () => tables.map(({ name }) => s.db.query(`SELECT * FROM "${name}" ORDER BY rowid`).all());
  return { ...s, create, snapshot };
}

describe("proposeTriage", () => {
  test("LLM の受け入れ提案を記録し、提案と通知以外の表（Issue・ラベル・関係・event）を変えない", () => {
    const { db, me, llm, create, snapshot } = seed();
    addProjectRow(db, "検索改善");
    const issue = create(llm, "検索結果のページングがずれる");
    const before = snapshot();
    const p = proposeTriage(llm, issue.id, {
      decision: "accept", labels: [" bug ", "perf", "bug"], assignee: " codex ", priority: 2, projectRef: "検索改善", reason: "再現手順が明確",
    });
    expect(snapshot()).toEqual(before);
    expect(p).toMatchObject({
      issueId: issue.id, actor: "claude-code", decision: "accept", duplicateOf: null, labels: ["bug", "perf"], assignee: "codex",
      priority: 2, project: { name: "検索改善" }, reason: "再現手順が明確",
    });
    expect(listTriageProposals(me.db, issue.id)).toEqual([p]);
  });

  test("却下・重複の提案を記録できる", () => {
    const { me, llm, create } = seed();
    const original = create(me, "元の Issue");
    const a = create(llm, "重複かも");
    const b = create(llm, "不要かも");
    expect(proposeTriage(llm, a.id, { decision: "duplicate", duplicateOf: original.id.toLowerCase() }).duplicateOf).toBe(original.id);
    expect(proposeTriage(llm, b.id, { decision: "decline", reason: "対応済み" })).toMatchObject({ decision: "decline", reason: "対応済み" });
  });

  test("同じ書き手の再提案は上書きし、別の書き手の提案は並べて残す（更新の新しい順）", () => {
    const { db, llm, create } = seed();
    const codex: OpCtx = { db, actor: "codex" };
    const issue = create(llm, "判断待ち");
    const first = proposeTriage(llm, issue.id, { decision: "decline", reason: "古い" });
    proposeTriage(codex, issue.id, { decision: "accept" });
    const again = proposeTriage(llm, issue.id, { decision: "accept", priority: 1 });
    expect(again.createdAt).toBe(first.createdAt);
    expect(again.reason).toBeNull();
    const list = listTriageProposals(db, issue.id);
    expect(list.map((p) => [p.actor, p.decision])).toEqual([["claude-code", "accept"], ["codex", "accept"]]);
  });

  test("決定の種類と組み合わせを検証する", () => {
    const { me, llm, create } = seed();
    const issue = create(llm, "判断待ち");
    const bad = (input: any) => codeOf(() => proposeTriage(llm, issue.id, input));
    expect(bad({ decision: "done" })).toBe("INVALID_ARGS");
    expect(bad({ decision: "duplicate" })).toBe("INVALID_ARGS");
    expect(bad({ decision: "accept", duplicateOf: issue.id })).toBe("INVALID_ARGS");
    expect(bad({ decision: "duplicate", duplicateOf: issue.id })).toBe("INVALID_ARGS");
    expect(bad({ decision: "duplicate", duplicateOf: "API-999" })).toBe("NOT_FOUND");
    expect(bad({ decision: "decline", labels: ["bug"] })).toBe("INVALID_ARGS");
    expect(bad({ decision: "decline", priority: 1 })).toBe("INVALID_ARGS");
    expect(bad({ decision: "accept", priority: 5 })).toBe("INVALID_ARGS");
    expect(bad({ decision: "accept", labels: [" "] })).toBe("INVALID_ARGS");
    expect(bad({ decision: "accept", labels: ["x".repeat(51)] })).toBe("INVALID_ARGS");
    // Web の「フォームに反映」はラベルを ", " で連結して空白と読点で分け直すので、それらを含む名前は拒否する
    for (const label of ["a b", "a,b", "a、b", "a，b"]) expect(bad({ decision: "accept", labels: [label] })).toBe("INVALID_ARGS");
    expect(bad({ decision: "accept", assignee: " " })).toBe("INVALID_ARGS");
    expect(bad({ decision: "accept", assignee: "x".repeat(101) })).toBe("INVALID_ARGS");
    expect(bad({ decision: "accept", projectRef: "ない" })).toBe("NOT_FOUND");
    expect(bad({ decision: "accept", reason: "x".repeat(2001) })).toBe("INVALID_ARGS");
    expect(listTriageProposals(me.db, issue.id)).toEqual([]);
    expect(proposeTriage(llm, issue.id, { decision: "accept", assignee: "x".repeat(100) }).assignee).toHaveLength(100);
  });

  test("Triage にない Issue・アーカイブ済みの Issue には提案できない。Snooze 中は提案できる", () => {
    const { me, llm, create } = seed();
    const todo = create(me, "人が起票");
    expect(codeOf(() => proposeTriage(llm, todo.id, { decision: "accept" }))).toBe("NOT_IN_TRIAGE");
    const snoozed = create(llm, "後回し");
    snoozeTriage(me, snoozed.id, "2099-01-01");
    expect(proposeTriage(llm, snoozed.id, { decision: "accept" }).decision).toBe("accept");
    const archived = create(llm, "アーカイブ");
    archiveIssue(me, archived.id);
    expect(codeOf(() => proposeTriage(llm, archived.id, { decision: "accept" }))).toBe("ISSUE_ARCHIVED");
  });

  test("人の確定後も提案は残り、確定後の提案は NOT_IN_TRIAGE で拒否する", () => {
    const { me, llm, create } = seed();
    const issue = create(llm, "判断待ち");
    proposeTriage(llm, issue.id, { decision: "accept" });
    acceptTriage(me, issue.id);
    expect(listTriageProposals(me.db, issue.id)).toHaveLength(1);
    expect(codeOf(() => proposeTriage(llm, issue.id, { decision: "decline" }))).toBe("NOT_IN_TRIAGE");
  });

  test("提案した LLM も accept / decline / duplicate は従来どおり FORBIDDEN_FOR_LLM で、何も書き込まない", () => {
    const { me, llm, create, snapshot } = seed();
    const original = create(me, "元の Issue");
    const issue = create(llm, "判断待ち");
    proposeTriage(llm, issue.id, { decision: "accept", labels: ["bug"] });
    const before = snapshot();
    expect(codeOf(() => acceptTriage(llm, issue.id, { addLabels: ["bug"] }))).toBe("FORBIDDEN_FOR_LLM");
    expect(codeOf(() => declineTriage(llm, issue.id))).toBe("FORBIDDEN_FOR_LLM");
    expect(codeOf(() => duplicateTriage(llm, issue.id, original.id))).toBe("FORBIDDEN_FOR_LLM");
    expect(snapshot()).toEqual(before);
  });
});

// me 宛ての Triage 提案の通知（#125）。既読も含めて古い順
function proposalNotifications(db: OpCtx["db"]) {
  return listNotifications(db, { includeRead: true })
    .filter((n) => n.kind === "triage_proposal")
    .reverse();
}

describe("Triage 提案の通知（#125）", () => {
  test("LLM が提案したら me に1件届ける（kind=triage_proposal）。人の提案は通知しない", () => {
    const { db, me, llm, create } = seed();
    const original = create(me, "元の Issue");
    const issue = create(llm, "判断待ち");
    proposeTriage(llm, issue.id, { decision: "duplicate", duplicateOf: original.id, reason: "同じ内容" });
    expect(proposalNotifications(db)).toMatchObject([
      { kind: "triage_proposal", eventType: "triage_proposed", issueId: issue.id, actor: "claude-code", readAt: null, data: { decision: "duplicate", duplicateOf: original.id } },
    ]);
    const other = create(llm, "人が提案");
    proposeTriage(me, other.id, { decision: "accept" });
    expect(proposalNotifications(db).map((n) => n.issueId)).toEqual([issue.id]);
  });

  test("同じ LLM の再提案は未読の通知を置き換え、既読なら新しく1件届ける。別の LLM の提案は別に届ける", () => {
    const { db, me, llm, create } = seed();
    const codex: OpCtx = { db, actor: "codex" };
    const issue = create(llm, "判断待ち");
    proposeTriage(llm, issue.id, { decision: "decline" });
    const first = proposalNotifications(db)[0]!;
    proposeTriage(llm, issue.id, { decision: "accept" });
    const replaced = proposalNotifications(db);
    expect(replaced).toHaveLength(1);
    expect(replaced[0]!.id).toBeGreaterThan(first.id);
    expect(replaced[0]!.data).toEqual({ decision: "accept", duplicateOf: null });
    markNotificationsRead(me, { all: true });
    proposeTriage(llm, issue.id, { decision: "decline" });
    proposeTriage(codex, issue.id, { decision: "accept" });
    expect(proposalNotifications(db).map((n) => [n.actor, n.data.decision, n.readAt === null])).toEqual([
      ["claude-code", "accept", false],
      ["claude-code", "decline", true],
      ["codex", "accept", true],
    ]);
  });

  test("スヌーズ中の Issue に提案が届いたらスヌーズを解く", () => {
    const { db, me, llm, create } = seed();
    const issue = create(llm, "判断待ち");
    proposeTriage(llm, issue.id, { decision: "decline" });
    snoozeNotifications(me, { issueRef: issue.id, until: "2099-01-01" });
    expect(proposalNotifications(db)).toEqual([]);
    proposeTriage({ db, actor: "codex" }, issue.id, { decision: "accept" });
    expect(proposalNotifications(db).map((n) => n.actor)).toEqual(["claude-code", "codex"]);
  });

  test("人が受け入れ・却下・重複を確定したら、その Issue の未読の提案通知を既読にする", () => {
    const { db, me, llm, create } = seed();
    const original = create(me, "元の Issue");
    const a = create(llm, "受け入れる");
    const b = create(llm, "却下する");
    const c = create(llm, "重複にする");
    const d = create(llm, "まだ判断しない");
    for (const issue of [a, b, c, d]) proposeTriage(llm, issue.id, { decision: "accept" });
    acceptTriage(me, a.id);
    declineTriage(me, b.id);
    duplicateTriage(me, c.id, original.id);
    expect(proposalNotifications(db).map((n) => [n.issueId, n.readAt === null])).toEqual([
      [a.id, false],
      [b.id, false],
      [c.id, false],
      [d.id, true],
    ]);
  });

  test("状態の変更・アーカイブで Triage を出ても、その Issue の未読の提案通知を既読にする（#132）", () => {
    const { db, me, llm, create } = seed();
    const moved = create(llm, "状態を変える");
    const archived = create(llm, "アーカイブする");
    const stays = create(llm, "Triage に残す");
    for (const issue of [moved, archived, stays]) proposeTriage(llm, issue.id, { decision: "accept" });
    updateIssue(me, moved.id, { status: "backlog" });
    archiveIssue(me, archived.id);
    updateIssue(me, stays.id, { priority: 2 });
    // アーカイブ中の Issue の通知は一覧に出ないので、戻してから確かめる
    unarchiveIssue(me, archived.id);
    expect(proposalNotifications(db).map((n) => [n.issueId, n.readAt !== null])).toEqual([
      [moved.id, true],
      [archived.id, true],
      [stays.id, false],
    ]);
  });

  test("削除した未読の提案通知も、Triage を出たら既読にする。削除を取り消しても未読で戻らない（#132）", () => {
    const { db, me, llm, create } = seed();
    const issue = create(llm, "判断待ち");
    proposeTriage(llm, issue.id, { decision: "accept" });
    const [n] = proposalNotifications(db);
    deleteNotifications(me, { ids: [n!.id] });
    acceptTriage(me, issue.id);
    restoreNotifications(me, { ids: [n!.id] });
    expect(proposalNotifications(db).map((x) => [x.id, x.readAt !== null])).toEqual([[n!.id, true]]);
  });

  test("削除した未読の提案通知は再提案で置き換え、削除を取り消しても未読が2件にならない（#132）", () => {
    const { db, me, llm, create } = seed();
    const issue = create(llm, "判断待ち");
    proposeTriage(llm, issue.id, { decision: "decline" });
    const [first] = proposalNotifications(db);
    deleteNotifications(me, { ids: [first!.id] });
    proposeTriage(llm, issue.id, { decision: "accept" });
    const [second] = proposalNotifications(db);
    deleteNotifications(me, { ids: [second!.id] });
    expect(codeOf(() => restoreNotifications(me, { ids: [first!.id] }))).toBe("NOT_FOUND");
    restoreNotifications(me, { ids: [second!.id] });
    expect(proposalNotifications(db).map((x) => [x.id, x.data.decision, x.readAt])).toEqual([[second!.id, "accept", null]]);
  });
});

describe("withdrawTriageProposal（#125）", () => {
  test("自分の提案だけを取り下げ、未読の提案通知を消す。別の LLM の提案と通知は残す", () => {
    const { db, llm, create } = seed();
    const codex: OpCtx = { db, actor: "codex" };
    const issue = create(llm, "判断待ち");
    proposeTriage(llm, issue.id, { decision: "decline" });
    proposeTriage(codex, issue.id, { decision: "accept" });
    expect(withdrawTriageProposal(llm, issue.id)).toEqual({ issueId: issue.id, actor: "claude-code", withdrawn: true });
    expect(listTriageProposals(db, issue.id).map((p) => p.actor)).toEqual(["codex"]);
    expect(proposalNotifications(db).map((n) => n.actor)).toEqual(["codex"]);
  });

  test("既読の提案通知は履歴として残す", () => {
    const { db, me, llm, create } = seed();
    const issue = create(llm, "判断待ち");
    proposeTriage(llm, issue.id, { decision: "decline" });
    markNotificationsRead(me, { all: true });
    withdrawTriageProposal(llm, issue.id);
    expect(proposalNotifications(db)).toHaveLength(1);
  });

  test("自分の提案が無ければ NOT_FOUND。Triage にない・アーカイブ済みの Issue は拒否し、何も消さない", () => {
    const { db, me, llm, create } = seed();
    const issue = create(llm, "判断待ち");
    proposeTriage({ db, actor: "codex" }, issue.id, { decision: "accept" });
    expect(codeOf(() => withdrawTriageProposal(llm, issue.id))).toBe("NOT_FOUND");
    const decided = create(llm, "確定済み");
    proposeTriage(llm, decided.id, { decision: "accept" });
    acceptTriage(me, decided.id);
    expect(codeOf(() => withdrawTriageProposal(llm, decided.id))).toBe("NOT_IN_TRIAGE");
    const archived = create(llm, "アーカイブ");
    proposeTriage(llm, archived.id, { decision: "accept" });
    archiveIssue(me, archived.id);
    expect(codeOf(() => withdrawTriageProposal(llm, archived.id))).toBe("ISSUE_ARCHIVED");
    expect(listTriageProposals(db, decided.id)).toHaveLength(1);
    expect(listTriageProposals(db, archived.id)).toHaveLength(1);
  });
});

describe("listTriageProposalCounts（#125）", () => {
  test("Triage の Issue ごとに提案者の数を返す。提案の無い Issue と Triage を出た Issue は含めない", () => {
    const { db, me, llm, create } = seed();
    const a = create(llm, "2人が提案");
    const b = create(llm, "1人が提案");
    create(llm, "提案なし");
    const done = create(llm, "確定済み");
    proposeTriage(llm, a.id, { decision: "accept" });
    proposeTriage({ db, actor: "codex" }, a.id, { decision: "decline" });
    proposeTriage(llm, b.id, { decision: "accept" });
    proposeTriage(llm, done.id, { decision: "accept" });
    acceptTriage(me, done.id);
    expect(listTriageProposalCounts(db)).toEqual({ [a.id]: 2, [b.id]: 1 });
  });

  test("数えるのは LLM の提案だけ。me の提案は数えない（通知と揃える、#132）", () => {
    const { db, me, llm, create } = seed();
    const mixed = create(llm, "LLM と me が提案");
    const mine = create(llm, "me だけが提案");
    proposeTriage(llm, mixed.id, { decision: "accept" });
    proposeTriage(me, mixed.id, { decision: "decline" });
    proposeTriage(me, mine.id, { decision: "accept" });
    expect(listTriageProposalCounts(db)).toEqual({ [mixed.id]: 1 });
  });
});
