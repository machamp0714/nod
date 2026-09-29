import { describe, expect, test } from "bun:test";
import type { OpCtx } from "../src/ctx";
import { acceptTriage, declineTriage, duplicateTriage, snoozeTriage } from "../src/ops/human";
import { archiveIssue, createIssue } from "../src/ops/issues";
import { listTriageProposals, proposeTriage } from "../src/ops/triage-proposals";
import { addProjectRow, codeOf, setup } from "./helpers";

function seed() {
  const s = setup();
  const create = (ctx: OpCtx, title: string) => createIssue(ctx, { workspaceId: s.ws.id, title });
  const tables = s.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'triage_proposals' ORDER BY name").all() as { name: string }[];
  // 提案以外のすべての表の中身。提案が Triage の状態を変えないことを確かめる
  const snapshot = () => tables.map(({ name }) => s.db.query(`SELECT * FROM "${name}" ORDER BY rowid`).all());
  return { ...s, create, snapshot };
}

describe("proposeTriage", () => {
  test("LLM の受け入れ提案を記録し、提案以外の表（Issue・ラベル・関係・event・通知）を変えない", () => {
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
