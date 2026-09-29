import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { askQuestion, completeIssue, failIssue, startIssue } from "../src/ops/agent";
import { answerQuestion, rejectReview, approveReview } from "../src/ops/human";
import { archiveIssue, createIssue, logWork, updateIssue } from "../src/ops/issues";
import { createProject } from "../src/ops/projects";
import { initWorkspace } from "../src/ops/workspaces";
import { recentSummary, parseSince, summaryStatement } from "../src/ops/summary";
import { codeOf, setup } from "./helpers";

const NOW = new Date("2026-09-30T12:00:00.000Z");

// ops は現在時刻で記録するため、テストでは記録済みの時刻を書き換えて期間を作る
function backdate(db: Database, at: string): void {
  db.query("UPDATE events SET created_at = ?").run(at);
}

function section(s: ReturnType<typeof recentSummary>, kind: string) {
  const found = s.sections.find((x) => x.kind === kind);
  if (!found) throw new Error(`section ${kind} がありません`);
  return found;
}

describe("parseSince（期間の指定）", () => {
  test("24h・7d・2w を現在時刻からの相対にする", () => {
    expect(parseSince("24h", NOW)).toBe("2026-09-29T12:00:00.000Z");
    expect(parseSince("7d", NOW)).toBe("2026-09-23T12:00:00.000Z");
    expect(parseSince("2w", NOW)).toBe("2026-09-16T12:00:00.000Z");
  });

  test("ISO 日時をそのまま下限にする", () => {
    expect(parseSince("2026-09-29T00:00:00+09:00", NOW)).toBe("2026-09-28T15:00:00.000Z");
  });

  test("書式違い・未来・90日を超える期間は INVALID_ARGS", () => {
    for (const bad of ["", "1y", "abc", "0h", "2026-09-31T00:00:00Z", "2026-10-01T00:00:00Z", "91d"]) {
      expect(codeOf(() => parseSince(bad, NOW))).toBe("INVALID_ARGS");
    }
    expect(parseSince("90d", NOW)).toBe("2026-07-02T12:00:00.000Z");
  });
});

