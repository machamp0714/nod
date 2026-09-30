import { describe, expect, setSystemTime, test } from "bun:test";
import { findIssueRow } from "../src/issue-query";
import {
  AUTOMATION_DAYS_MAX,
  AUTOMATION_LIMIT_DEFAULT,
  getAutomationSettings,
  runAutomation,
  setAutomationSettings,
} from "../src/ops/automation";
import { askQuestion } from "../src/ops/agent";
import { archiveIssue, createIssue, getIssue } from "../src/ops/issues";
import { addRecurringIssue, listRecurringIssues, runRecurringIssues, updateRecurringIssue } from "../src/ops/recurring";
import { initWorkspace } from "../src/ops/workspaces";
import { setTransitionRules } from "../src/transition-rules";
import { codeOf, eventsOf, setup } from "./helpers";

const at = "2026-09-29T00:00:00.000Z";
const old = "2026-09-19T00:00:00.000Z"; // at の10日前

function fixture() {
  const s = setup();
  // 状態と時刻を直接書き、event の時刻もそろえる（活動の記録を古くする）
  const make = (
    status = "todo",
    stamp = old,
    extra: { assignee?: string | null; closedAt?: string | null; parent?: string; workspaceId?: number; snoozedUntil?: string } = {},
  ) => {
    const issue = createIssue(s.me, { workspaceId: extra.workspaceId ?? s.ws.id, title: status, parentRef: extra.parent });
    const id = findIssueRow(s.db, issue.id).id;
    const closedAt = extra.closedAt !== undefined ? extra.closedAt : status === "done" || status === "canceled" ? stamp : null;
    s.db
      .query("UPDATE issues SET status=?, created_at=?, updated_at=?, assignee=?, closed_at=?, snoozed_until=? WHERE id=?")
      .run(status, stamp, stamp, extra.assignee ?? null, closedAt, extra.snoozedUntil ?? null, id);
    s.db.query("UPDATE events SET created_at=? WHERE issue_id=?").run(stamp, id);
    return issue.id;
  };
  const enable = (close: number | null, archive: number | null) =>
    setAutomationSettings(s.me, s.ws.key, { closeAfterDays: close, archiveAfterDays: archive });
  const dry = (limit?: number) => runAutomation(s.me, s.ws.key, { dryRun: true, evaluatedAt: at, limit });
  const run = (limit?: number) => runAutomation(s.me, s.ws.key, { evaluatedAt: at, limit });
  // 関係は直接書く（relateIssue は更新日時と event を新しくするため）
  const block = (from: string, to: string, type = "blocks") =>
    s.db
      .query("INSERT INTO relations(from_id,to_id,type,created_at) VALUES (?, ?, ?, ?)")
      .run(findIssueRow(s.db, from).id, findIssueRow(s.db, to).id, type, old);
  return { ...s, make, enable, dry, run, block };
}

const ids = (r: { candidates: { id: string }[] }) => r.candidates.map((c) => c.id);

