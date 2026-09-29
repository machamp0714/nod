import { describe, expect, test } from "bun:test";
import { getIssue, listIssues } from "../src/ops/issues";
import {
  addRecurringIssue,
  getRecurringIssue,
  listRecurringIssues,
  removeRecurringIssue,
  runRecurringIssues,
  updateRecurringIssue,
} from "../src/ops/recurring";
import { removeTemplate, saveTemplate } from "../src/ops/templates";
import { initWorkspace } from "../src/ops/workspaces";
import { addProjectRow, codeOf, eventsOf, setup } from "./helpers";

const TZ = "Asia/Tokyo";
// Asia/Tokyo の暦日で 2026-09-30（水）の 10:00
const WED = new Date("2026-09-30T01:00:00Z");

function daily(extra: Record<string, unknown> = {}) {
  return { title: "日次チェック", cadence: "daily" as const, startDate: "2026-09-30", timeZone: TZ, ...extra };
}

describe("定期Issueの登録", () => {
  test("人が登録すると一覧・表示で引け、次回の発生日を返す", () => {
    const { db, ws, me } = setup();
    addProjectRow(db, "運用");
    const r = addRecurringIssue(me, ws.key, {
      title: "週次レビュー",
      description: "先週の振り返り",
      projectRef: "運用",
      labels: ["ops", "ops", "review"],
      priority: 2,
      assignee: "me",
      cadence: "weekly",
      weekday: 1,
      startDate: "2026-09-01",
      timeZone: TZ,
    }, { now: WED });
    expect(r).toMatchObject({
      workspaceKey: ws.key,
      title: "週次レビュー",
      description: "先週の振り返り",
      template: null,
      project: "運用",
      labels: ["ops", "review"],
      priority: 2,
      assignee: "me",
      cadence: "weekly",
      weekday: 1,
      monthDay: null,
      startDate: "2026-09-01",
      timeZone: TZ,
      enabled: true,
      lastOccurrence: null,
      lastIssueId: null,
      nextOccurrence: "2026-10-05",
      createdBy: "me",
      updatedBy: "me",
    });
    expect(listRecurringIssues(db, ws.key, { now: WED })).toEqual([r]);
    expect(getRecurringIssue(db, ws.key, r.id, { now: WED })).toEqual(r);
  });

  test("TZ を省くと実行環境のタイムゾーンを使う", () => {
    const { ws, me } = setup();
    const r = addRecurringIssue(me, ws.key, { title: "a", cadence: "daily", startDate: "2026-09-30" });
    expect(r.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  test("LLM は登録・変更・削除できない", () => {
    const { ws, me, llm } = setup();
    expect(codeOf(() => addRecurringIssue(llm, ws.key, daily()))).toBe("FORBIDDEN_FOR_LLM");
    const r = addRecurringIssue(me, ws.key, daily());
    expect(codeOf(() => updateRecurringIssue(llm, ws.key, r.id, { title: "b" }))).toBe("FORBIDDEN_FOR_LLM");
    expect(codeOf(() => removeRecurringIssue(llm, ws.key, r.id))).toBe("FORBIDDEN_FOR_LLM");
  });

  test("入力を検証する", () => {
    const { ws, me } = setup();
    saveTemplate(me.db, { name: "bug", body: "## 再現手順" });
    const bad = (input: Record<string, unknown>) => codeOf(() => addRecurringIssue(me, ws.key, daily(input) as never));
    expect(bad({ title: " " })).toBe("INVALID_ARGS");
    expect(bad({ cadence: "yearly" })).toBe("INVALID_ARGS");
    expect(bad({ cadence: "weekly" })).toBe("INVALID_ARGS"); // 曜日なし
    expect(bad({ cadence: "weekly", weekday: 7 })).toBe("INVALID_ARGS");
    expect(bad({ cadence: "monthly" })).toBe("INVALID_ARGS"); // 日なし
    expect(bad({ cadence: "monthly", monthDay: 32 })).toBe("INVALID_ARGS");
    expect(bad({ weekday: 1 })).toBe("INVALID_ARGS"); // 毎日に曜日は使わない
    expect(bad({ startDate: "2026-02-30" })).toBe("INVALID_ARGS");
    expect(bad({ timeZone: "+09:00" })).toBe("INVALID_ARGS");
    expect(bad({ timeZone: "Mars/Olympus" })).toBe("INVALID_ARGS");
    expect(bad({ priority: 5 })).toBe("INVALID_ARGS");
    expect(bad({ labels: [" "] })).toBe("INVALID_ARGS");
    expect(bad({ template: "bug", description: "x" })).toBe("INVALID_ARGS");
    expect(bad({ template: "none" })).toBe("NOT_FOUND");
    expect(bad({ projectRef: "none" })).toBe("NOT_FOUND");
    expect(codeOf(() => addRecurringIssue(me, "NOPE", daily()))).toBe("NOT_FOUND");
  });

  test("変更は渡した項目だけを変え、周期を変えると使わない指定を消す", () => {
    const { db, ws, me } = setup();
    const r = addRecurringIssue(me, ws.key, { ...daily(), cadence: "weekly", weekday: 3, labels: ["a"] });
    const u = updateRecurringIssue(me, ws.key, r.id, { cadence: "monthly", monthDay: 31, enabled: false }, { now: WED });
    expect(u).toMatchObject({ title: "日次チェック", labels: ["a"], cadence: "monthly", weekday: null, monthDay: 31, enabled: false });
    expect(u.nextOccurrence).toBeNull(); // 停止中は次回なし
    const v = updateRecurringIssue(me, ws.key, r.id, { description: "本文", projectRef: null, assignee: null, enabled: true }, { now: WED });
    expect(v).toMatchObject({ description: "本文", enabled: true, nextOccurrence: "2026-09-30" });
    expect(codeOf(() => updateRecurringIssue(me, ws.key, 999, { title: "x" }))).toBe("NOT_FOUND");
    expect(getRecurringIssue(db, ws.key, r.id).description).toBe("本文");
  });

  test("本文とテンプレートは入れ替えられる", () => {
    const { ws, me } = setup();
    saveTemplate(me.db, { name: "bug", body: "## 再現手順" });
    const r = addRecurringIssue(me, ws.key, daily({ description: "x" }));
    expect(updateRecurringIssue(me, ws.key, r.id, { template: "bug" })).toMatchObject({ template: "bug", description: null });
    expect(updateRecurringIssue(me, ws.key, r.id, { description: "y" })).toMatchObject({ template: null, description: "y" });
  });

  test("削除すると一覧から消え、作成済みの Issue は残る", () => {
    const { db, ws, me } = setup();
    const r = addRecurringIssue(me, ws.key, daily());
    runRecurringIssues(me, ws.key, { now: WED });
    expect(removeRecurringIssue(me, ws.key, r.id).id).toBe(r.id);
    expect(listRecurringIssues(db, ws.key)).toEqual([]);
    expect(listIssues(db, { workspaceId: ws.id })).toHaveLength(1);
    expect(codeOf(() => removeRecurringIssue(me, ws.key, r.id))).toBe("NOT_FOUND");
  });

  test("別の Workspace の定期Issueは ID で引けない", () => {
    const { db, ws, me } = setup();
    const r = addRecurringIssue(me, ws.key, daily());
    const other = initWorkspace(db, { path: "/tmp/repos/web" }).workspace;
    expect(codeOf(() => getRecurringIssue(db, other.key, r.id))).toBe("NOT_FOUND");
  });
});

describe("定期Issueの実行", () => {
  test("到来した発生日の Issue を通常の起票と同じ状態で作り、created event に作成元を残す", () => {
    const { db, ws, me } = setup();
    addProjectRow(db, "運用");
    const r = addRecurringIssue(me, ws.key, daily({ description: "手順", projectRef: "運用", labels: ["ops"], priority: 3, assignee: "claude-code" }));
    const run = runRecurringIssues(me, ws.key, { now: WED });
    expect(run).toMatchObject({ workspaceKey: ws.key, dryRun: false, failed: [] });
    expect(run.items).toHaveLength(1);
    const item = run.items[0]!;
    expect(item).toMatchObject({ recurringId: r.id, title: "日次チェック", occurrence: "2026-09-30", skipped: 0 });
    const issue = getIssue(db, item.issueId!);
    expect(issue).toMatchObject({
      title: "日次チェック",
      description: "手順",
      status: "todo",
      priority: 3,
      assignee: "claude-code",
      project: { name: "運用" },
      labels: ["ops"],
      createdBy: "me",
    });
    expect(eventsOf(db, item.issueId!)).toEqual([
      { type: "created", actor: "me", data: { status: "todo", recurring_id: r.id, occurrence: "2026-09-30" } },
    ]);
    expect(getRecurringIssue(db, ws.key, r.id, { now: WED })).toMatchObject({
      lastOccurrence: "2026-09-30",
      lastIssueId: item.issueId,
      nextOccurrence: "2026-10-01",
    });
  });

  test("同じ発生日では二度作らない", () => {
    const { db, ws, me } = setup();
    addRecurringIssue(me, ws.key, daily());
    runRecurringIssues(me, ws.key, { now: WED });
    const again = runRecurringIssues(me, ws.key, { now: new Date("2026-09-30T14:59:00Z") });
    expect(again.items).toEqual([]);
    expect(listIssues(db, { workspaceId: ws.id })).toHaveLength(1);
  });

  test("dry-run は作る予定を返すだけで何も書かない。LLM も使える", () => {
    const { db, ws, me, llm } = setup();
    const r = addRecurringIssue(me, ws.key, daily());
    const run = runRecurringIssues(llm, ws.key, { dryRun: true, now: WED });
    expect(run.dryRun).toBe(true);
    expect(run.items).toEqual([{ recurringId: r.id, title: "日次チェック", occurrence: "2026-09-30", skipped: 0, issueId: null }]);
    expect(listIssues(db, { workspaceId: ws.id })).toHaveLength(0);
    expect(getRecurringIssue(db, ws.key, r.id).lastOccurrence).toBeNull();
  });

  test("LLM は実行できない", () => {
    const { ws, me, llm } = setup();
    addRecurringIssue(me, ws.key, daily());
    expect(codeOf(() => runRecurringIssues(llm, ws.key, { now: WED }))).toBe("FORBIDDEN_FOR_LLM");
  });

  test("開始日より前・停止中は作らない", () => {
    const { ws, me } = setup();
    addRecurringIssue(me, ws.key, daily({ startDate: "2026-10-01" }));
    addRecurringIssue(me, ws.key, daily({ title: "停止中", enabled: false }));
    expect(runRecurringIssues(me, ws.key, { now: WED }).items).toEqual([]);
  });

  test("間が空いたら最新の1件だけ作り、飛ばした件数を返す", () => {
    const { db, ws, me } = setup();
    const r = addRecurringIssue(me, ws.key, daily({ startDate: "2026-09-01" }));
    expect(runRecurringIssues(me, ws.key, { now: WED }).items[0]).toMatchObject({ occurrence: "2026-09-30", skipped: 29 });
    const later = runRecurringIssues(me, ws.key, { now: new Date("2026-10-03T01:00:00Z") });
    expect(later.items[0]).toMatchObject({ recurringId: r.id, occurrence: "2026-10-03", skipped: 2 });
    expect(listIssues(db, { workspaceId: ws.id })).toHaveLength(2);
  });

  test("毎週は指定の曜日だけ", () => {
    const { ws, me } = setup();
    addRecurringIssue(me, ws.key, daily({ cadence: "weekly", weekday: 1, startDate: "2026-09-01" }));
    // 9/1 以降の月曜は 9/7, 14, 21, 28。水曜の 9/30 に初めて実行すると 9/28 分を作り、3件を飛ばす
    expect(runRecurringIssues(me, ws.key, { now: WED }).items[0]).toMatchObject({ occurrence: "2026-09-28", skipped: 3 });
  });

  test("毎月の 31 日は、その日が無い月は月末に作る", () => {
    const { ws, me } = setup();
    addRecurringIssue(me, ws.key, daily({ cadence: "monthly", monthDay: 31, startDate: "2026-09-01" }));
    expect(runRecurringIssues(me, ws.key, { now: WED }).items[0]).toMatchObject({ occurrence: "2026-09-30", skipped: 0 });
    const r2 = runRecurringIssues(me, ws.key, { now: new Date("2027-03-01T01:00:00Z") });
    // 10/31, 11/30, 12/31, 1/31, 2/28 のうち最新の 2/28 を作る
    expect(r2.items[0]).toMatchObject({ occurrence: "2027-02-28", skipped: 4 });
  });

  test("発生日はルールのタイムゾーンの暦日で決める", () => {
    const { ws, me } = setup();
    addRecurringIssue(me, ws.key, daily({ startDate: "2026-10-01" }));
    addRecurringIssue(me, ws.key, daily({ title: "UTC", startDate: "2026-10-01", timeZone: "UTC" }));
    // 2026-09-30T15:30Z は東京では 10/1、UTC ではまだ 9/30
    const run = runRecurringIssues(me, ws.key, { dryRun: true, now: new Date("2026-09-30T15:30:00Z") });
    expect(run.items.map((i) => [i.title, i.occurrence])).toEqual([["日次チェック", "2026-10-01"]]);
  });

  test("テンプレートは実行時に解決し、無ければそのルールだけ失敗して他は続ける", () => {
    const { db, ws, me } = setup();
    saveTemplate(me.db, { name: "bug", body: "## 旧" });
    const a = addRecurringIssue(me, ws.key, daily({ title: "A", template: "bug" }));
    const b = addRecurringIssue(me, ws.key, daily({ title: "B" }));
    saveTemplate(me.db, { name: "bug", body: "## 新" });
    const ok = runRecurringIssues(me, ws.key, { now: WED });
    expect(getIssue(db, ok.items.find((i) => i.recurringId === a.id)!.issueId!).description).toBe("## 新");

    removeTemplate(me.db, "bug");
    const next = runRecurringIssues(me, ws.key, { now: new Date("2026-10-01T01:00:00Z") });
    expect(next.items.map((i) => i.recurringId)).toEqual([b.id]);
    expect(next.failed).toEqual([{ recurringId: a.id, title: "A", occurrence: "2026-10-01", message: expect.stringContaining("bug") }]);
    // 失敗した発生日は作成済みにしない（テンプレートを戻せば次の実行で作る）
    expect(getRecurringIssue(db, ws.key, a.id).lastOccurrence).toBe("2026-09-30");
    const dry = runRecurringIssues(me, ws.key, { dryRun: true, now: new Date("2026-10-01T01:00:00Z") });
    expect(dry.failed.map((f) => f.recurringId)).toEqual([a.id]);
  });

  test("別の Workspace の定期Issueは実行しない", () => {
    const { db, ws, me } = setup();
    addRecurringIssue(me, ws.key, daily());
    const other = initWorkspace(db, { path: "/tmp/repos/web" }).workspace;
    expect(runRecurringIssues(me, other.key, { now: WED }).items).toEqual([]);
  });
});
