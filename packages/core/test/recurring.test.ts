import { describe, expect, test } from "bun:test";
import { nextIssue, suggestIssue } from "../src/ops/agent";
import { deleteIssue } from "../src/ops/issue-deletions";
import { archiveIssue, getIssue, listIssues } from "../src/ops/issues";
import {
  addRecurringIssue,
  getRecurringIssue,
  listRecurringIssues,
  removeRecurringIssue,
  runRecurringIssues,
  updateRecurringIssue,
} from "../src/ops/recurring";
import { removeTemplate, saveTemplate } from "../src/ops/templates";
import { addWorkspaceLabel, removeWorkspaceLabel, updateWorkspaceLabel } from "../src/ops/workspace-labels";
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
      // 9/28（月）はまだ起票していないので、次の実行で作るその日を次回として返す
      nextOccurrence: "2026-09-28",
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
    saveTemplate(me, { name: "bug", body: "## 再現手順" });
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
    saveTemplate(me, { name: "bug", body: "## 再現手順" });
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

  test("前回の Issue を永久削除すると、前回の日付はそのままで番号は出さない（前の回の番号にずれない）", () => {
    const { db, ws, me } = setup();
    const r = addRecurringIssue(me, ws.key, daily());
    const first = runRecurringIssues(me, ws.key, { now: WED }).items[0]!;
    const THU = new Date("2026-10-01T01:00:00Z");
    const second = runRecurringIssues(me, ws.key, { now: THU }).items[0]!;
    expect(getRecurringIssue(db, ws.key, r.id, { now: THU })).toMatchObject({ lastOccurrence: "2026-10-01", lastIssueId: second.issueId });
    archiveIssue(me, second.issueId!);
    deleteIssue(me, second.issueId!);
    expect(getRecurringIssue(db, ws.key, r.id, { now: THU })).toMatchObject({ lastOccurrence: "2026-10-01", lastIssueId: null });
    expect(listRecurringIssues(db, ws.key, { now: THU })[0]).toMatchObject({ lastOccurrence: "2026-10-01", lastIssueId: null });
    expect(first.issueId).not.toBe(second.issueId);
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
    saveTemplate(me, { name: "bug", body: "## 旧" });
    const a = addRecurringIssue(me, ws.key, daily({ title: "A", template: "bug" }));
    const b = addRecurringIssue(me, ws.key, daily({ title: "B" }));
    saveTemplate(me, { name: "bug", body: "## 新" });
    const ok = runRecurringIssues(me, ws.key, { now: WED });
    expect(getIssue(db, ok.items.find((i) => i.recurringId === a.id)!.issueId!).description).toBe("## 新");

    removeTemplate(me, "bug");
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

describe("定期Issueの修正（#135 レビュー）", () => {
  test("テンプレートが消えたルールも停止・編集できる。テンプレートを新しく指定・変更したときだけ存在を確かめる", () => {
    const { ws, me } = setup();
    saveTemplate(me, { name: "bug", body: "## 再現手順" });
    const r = addRecurringIssue(me, ws.key, daily({ template: "bug" }));
    removeTemplate(me, "bug");
    expect(updateRecurringIssue(me, ws.key, r.id, { enabled: false })).toMatchObject({ enabled: false, template: "bug" });
    expect(updateRecurringIssue(me, ws.key, r.id, { title: "改名", template: "bug" })).toMatchObject({ title: "改名", template: "bug" });
    expect(codeOf(() => updateRecurringIssue(me, ws.key, r.id, { template: "none" }))).toBe("NOT_FOUND");
    expect(updateRecurringIssue(me, ws.key, r.id, { description: "本文へ" })).toMatchObject({ template: null, description: "本文へ" });
  });

  test("実行中にルールが消えても、そのルールだけ failed に入れて他は続ける", () => {
    const { db, ws, me } = setup();
    const a = addRecurringIssue(me, ws.key, daily({ title: "A" }));
    const b = addRecurringIssue(me, ws.key, daily({ title: "B" }));
    const c = addRecurringIssue(me, ws.key, daily({ title: "C" }));
    // A を起票した直後に B が別の操作で消された状況を作る
    db.run(`CREATE TEMP TRIGGER drop_b AFTER INSERT ON recurring_issue_occurrences WHEN NEW.recurring_id = ${a.id}
      BEGIN DELETE FROM recurring_issues WHERE id = ${b.id}; END`);
    const run = runRecurringIssues(me, ws.key, { now: WED });
    expect(run.items.map((i) => i.recurringId)).toEqual([a.id, c.id]);
    expect(run.failed).toEqual([{ recurringId: b.id, title: "B", occurrence: "2026-09-30", message: expect.any(String) }]);
    expect(listIssues(db, { workspaceId: ws.id })).toHaveLength(2);
  });

  test("次回は、まだ起票していない過去の発生日があればその最新日を返す（実行で作る日と一致する）", () => {
    const { ws, me } = setup();
    const r = addRecurringIssue(me, ws.key, daily({ startDate: "2026-09-01" }), { now: WED });
    const dry = runRecurringIssues(me, ws.key, { dryRun: true, now: WED });
    expect(r.nextOccurrence).toBe(dry.items[0]!.occurrence);
    const w = addRecurringIssue(me, ws.key, daily({ cadence: "weekly", weekday: 1, startDate: "2026-09-01" }), { now: WED });
    expect(w.nextOccurrence).toBe("2026-09-28");
    runRecurringIssues(me, ws.key, { now: WED });
    expect(getRecurringIssue(me.db, ws.key, w.id, { now: WED }).nextOccurrence).toBe("2026-10-05");
  });

  test("閏年の2月は 29 日、平年は 28 日に作る", () => {
    const { ws, me } = setup();
    addRecurringIssue(me, ws.key, daily({ title: "29", cadence: "monthly", monthDay: 29, startDate: "2028-02-01" }));
    addRecurringIssue(me, ws.key, daily({ title: "31", cadence: "monthly", monthDay: 31, startDate: "2027-02-01" }));
    const leap = runRecurringIssues(me, ws.key, { dryRun: true, now: new Date("2028-02-29T01:00:00Z") });
    expect(leap.items.map((i) => [i.title, i.occurrence])).toEqual([["29", "2028-02-29"], ["31", "2028-02-29"]]);
    const before = runRecurringIssues(me, ws.key, { dryRun: true, now: new Date("2028-02-28T01:00:00Z") });
    expect(before.items.map((i) => [i.title, i.occurrence])).toEqual([["31", "2028-01-31"]]);
    const common = runRecurringIssues(me, ws.key, { dryRun: true, now: new Date("2027-02-28T01:00:00Z") });
    expect(common.items.map((i) => [i.title, i.occurrence])).toEqual([["31", "2027-02-28"]]);
  });

  test("開始日当日が発生日ならその日に作る", () => {
    const { ws, me } = setup();
    addRecurringIssue(me, ws.key, daily({ title: "週", cadence: "weekly", weekday: 3, startDate: "2026-09-30" }));
    addRecurringIssue(me, ws.key, daily({ title: "月", cadence: "monthly", monthDay: 30, startDate: "2026-09-30" }));
    addRecurringIssue(me, ws.key, daily({ title: "翌週", cadence: "weekly", weekday: 2, startDate: "2026-09-30" }));
    const run = runRecurringIssues(me, ws.key, { dryRun: true, now: WED });
    expect(run.items.map((i) => [i.title, i.occurrence, i.skipped])).toEqual([["週", "2026-09-30", 0], ["月", "2026-09-30", 0]]);
    expect(listRecurringIssues(me.db, ws.key, { now: WED }).map((r) => r.nextOccurrence)).toEqual(["2026-09-30", "2026-09-30", "2026-10-06"]);
  });

  test("周期を変えると、前回の起票より後の新しい周期の発生日から作る", () => {
    const { ws, me } = setup();
    const r = addRecurringIssue(me, ws.key, daily());
    runRecurringIssues(me, ws.key, { now: WED });
    // 9/30 に起票済みの毎日を毎週金曜に変える
    const u = updateRecurringIssue(me, ws.key, r.id, { cadence: "weekly", weekday: 5 }, { now: WED });
    expect(u.nextOccurrence).toBe("2026-10-02");
    expect(runRecurringIssues(me, ws.key, { now: new Date("2026-10-01T01:00:00Z") }).items).toEqual([]);
    const fri = runRecurringIssues(me, ws.key, { now: new Date("2026-10-05T01:00:00Z") });
    expect(fri.items[0]).toMatchObject({ occurrence: "2026-10-02", skipped: 0 });
    // 毎月 1 日へ変えても、起票済みの 10/2 より前の 10/1 は作らない
    updateRecurringIssue(me, ws.key, r.id, { cadence: "monthly", monthDay: 1 });
    expect(runRecurringIssues(me, ws.key, { dryRun: true, now: new Date("2026-10-31T01:00:00Z") }).items).toEqual([]);
    expect(getRecurringIssue(me.db, ws.key, r.id, { now: new Date("2026-10-31T01:00:00Z") }).nextOccurrence).toBe("2026-11-01");
  });

  test("ラベルを改名すると定期Issueのラベルも置き換え、削除では残す", () => {
    const { ws, me } = setup();
    addWorkspaceLabel(me, ws.key, { name: "ops", color: "#2563eb" });
    addWorkspaceLabel(me, ws.key, { name: "gone", color: "#2563eb" });
    const r = addRecurringIssue(me, ws.key, daily({ labels: ["ops", "run", "gone"] }));
    const other = initWorkspace(me.db, { path: "/tmp/repos/web" }).workspace;
    const o = addRecurringIssue(me, other.key, daily({ labels: ["ops"] }));
    updateWorkspaceLabel(me, ws.key, "ops", { name: "run" });
    expect(getRecurringIssue(me.db, ws.key, r.id).labels).toEqual(["run", "gone"]);
    expect(getRecurringIssue(me.db, other.key, o.id).labels).toEqual(["ops"]);
    removeWorkspaceLabel(me, ws.key, "gone");
    expect(getRecurringIssue(me.db, ws.key, r.id).labels).toEqual(["run", "gone"]);
  });
});

describe("LLM に定型作業を定期実行させる（#64）", () => {
  test("担当に LLM を指定した定期Issueは、人の実行で todo として起票され、その LLM の next で拾われる", () => {
    const { db, ws, me, llm } = setup();
    const codex = { db, actor: "codex" };
    saveTemplate(me, { name: "依存更新チェック", body: "## 手順\n- [ ] bun outdated" });
    const r = addRecurringIssue(me, ws.key, daily({ title: "依存更新チェック", template: "依存更新チェック", assignee: "claude-code" }));
    const created = runRecurringIssues(me, ws.key, { now: WED }).items[0]!.issueId!;
    // LLM が担当でも、起票したのは人なので Triage を通らない
    expect(eventsOf(db, created)[0]).toMatchObject({ type: "created", actor: "me", data: { status: "todo", recurring_id: r.id } });
    expect(suggestIssue(llm, { workspaceId: ws.id })?.id).toBe(created);
    // 担当でない LLM には出ない
    expect(suggestIssue(codex, { workspaceId: ws.id })).toBeNull();
    expect(nextIssue(codex, { workspaceId: ws.id })).toBeNull();
    const taken = nextIssue(llm, { workspaceId: ws.id });
    expect(taken).toMatchObject({ id: created, status: "in_progress", assignee: "claude-code", description: "## 手順\n- [ ] bun outdated" });
  });
});