describe("自動化の設定", () => {
  test("未設定なら両ルールとも無効（null）", () => {
    const { db, ws } = setup();
    expect(getAutomationSettings(db, ws.key)).toEqual({
      workspaceKey: ws.key,
      closeAfterDays: null,
      archiveAfterDays: null,
      prReview: false,
      commitReview: false,
      updatedAt: null,
      updatedBy: null,
    });
  });

  test("人が日数を設定・部分更新・無効化できる", () => {
    const { db, ws, me } = setup();
    const saved = setAutomationSettings(me, ws.key, { closeAfterDays: 90, archiveAfterDays: 14 });
    expect(saved).toMatchObject({ closeAfterDays: 90, archiveAfterDays: 14, updatedBy: "me" });
    expect(saved.updatedAt).toBeString();
    setAutomationSettings(me, ws.key.toLowerCase(), { archiveAfterDays: null });
    expect(getAutomationSettings(db, ws.path)).toMatchObject({ closeAfterDays: 90, archiveAfterDays: null });
  });

  test("日数は 1〜3650 の整数で、範囲外は INVALID_ARGS で保存しない", () => {
    const { db, ws, me } = setup();
    expect(AUTOMATION_DAYS_MAX).toBe(3650);
    for (const bad of [0, -1, 1.5, 3651, Number.NaN]) {
      expect(codeOf(() => setAutomationSettings(me, ws.key, { closeAfterDays: bad }))).toBe("INVALID_ARGS");
      expect(codeOf(() => setAutomationSettings(me, ws.key, { archiveAfterDays: bad }))).toBe("INVALID_ARGS");
    }
    setAutomationSettings(me, ws.key, { closeAfterDays: 1, archiveAfterDays: 3650 });
    expect(getAutomationSettings(db, ws.key)).toMatchObject({ closeAfterDays: 1, archiveAfterDays: 3650 });
  });

  test("LLM は設定を変えられない", () => {
    const { db, ws, llm } = setup();
    expect(codeOf(() => setAutomationSettings(llm, ws.key, { closeAfterDays: 30 }))).toBe("FORBIDDEN_FOR_LLM");
    expect(getAutomationSettings(db, ws.key).closeAfterDays).toBeNull();
  });

  test("質問を Issue ごとに引く索引がある", () => {
    const { db } = setup();
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'questions_issue'").get()).toEqual({
      name: "questions_issue",
    });
  });

  test("未登録の Workspace は NOT_FOUND", () => {
    const { db, me } = setup();
    expect(codeOf(() => getAutomationSettings(db, "NOPE"))).toBe("NOT_FOUND");
    expect(codeOf(() => setAutomationSettings(me, "NOPE", { closeAfterDays: 1 }))).toBe("NOT_FOUND");
  });
});