describe("recentSummary（期間の要約）", () => {
  test("既定は直近24時間。期間外の event は含めない", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "古い" });
    backdate(db, "2026-09-29T11:59:59.000Z");
    const b = createIssue(me, { workspaceId: ws.id, title: "新しい" });
    db.query("UPDATE events SET created_at = ? WHERE issue_id = (SELECT id FROM issues WHERE title = '新しい')").run("2026-09-30T11:00:00.000Z");

    const s = recentSummary(db, { now: NOW });
    expect(s.since).toBe("2026-09-29T12:00:00.000Z");
    expect(s.until).toBe("2026-09-30T12:00:00.000Z");
    expect(section(s, "created").items.map((x) => x.issueId)).toEqual([b.id]);
    expect(a.id).not.toBe(b.id);
  });

  test("種類ごとに分け、人と LLM を actor で区別する", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const b = createIssue(llm, { workspaceId: ws.id, title: "b" });
    startIssue(llm, a.id);
    askQuestion(llm, a.id, "どちらの API を使う？");
    answerQuestion(me, a.id, "新しい方");
    completeIssue(llm, a.id, { summary: "実装しました" });
    rejectReview(me, a.id, "テストが足りない");
    completeIssue(llm, a.id, { summary: "テストを足しました" });
    approveReview(me, a.id);
    updateIssue(me, b.id, { status: "canceled" });
    backdate(db, "2026-09-30T10:00:00.000Z");

    const s = recentSummary(db, { now: NOW });
    const counts = Object.fromEntries(s.sections.map((x) => [x.kind, [x.total, x.human, x.llm]]));
    expect(counts).toMatchObject({
      completed: [1, 0, 1],
      canceled: [1, 1, 0],
      started: [1, 0, 1], // 差し戻しによる in_progress は着手に数えない
      submitted: [2, 0, 2],
      rejected: [1, 1, 0],
      asked: [1, 0, 1],
      answered: [1, 1, 0],
      created: [2, 1, 1],
    });
    expect(section(s, "rejected").items[0]).toMatchObject({ actor: "me", actorKind: "human", detail: "テストが足りない" });
    expect(section(s, "asked").items[0]).toMatchObject({ actor: "claude-code", actorKind: "llm", detail: "どちらの API を使う？" });
    // 完了は人が確定するが、担当の LLM に帰属させる。キャンセルは担当がいなければ書き手のまま
    expect(section(s, "completed").items[0]).toMatchObject({
      issueId: a.id, title: "a", assignee: "claude-code", status: "done",
      actor: "claude-code", actorKind: "llm", recordedBy: "me", from: "in_review", to: "done",
    });
    expect(section(s, "canceled").items[0]).toMatchObject({ actor: "me", actorKind: "human", recordedBy: "me" });
    expect(s.totals.total).toBe(s.sections.reduce((n, x) => n + x.total, 0));
  });

  test("ブロッカーの作業ログと LLM のエラー停止をブロッカーとして挙げる", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    startIssue(llm, a.id);
    logWork(llm, a.id, "経過メモ", { kind: "progress" });
    logWork(llm, a.id, "CI の権限が足りず push できない", { kind: "blocker" });
    failIssue(llm, b.id, "依存パッケージが取得できない");
    backdate(db, "2026-09-30T10:00:00.000Z");
    db.query("UPDATE comments SET created_at = ?").run("2026-09-30T10:00:00.000Z");
    db.query("UPDATE comments SET created_at = ? WHERE log_kind = 'blocker'").run("2026-09-30T10:30:00.000Z");
    const s = recentSummary(db, { now: NOW });
    expect(section(s, "blocker").items.map((x) => [x.issueId, x.actorKind, x.detail])).toEqual([
      [a.id, "llm", "CI の権限が足りず push できない"],
      [b.id, "llm", "依存パッケージが取得できない"],
    ]);
  });

  test("新しい順に limit 件まで返し、残りを more に数える", () => {
    const { db, ws, me } = setup();
    for (let n = 0; n < 5; n++) createIssue(me, { workspaceId: ws.id, title: `t${n}` });
    backdate(db, "2026-09-30T10:00:00.000Z");
    const s = recentSummary(db, { now: NOW, limit: 2 });
    const created = section(s, "created");
    expect(created.items.map((x) => x.title)).toEqual(["t4", "t3"]);
    expect([created.total, created.more]).toEqual([5, 3]);
    expect(codeOf(() => recentSummary(db, { now: NOW, limit: 0 }))).toBe("INVALID_ARGS");
    expect(codeOf(() => recentSummary(db, { now: NOW, limit: 201 }))).toBe("INVALID_ARGS");
  });

  test("アーカイブ済み Issue の動きは既定で除き、アーカイブした操作は残す", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    archiveIssue(me, a.id);
    backdate(db, "2026-09-30T10:00:00.000Z");
    const s = recentSummary(db, { now: NOW });
    expect(section(s, "created").total).toBe(0);
    expect(section(s, "archived").items.map((x) => [x.issueId, x.archived])).toEqual([[a.id, true]]);
    const all = recentSummary(db, { now: NOW, includeArchived: true });
    expect(section(all, "created").items.map((x) => [x.issueId, x.archived])).toEqual([[a.id, true]]);
  });

  test("Workspace と Project で絞り込む", () => {
    const { db, ws, me } = setup();
    const other = initWorkspace(db, { path: "/tmp/repos/web-app" }).workspace;
    const p = createProject(me, { name: "P" });
    const a = createIssue(me, { workspaceId: ws.id, title: "a", projectRef: p.name });
    createIssue(me, { workspaceId: ws.id, title: "b" });
    createIssue(me, { workspaceId: other.id, title: "c" });
    backdate(db, "2026-09-30T10:00:00.000Z");
    expect(section(recentSummary(db, { now: NOW }), "created").total).toBe(3);
    expect(section(recentSummary(db, { now: NOW, workspace: [ws.key] }), "created").total).toBe(2);
    expect(section(recentSummary(db, { now: NOW, project: "P" }), "created").items.map((x) => x.issueId)).toEqual([a.id]);
    expect(codeOf(() => recentSummary(db, { now: NOW, workspace: ["NOPE"] }))).toBe("NOT_FOUND");
  });

  test("完了は、担当を me に付け替えた後でも直前の LLM に帰属させる。LLM がいなければ書き手", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    startIssue(llm, a.id);
    completeIssue(llm, a.id, { summary: "実装しました" });
    updateIssue(me, a.id, { assignee: "me" });
    approveReview(me, a.id);
    updateIssue(me, b.id, { assignee: "me" });
    updateIssue(me, b.id, { status: "in_progress" });
    updateIssue(me, b.id, { status: "in_review" });
    approveReview(me, b.id);
    backdate(db, "2026-09-30T10:00:00.000Z");
    const items = section(recentSummary(db, { now: NOW }), "completed").items;
    expect(items.map((x) => [x.issueId, x.assignee, x.actor, x.actorKind, x.recordedBy])).toEqual([
      [b.id, "me", "me", "human", "me"],
      [a.id, "me", "claude-code", "llm", "me"],
    ]);
  });

  test("手動の in_review→in_progress は着手に数え、差し戻しによる遷移だけを除く", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    startIssue(llm, a.id);
    completeIssue(llm, a.id, { summary: "1回目" });
    rejectReview(me, a.id, "足りない");
    updateIssue(me, b.id, { status: "in_review" });
    updateIssue(me, b.id, { status: "in_progress" });
    backdate(db, "2026-09-30T10:00:00.000Z");
    const s = recentSummary(db, { now: NOW });
    expect(section(s, "started").items.map((x) => [x.issueId, x.from, x.to])).toEqual([
      [b.id, "in_review", "in_progress"],
      [a.id, "todo", "in_progress"],
    ]);
    expect(section(s, "rejected").items.map((x) => x.issueId)).toEqual([a.id]);
  });

  test("期間の両端ちょうどの動きを含め、1ms 外は含めない", () => {
    const { db, ws, me } = setup();
    for (const title of ["start", "end", "before", "after"]) createIssue(me, { workspaceId: ws.id, title });
    const at = {
      start: "2026-09-29T12:00:00.000Z",
      end: NOW.toISOString(),
      before: "2026-09-29T11:59:59.999Z",
      after: "2026-09-30T12:00:00.001Z",
    };
    for (const [title, ts] of Object.entries(at)) {
      db.query("UPDATE events SET created_at = ? WHERE issue_id = (SELECT id FROM issues WHERE title = ?)").run(ts, title);
    }
    const s = recentSummary(db, { now: NOW });
    expect(s.since).toBe(at.start);
    expect(s.until).toBe(at.end);
    expect(section(s, "created").items.map((x) => x.title)).toEqual(["end", "start"]);
  });

  test("読み取り専用で、実際の要約クエリが events と作業ログの索引を使う", () => {
    const { db, ws, me } = setup();
    createIssue(me, { workspaceId: ws.id, title: "a" });
    const before = db.query("SELECT total_changes() AS n").get() as { n: number };
    recentSummary(db, { now: NOW });
    expect(db.query("SELECT total_changes() AS n").get()).toEqual(before);
    for (const includeArchived of [false, true]) {
      const stmt = summaryStatement(db, { workspace: [ws.key] }, "2026-09-29T12:00:00.000Z", NOW.toISOString(), includeArchived);
      const plan = (db.query(`EXPLAIN QUERY PLAN ${stmt.sql}`).all(...stmt.params) as { detail: string }[])
        .map((r) => r.detail).join("\n");
      expect(plan).toContain("events_type_created");
      expect(plan).toContain("comments_log_kind");
      expect(plan).toContain("SEARCH a USING INDEX events_issue");
      expect(plan).toContain("SEARCH r USING INDEX events_issue");
      expect(plan).not.toMatch(/^SCAN [a-z]+$/m); // 表の全走査がない（外側の副問合せの走査だけ）
    }
  });
});