describe("自動クローズ（#71）", () => {
  test("無効なルールは対象を出さず、何も変えない", () => {
    const { make, dry, run, db } = fixture();
    const target = make();
    const r = dry();
    expect(r.rules.map((x) => [x.kind, x.enabled, x.total])).toEqual([
      ["auto_close", false, 0],
      ["auto_archive", false, 0],
      ["pr_review", false, 0],
    ]);
    run();
    expect(getIssue(db, target).status).toBe("todo");
  });

  test("対象は backlog・todo・in_progress・needs_clarification で、閾値ちょうどを含む", () => {
    const { make, enable, dry } = fixture();
    enable(10, null);
    const expected = ["backlog", "todo", "in_progress", "needs_clarification"].map((s) => make(s));
    for (const s of ["triage", "in_review", "done", "canceled"]) make(s);
    make("todo", "2026-09-19T00:00:00.001Z"); // 閾値に 1ms 足りない
    make("todo", "2027-01-01T00:00:00.000Z"); // 未来
    expect(ids(dry().rules[0]!)).toEqual(expected);
  });

  test("委任中・スヌーズ中・未完了の子を持つ親・アーカイブ済み・他 Workspace を除く", () => {
    const { db, me, make, enable, dry } = fixture();
    enable(10, null);
    make("todo", old, { assignee: "claude-code" });
    const mine = make("todo", old, { assignee: "me" });
    make("todo", old, { snoozedUntil: "2026-10-01T00:00:00.000Z" });
    const snoozeEnded = make("todo", old, { snoozedUntil: "2026-09-20T00:00:00.000Z" });
    const parent = make("todo");
    make("done", old, { parent }); // 閉じた子は親を止めない
    const parent2 = make("todo");
    const openChild = make("in_review", old, { parent: parent2 }); // 開いた子は親を止める
    const archived = make("todo");
    archiveIssue(me, archived);
    db.query("UPDATE issues SET updated_at=? WHERE id=?").run(old, findIssueRow(db, archived).id);
    const other = initWorkspace(db, { path: "/tmp/automation-other", key: "OTHER" }).workspace;
    make("todo", old, { workspaceId: other.id });
    expect(openChild).toBeString();
    expect(ids(dry().rules[0]!)).toEqual([mine, snoozeEnded, parent]);
  });

  test("未完了の Issue をブロックしている Issue と、未完了のブロッカー待ちの Issue を除く", () => {
    const { me, make, enable, dry, block } = fixture();
    enable(10, null);
    const blocker = make("todo");
    const waiting = make("backlog");
    block(blocker, waiting); // どちらも除く
    const blocksDone = make("todo");
    block(blocksDone, make("done")); // 完了済みをブロックしているだけなら対象
    const blockedByCanceled = make("todo");
    block(make("canceled"), blockedByCanceled); // ブロッカーが完了済みなら対象
    const blocksArchived = make("todo");
    const archived = make("todo");
    archiveIssue(me, archived);
    block(blocksArchived, archived); // アーカイブ済みは未完了として数えない
    const related = make("todo");
    block(related, make("in_review"), "related"); // blocks 以外の関係は問わない
    expect(ids(dry().rules[0]!).sort()).toEqual([blocksDone, blockedByCanceled, blocksArchived, related].sort());
    expect(ids(dry().rules[0]!)).not.toContain(blocker);
    expect(ids(dry().rules[0]!)).not.toContain(waiting);
  });

  test("実行時にも担当・子・ブロック関係・状態を確かめ、外れたものはスキップする", () => {
    const { db, make, enable, run } = fixture();
    enable(10, null);
    const first = make("todo", "2026-09-01T00:00:00.000Z");
    const delegated = make("todo", "2026-09-02T00:00:00.000Z");
    const gotChild = make("todo", "2026-09-03T00:00:00.000Z");
    const gotBlocker = make("todo", "2026-09-04T00:00:00.000Z");
    const reviewed = make("todo", "2026-09-05T00:00:00.000Z");
    const openChild = make("todo", "2026-09-28T00:00:00.000Z");
    const openBlocker = make("todo", "2026-09-28T00:00:00.000Z");
    const id = (ref: string) => findIssueRow(db, ref).id;
    // 候補を探したあと、1件目を処理した時点でほかの Issue が変わる（ほかの操作との競合）
    db.exec(`CREATE TRIGGER race AFTER UPDATE OF close_reason ON issues WHEN NEW.id = ${id(first)} BEGIN
      UPDATE issues SET assignee = 'claude-code' WHERE id = ${id(delegated)};
      UPDATE issues SET parent_id = ${id(gotChild)} WHERE id = ${id(openChild)};
      INSERT INTO relations(from_id, to_id, type, created_at) VALUES (${id(openBlocker)}, ${id(gotBlocker)}, 'blocks', '${old}');
      UPDATE issues SET status = 'in_review' WHERE id = ${id(reviewed)};
    END`);
    const r = run().rules[0]!;
    expect(r).toMatchObject({ total: 5, processed: [first], skipped: [delegated, gotChild, gotBlocker, reviewed], failed: [] });
    expect(getIssue(db, delegated).status).toBe("todo");
    expect(getIssue(db, gotChild).status).toBe("todo");
    expect(getIssue(db, gotBlocker).status).toBe("todo");
    expect(getIssue(db, reviewed).status).toBe("in_review");
  });

  test("コメント・質問・event・更新日時のいずれかが新しければ対象外", () => {
    const { db, make, enable, dry } = fixture();
    enable(10, null);
    const recent = "2026-09-28T00:00:00.000Z";
    for (const source of ["comment", "question", "event", "updated"]) {
      const id = findIssueRow(db, make()).id;
      if (source === "comment") db.query("INSERT INTO comments(issue_id,author,body,created_at) VALUES (?, 'me', 'x', ?)").run(id, recent);
      if (source === "question") db.query("INSERT INTO questions(issue_id,question,asked_by,asked_at) VALUES (?, 'q', 'me', ?)").run(id, recent);
      if (source === "event") db.query("INSERT INTO events(issue_id,actor,type,data,created_at) VALUES (?, 'me', 'labels_changed', '{}', ?)").run(id, recent);
      if (source === "updated") db.query("UPDATE issues SET updated_at=? WHERE id=?").run(recent, id);
    }
    expect(dry().rules[0]!.total).toBe(0);
  });

  test("dry-run は候補・最終活動・経過日数を返し、DB を変えない", () => {
    const { db, make, enable, dry } = fixture();
    enable(10, null);
    const a = make("todo", "2026-09-01T00:00:00.000Z");
    const b = make("in_progress");
    const before = db.query("SELECT count(*) AS n FROM events").get();
    const r = dry();
    expect(r).toMatchObject({ evaluatedAt: at, workspaceKey: "API", dryRun: true });
    expect(r.rules[0]).toMatchObject({ kind: "auto_close", days: 10, enabled: true, total: 2, remaining: 0, processed: [], failed: [] });
    // 古い順に並ぶ
    expect(r.rules[0]!.candidates).toEqual([
      { id: a, title: "todo", status: "todo", since: "2026-09-01T00:00:00.000Z", elapsedDays: 28 },
      { id: b, title: "in_progress", status: "in_progress", since: old, elapsedDays: 10 },
    ]);
    expect(getIssue(db, a).status).toBe("todo");
    expect(db.query("SELECT count(*) AS n FROM events").get()).toEqual(before);
  });

  test("実行すると canceled にし、close_reason と自動化の印つきの event を me で残す", () => {
    const { db, make, enable, run } = fixture();
    enable(10, null);
    const ref = make("in_progress", old, { assignee: "me" });
    db.query("UPDATE issues SET agent_state='working' WHERE id=?").run(findIssueRow(db, ref).id);
    const r = run();
    expect(r.dryRun).toBe(false);
    expect(r.rules[0]).toMatchObject({ total: 1, processed: [ref], failed: [], remaining: 0 });
    const issue = getIssue(db, ref);
    expect(issue.status).toBe("canceled");
    expect(issue.closeReason).toBe("自動クローズ（10日間更新なし）");
    expect(issue.agentState).toBeNull();
    const status = eventsOf(db, ref).filter((e) => e.type === "status_changed").at(-1)!;
    expect(status).toEqual({
      type: "status_changed",
      actor: "me",
      data: { from: "in_progress", to: "canceled", reason: "自動クローズ（10日間更新なし）", automation: "auto_close" },
    });
  });

  test("done にはしない・needs_clarification も未回答の質問があっても canceled のまま", () => {
    const { db, llm, make, enable, run } = fixture();
    enable(10, null);
    const ref = make("todo");
    askQuestion(llm, ref, "どちら？");
    const row = findIssueRow(db, ref);
    db.query("UPDATE issues SET updated_at=? WHERE id=?").run(old, row.id);
    db.query("UPDATE events SET created_at=? WHERE issue_id=?").run(old, row.id);
    db.query("UPDATE questions SET asked_at=? WHERE issue_id=?").run(old, row.id);
    expect(getIssue(db, ref).status).toBe("needs_clarification");
    run();
    expect(getIssue(db, ref).status).toBe("canceled");
  });

  test("2回目の実行は対象0件（冪等）", () => {
    const { make, enable, run } = fixture();
    enable(10, null);
    make();
    make("backlog");
    expect(run().rules[0]!.processed.length).toBe(2);
    const again = run();
    expect(again.rules[0]!.total).toBe(0);
    expect(again.rules[0]!.processed).toEqual([]);
  });

  test("上限を超えた分は残りとして返し、次の実行で処理する", () => {
    const { make, enable, run, dry } = fixture();
    enable(10, null);
    const all = [1, 2, 3].map((d) => make("todo", `2026-09-0${d}T00:00:00.000Z`));
    expect(dry(2).rules[0]).toMatchObject({ total: 3, remaining: 1 });
    expect(ids(dry(2).rules[0]!)).toEqual(all.slice(0, 2));
    expect(run(2).rules[0]).toMatchObject({ total: 3, processed: all.slice(0, 2), remaining: 1 });
    expect(run(2).rules[0]).toMatchObject({ total: 1, processed: all.slice(2), remaining: 0 });
  });

  test("1件の失敗は失敗一覧に残し、残りの Issue は処理を続ける", () => {
    const { db, make, enable, run } = fixture();
    enable(10, null);
    const first = make("todo", "2026-09-01T00:00:00.000Z");
    const broken = make("todo", "2026-09-02T00:00:00.000Z");
    const last = make("todo", "2026-09-03T00:00:00.000Z");
    const brokenId = findIssueRow(db, broken).id;
    db.exec(`CREATE TRIGGER fail_one BEFORE UPDATE OF status ON issues WHEN NEW.id = ${brokenId}
      BEGIN SELECT RAISE(ABORT, '書き込めません'); END`);
    const r = run().rules[0]!;
    expect(r.processed).toEqual([first, last]);
    expect(r.failed.map((f) => f.id)).toEqual([broken]);
    expect(getIssue(db, broken)).toMatchObject({ status: "todo", closeReason: null });
  });

  test("既定の上限は 50、上限は 1〜500 の整数", () => {
    const { ws, me } = fixture();
    expect(AUTOMATION_LIMIT_DEFAULT).toBe(50);
    for (const bad of [0, 501, 1.5]) {
      expect(codeOf(() => runAutomation(me, ws.key, { dryRun: true, limit: bad }))).toBe("INVALID_ARGS");
    }
  });

  test("基準日時が不正なら INVALID_ARGS", () => {
    const { ws, me } = fixture();
    expect(codeOf(() => runAutomation(me, ws.key, { dryRun: true, evaluatedAt: "yesterday" }))).toBe("INVALID_ARGS");
  });

  test("LLM は dry-run だけでき、実行は FORBIDDEN_FOR_LLM", () => {
    const { db, llm, ws, make, enable } = fixture();
    enable(10, 10);
    const ref = make();
    expect(runAutomation(llm, ws.key, { dryRun: true, evaluatedAt: at }).rules[0]!.total).toBe(1);
    expect(codeOf(() => runAutomation(llm, ws.key, { evaluatedAt: at }))).toBe("FORBIDDEN_FOR_LLM");
    expect(getIssue(db, ref).status).toBe("todo");
  });
});

describe("自動アーカイブ（#72）", () => {
  test("done・canceled で完了から N 日経過したものだけが対象（閾値ちょうどを含む）", () => {
    const { make, enable, dry } = fixture();
    enable(null, 10);
    const done = make("done");
    const canceled = make("canceled", "2026-09-01T00:00:00.000Z");
    make("done", "2026-09-19T00:00:00.001Z");
    make("done", old, { closedAt: null }); // 完了日時がない
    make("todo");
    expect(ids(dry().rules[1]!)).toEqual([canceled, done]);
    expect(dry().rules[1]!.candidates[0]).toMatchObject({ since: "2026-09-01T00:00:00.000Z", elapsedDays: 28, status: "canceled" });
  });

  test("未完了の子を持つ親は対象外、閉じた子・アーカイブ済みの子だけなら対象", () => {
    const { me, make, enable, dry } = fixture();
    enable(null, 10);
    const blockedParent = make("done");
    make("todo", old, { parent: blockedParent });
    const okParent = make("done");
    const archivedChild = make("todo", old, { parent: okParent });
    archiveIssue(me, archivedChild);
    const child = make("canceled", old, { parent: okParent });
    expect(ids(dry().rules[1]!)).toEqual([okParent, child]);
  });

  test("実行するとアーカイブし、自動化の印つきの archived event を me で残す。2回目は0件", () => {
    const { db, make, enable, run } = fixture();
    enable(null, 10);
    const ref = make("done");
    const r = run();
    expect(r.rules[1]).toMatchObject({ kind: "auto_archive", processed: [ref], failed: [] });
    expect(getIssue(db, ref).archivedAt).toBeString();
    expect(getIssue(db, ref).status).toBe("done");
    expect(eventsOf(db, ref).at(-1)).toEqual({
      type: "archived",
      actor: "me",
      data: { reason: "自動アーカイブ（完了から10日経過）", automation: "auto_archive" },
    });
    expect(run().rules[1]!.total).toBe(0);
  });

  test("同じ実行で自動クローズした Issue はアーカイブしない", () => {
    const { db, make, enable, run, dry } = fixture();
    enable(10, 10);
    const ref = make("todo");
    // クローズの時刻（closed_at）を at の10日前に固定し、除外がなければアーカイブの対象になる状態にする
    setSystemTime(new Date(old));
    try {
      const r = run();
      expect(r.rules[0]!.processed).toEqual([ref]);
      expect(r.rules[1]).toMatchObject({ total: 0, processed: [], skipped: [] });
    } finally {
      setSystemTime();
    }
    expect(getIssue(db, ref)).toMatchObject({ status: "canceled", archivedAt: null });
    // 別の回として同じ基準日時で確かめると、アーカイブの対象になっている
    expect(ids(dry().rules[1]!)).toEqual([ref]);
  });

  test("確認時点の一覧（targets）だけを処理し、条件から外れたものはスキップとして返す", () => {
    const { db, me, ws, make, enable } = fixture();
    enable(10, 10);
    const closeA = make("todo", "2026-09-01T00:00:00.000Z");
    const closeB = make("todo", "2026-09-02T00:00:00.000Z");
    const notListed = make("todo", "2026-09-03T00:00:00.000Z");
    const archiveA = make("done");
    const reopened = make("done", "2026-09-01T00:00:00.000Z");
    // 確認のあとで closeB は委任され、reopened は再開された
    db.query("UPDATE issues SET assignee='claude-code' WHERE id=?").run(findIssueRow(db, closeB).id);
    db.query("UPDATE issues SET status='todo', closed_at=NULL WHERE id=?").run(findIssueRow(db, reopened).id);
    const r = runAutomation(me, ws.key, {
      evaluatedAt: at,
      targets: { auto_close: [closeA, closeB], auto_archive: [reopened, archiveA] },
    });
    expect(r.rules[0]).toMatchObject({ processed: [closeA], skipped: [closeB], failed: [] });
    expect(r.rules[1]).toMatchObject({ processed: [archiveA], skipped: [reopened], failed: [] });
    expect(getIssue(db, notListed).status).toBe("todo");
    expect(getIssue(db, closeB).status).toBe("todo");
    expect(getIssue(db, reopened).archivedAt).toBeNull();
  });

  test("targets は 500 件以下の Issue ID の配列", () => {
    const { me, ws, enable } = fixture();
    enable(10, 10);
    const many = Array.from({ length: 501 }, (_, i) => `API-${i + 1}`);
    expect(codeOf(() => runAutomation(me, ws.key, { evaluatedAt: at, targets: { auto_close: many } }))).toBe("INVALID_ARGS");
    const bad = { auto_close: [1] } as unknown as { auto_close: string[] };
    expect(codeOf(() => runAutomation(me, ws.key, { evaluatedAt: at, targets: bad }))).toBe("INVALID_ARGS");
  });
});

describe("定期Issueの起票（#32）", () => {
  // at（2026-09-29 00:00Z）の UTC の暦日は 2026-09-29
  const daily = (title = "日次チェック", startDate = "2026-09-29") => ({ title, cadence: "daily" as const, startDate, timeZone: "UTC" });
  const recurringIssues = (db: ReturnType<typeof setup>["db"]) =>
    db.query("SELECT title FROM issues WHERE title LIKE '日次%' OR title LIKE '週次%'").all();

  test("dry-run は起票する予定を返し、DB を変えない。自動化のルールが無効でも評価する。LLM も確かめられる", () => {
    const { db, me, llm, ws } = fixture();
    const r1 = addRecurringIssue(me, ws.key, daily());
    const r2 = addRecurringIssue(me, ws.key, daily("週次レビュー", "2026-10-01"));
    addRecurringIssue(me, ws.key, { ...daily("日次（停止中）"), enabled: false });
    for (const ctx of [me, llm]) {
      const r = runAutomation(ctx, ws.key, { dryRun: true, evaluatedAt: at });
      expect(r.recurring).toEqual({
        enabled: 2,
        items: [{ recurringId: r1.id, title: "日次チェック", occurrence: "2026-09-29", skipped: 0, issueId: null }],
        notRun: [],
        failed: [],
      });
    }
    expect(r2.enabled).toBe(true);
    expect(recurringIssues(db)).toEqual([]);
    expect(listRecurringIssues(db, ws.key)[0]!.lastOccurrence).toBeNull();
  });

  test("実行すると起票し、同じ回に起票した Issue は自動クローズ・自動アーカイブの対象にしない", () => {
    const { db, me, ws, make, enable } = fixture();
    enable(1, null);
    const stale = make("todo");
    addRecurringIssue(me, ws.key, daily());
    // 起票の時刻（created_at）を基準日時の1日前にして、除外がなければ自動クローズの対象になる状態にする
    setSystemTime(new Date("2026-09-28T00:00:00.000Z"));
    let r: ReturnType<typeof runAutomation>;
    try {
      r = runAutomation(me, ws.key, { evaluatedAt: at });
    } finally {
      setSystemTime();
    }
    const created = r.recurring.items[0]!.issueId!;
    expect(r.recurring.items).toHaveLength(1);
    expect(r.rules[0]!.processed).toEqual([stale]);
    expect(getIssue(db, created).status).toBe("todo");
    // 別の回として同じ基準日時で確かめると、起票した Issue は自動クローズの対象になっている
    const again = runAutomation(me, ws.key, { dryRun: true, evaluatedAt: at });
    expect(ids(again.rules[0]!)).toEqual([created]);
    expect(again.recurring.items).toEqual([]);
  });

  test("LLM は起票を含めて実行できない", () => {
    const { db, llm, me, ws } = fixture();
    addRecurringIssue(me, ws.key, daily());
    expect(codeOf(() => runAutomation(llm, ws.key, { evaluatedAt: at }))).toBe("FORBIDDEN_FOR_LLM");
    expect(recurringIssues(db)).toEqual([]);
  });

  test("targets の recurring（確認時点の一覧）だけを起票し、確認のあとで起票済み・停止したものは notRun で返す", () => {
    const { db, me, ws } = fixture();
    const a = addRecurringIssue(me, ws.key, daily("日次A"));
    const b = addRecurringIssue(me, ws.key, daily("日次B"));
    const c = addRecurringIssue(me, ws.key, daily("日次C"));
    const d = addRecurringIssue(me, ws.key, daily("日次D"));
    // 確認のあとで b は nod recurring run で起票され、c は停止された
    runRecurringIssues(me, ws.key, { now: new Date(at) });
    db.query("DELETE FROM recurring_issue_occurrences WHERE recurring_id IN (?, ?, ?)").run(a.id, c.id, d.id);
    updateRecurringIssue(me, ws.key, c.id, { enabled: false });
    const before = recurringIssues(db).length;
    const confirmed = [a, b, c].map((x) => ({ recurringId: x.id, occurrence: "2026-09-29" }));
    const r = runAutomation(me, ws.key, { evaluatedAt: at, targets: { recurring: confirmed } });
    expect(r.recurring.items.map((i) => i.recurringId)).toEqual([a.id]);
    expect(r.recurring.notRun).toEqual([
      { recurringId: b.id, reason: "実行時には起票済み・停止中・削除済みでした" },
      { recurringId: c.id, reason: "実行時には起票済み・停止中・削除済みでした" },
    ]);
    expect(recurringIssues(db)).toHaveLength(before + 1);
    // d は一覧に無いので起票しない。recurring の一覧が無い targets では何も起票しない
    expect(runAutomation(me, ws.key, { evaluatedAt: at, targets: {} }).recurring.items).toEqual([]);
    expect(recurringIssues(db)).toHaveLength(before + 1);
  });

  test("起票できない定期Issueは failed に入れ、ほかのルールは続ける", () => {
    const { db, me, ws, make, enable } = fixture();
    enable(10, null);
    const stale = make("todo");
    const r1 = addRecurringIssue(me, ws.key, daily());
    db.query("UPDATE recurring_issues SET template = 'missing' WHERE id = ?").run(r1.id);
    const r = runAutomation(me, ws.key, { evaluatedAt: at });
    expect(r.recurring.failed).toMatchObject([{ recurringId: r1.id, occurrence: "2026-09-29" }]);
    expect(r.rules[0]!.processed).toEqual([stale]);
  });

  test("確認時（23:59）の発生日と実行時（翌 00:01）の発生日が違えば起票せず、notRun で理由を返す", () => {
    const { db, me, ws } = fixture();
    const r1 = addRecurringIssue(me, ws.key, daily());
    const checked = runAutomation(me, ws.key, { dryRun: true, evaluatedAt: "2026-09-29T23:59:00.000Z" });
    const confirmed = checked.recurring.items.map((i) => ({ recurringId: i.recurringId, occurrence: i.occurrence }));
    expect(confirmed).toEqual([{ recurringId: r1.id, occurrence: "2026-09-29" }]);
    const r = runAutomation(me, ws.key, { evaluatedAt: "2026-09-30T00:01:00.000Z", targets: { recurring: confirmed } });
    expect(r.recurring.items).toEqual([]);
    expect(r.recurring.notRun).toEqual([{ recurringId: r1.id, reason: "確認後に発生日が変わりました" }]);
    expect(r.recurring.failed).toEqual([]);
    expect(recurringIssues(db)).toEqual([]);
    expect(listRecurringIssues(db, ws.key)[0]!.lastOccurrence).toBeNull();
    // 発生日が同じうちに実行すれば起票する
    const same = runAutomation(me, ws.key, { evaluatedAt: "2026-09-29T23:59:30.000Z", targets: { recurring: confirmed } });
    expect(same.recurring.items.map((i) => i.occurrence)).toEqual(["2026-09-29"]);
    expect(same.recurring.notRun).toEqual([]);
  });

  test("発生日が変わった定期Issueは、テンプレートが消えていても失敗ではなく notRun にする", () => {
    const { db, me, ws } = fixture();
    const r1 = addRecurringIssue(me, ws.key, daily());
    db.query("UPDATE recurring_issues SET template = 'missing' WHERE id = ?").run(r1.id);
    const r = runAutomation(me, ws.key, {
      evaluatedAt: "2026-09-30T00:01:00.000Z",
      targets: { recurring: [{ recurringId: r1.id, occurrence: "2026-09-29" }] },
    });
    expect(r.recurring.failed).toEqual([]);
    expect(r.recurring.notRun).toEqual([{ recurringId: r1.id, reason: "確認後に発生日が変わりました" }]);
  });

  test("targets.recurring は 500 件以下の { recurringId: 正の整数, occurrence: YYYY-MM-DD } の配列", () => {
    const { me, ws } = fixture();
    const item = (recurringId: unknown, occurrence: unknown = "2026-09-29") => ({ recurringId, occurrence });
    for (const bad of [
      [0],
      [item(0)],
      [item(1.5)],
      [item("1")],
      [item(1, "2026-9-29")],
      [item(1, "2026-02-30")],
      [item(1, null)],
      [null],
      Array.from({ length: 501 }, (_, i) => item(i + 1)),
    ]) {
      const targets = { recurring: bad } as unknown as { recurring: { recurringId: number; occurrence: string }[] };
      expect(codeOf(() => runAutomation(me, ws.key, { evaluatedAt: at, targets }))).toBe("INVALID_ARGS");
    }
  });
});

describe("遷移ルール（#73）と自動クローズ", () => {
  test("ルールで止まる Issue は dry-run で理由を示し、実行ではスキップとして理由つきで報告して変えない", () => {
    const { db, me, ws, make, enable, dry, run } = fixture();
    enable(10, null);
    const blocked = make("backlog");
    const ok = make("todo");
    setTransitionRules(me, ws.key, { forbidden: [{ from: "backlog", to: "canceled" }] });
    const d = dry().rules[0]!;
    expect(d.candidates.find((c) => c.id === blocked)!.ruleSkipReason).toContain("Backlog → Canceled は許可されていません");
    expect(d.candidates.find((c) => c.id === ok)!.ruleSkipReason).toBeUndefined();
    const r = run().rules[0]!;
    expect(r.processed).toEqual([ok]);
    expect(r.skipped).toEqual([blocked]);
    expect(r.skippedReasons).toEqual([{ id: blocked, message: expect.stringContaining("遷移ルールでスキップ") }]);
    expect(r.failed).toEqual([]);
    expect(getIssue(db, blocked).status).toBe("backlog");
  });
});
