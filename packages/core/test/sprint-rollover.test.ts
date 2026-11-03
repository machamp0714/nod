import { expect, spyOn, test } from "bun:test";
import * as core from "../src/index";
import { codeOf, eventsOf, setup } from "./helpers";

// 前Sprintは Asia/Tokyo の 2026-10-26（月）〜2026-11-01（日）の7日間。後継の最初の区間は 11-02〜11-08。
const tz = "Asia/Tokyo";
const at = (iso: string) => ({ now: new Date(iso) });
const duringFirst = at("2026-10-27T00:00:00.000Z");
const afterEnd = at("2026-11-03T00:00:00.000Z");

function configured() {
  const f = setup();
  core.configureScrumWorkspace(f.me, f.ws.key, { expectedVersion: 0, requestKey: "設定", enabled: true, problem: "停滞", productGoal: "開発を進める", priorityRationale: "判断を優先" });
  return f;
}
type Fixture = ReturnType<typeof configured>;

// 人の合意・開始を経た実行中Sprint。Issueは直接追加で所属させる。
function activeSprint(f: Fixture, titles: string[], period = { startDate: "2026-10-26", endDate: "2026-11-01" }, workingDays = [1, 2, 3, 4, 5]) {
  const created = core.createSprint(f.llm, { ...period, timezone: tz, workingDays, workspaceKey: f.ws.key, expectedVersion: 0, requestKey: `作成${period.startDate}` });
  const issues = titles.map(title => {
    const issue = core.createIssue(f.me, { workspaceId: f.ws.id, title });
    core.addIssueToSprint(f.llm, created.id, { issueRef: issue.id });
    return issue;
  });
  const proposed = core.proposeSprintPlan(f.llm, created.id, { expectedVersion: created.version, requestKey: "計画", goal: "前のゴール", verificationMethod: "確認する",
    items: [], definitionOfDone: [{ id: "前", text: "前の完成の定義" }], constraints: { executionScope: "WS", maxParallel: 1, notes: "なし" }, changeReason: "最初の提案" });
  const ready = core.acceptSprintPlan(f.me, created.id, proposed.plan.id, { expectedVersion: proposed.sprint.version, requestKey: "合意", contentHash: proposed.plan.contentHash });
  const sprint = core.activateSprint(f.me, created.id, { expectedVersion: ready.sprint.version, requestKey: "開始" }, { now: new Date(created.startsAt!) });
  return { sprint, issues };
}

test("期限切れの実行中Sprintを自動で終了し、同じ長さ・timezone・稼働曜日の後継を作って未完了の所属を引き継いで開始する", () => {
  const f = configured();
  try {
    const { sprint, issues } = activeSprint(f, ["未完了", "完了済み"], undefined, [1, 3, 5]);
    core.updateIssue(f.me, issues[1]!.id, { status: "done" });

    const results = core.syncSprintRollover(f.db, afterEnd);

    const previous = core.getSprint(f.db, sprint.id);
    expect(previous).toMatchObject({ phase: "ended", closureRecord: { kind: "ended", recordedAt: afterEnd.now.toISOString(), automation: "sprint-rollover",
      issues: [{ issueId: issues[0]!.id, status: "todo" }] } });
    expect(previous.closureRecord!.reason).toContain("2026-11-01T15:00:00.000Z");
    expect(previous.rolloverFrom).toBeNull();
    const successor = core.getSprint(f.db, previous.rolloverTo!.id);
    expect(successor).toMatchObject({ number: sprint.number + 1, name: `Sprint ${sprint.number + 1}`, phase: "active", startDate: "2026-11-02", endDate: "2026-11-08",
      timezone: tz, workingDays: [1, 3, 5], goal: null, definitionOfDone: null, adoptedPlanId: null, plans: [], activatedAt: afterEnd.now.toISOString(),
      rolloverFromSprintId: sprint.id, rolloverFrom: { id: sprint.id, number: sprint.number, name: sprint.name, phase: "ended" }, rolloverTo: null });
    expect(successor.items.map(i => [i.sourceIssueKey, i.member, i.rolloverFromItemId])).toEqual([[issues[0]!.id, true, previous.items.find(i => i.sourceIssueKey === issues[0]!.id)!.id]]);
    expect(previous.items.map(i => [i.sourceIssueKey, i.member])).toEqual([[issues[0]!.id, true], [issues[1]!.id, true]]);

    const current = core.resolveCurrentSprints(f.db, { clock: afterEnd });
    expect(current.sprints.map(s => s.id)).toEqual([successor.id]);
    expect(current.issues.map(i => i.id)).toEqual([issues[0]!.id]);
    expect(current.issues[0]!.sprints.map(s => s.id)).toEqual([sprint.id, successor.id]);
    expect(core.queryIssues(f.db, { sprint: successor.id }, afterEnd).issues.map(i => i.id)).toEqual([issues[0]!.id]);

    expect(results).toEqual([{ workspaceId: f.ws.id, workspaceKey: f.ws.key,
      ended: [{ id: sprint.id, number: sprint.number, name: sprint.name, phase: "ended" }],
      successors: [{ sprint: { id: successor.id, number: successor.number, name: successor.name, phase: "active" }, created: true }],
      started: [{ id: successor.id, number: successor.number, name: successor.name, phase: "active" }],
      carried: 1, blocked: null, error: null }]);
  } finally {
    f.db.close();
  }
});

const LEDGER = ["sprint_sessions", "sprint_execution_versions", "sprint_attempts", "sprint_operations", "sprint_execution_snapshots", "sprint_execution_quarantine",
  "sprint_notification_results", "sprint_notification_receptions", "sprint_notification_deliveries", "sprint_notification_conflicts", "sprint_notification_quarantine"];
const ledger = (db: Fixture["db"]) => LEDGER.map(table => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());

test("完了・中止・アーカイブ済み・候補だけのIssueは引き継がず、スヌーズ中・実行中は引き継ぎ、記録は自動処理のactorで残す", () => {
  const f = configured();
  try {
    const { sprint, issues } = activeSprint(f, ["中止", "アーカイブ", "スヌーズ中", "実行中", "完了"]);
    const [canceled, archived, snoozed, working, done] = issues;
    core.updateIssue(f.me, canceled!.id, { status: "canceled" });
    core.archiveIssue(f.me, archived!.id);
    core.updateIssue(f.me, snoozed!.id, { status: "triage" });
    core.snoozeTriage(f.me, snoozed!.id, "2999-01-01T00:00:00.000Z");
    core.updateIssue(f.me, working!.id, { status: "in_progress" });
    core.updateIssue(f.me, done!.id, { status: "done" });
    // 候補として登録しただけのitem（所属ではない）。公開操作では作れないため行を直接足す。
    const candidate = core.createIssue(f.me, { workspaceId: f.ws.id, title: "候補だけ" });
    f.db.query("INSERT INTO sprint_items(id,sprint_id,issue_id,source_issue_key,snapshot,origin) VALUES(?,?,?,?,'{}','candidate')")
      .run(crypto.randomUUID(), sprint.id, Number(candidate.id.split("-")[1]), candidate.id);
    // 前Sprintの実行台帳（予約・占有）。終了しても解放しない。
    const item = core.getSprint(f.db, sprint.id).items.find(i => i.sourceIssueKey === working!.id)!;
    f.db.query("INSERT INTO sprint_attempts VALUES(?,?,?,?,NULL,1,'{}')").run(crypto.randomUUID(), sprint.id, item.id, item.sourceIssueKey);
    f.db.query("INSERT INTO sprint_execution_versions VALUES(?,3)").run(sprint.id);
    const before = ledger(f.db);

    core.syncSprintRollover(f.db, afterEnd);

    const previous = core.getSprint(f.db, sprint.id);
    const successor = core.getSprint(f.db, previous.rolloverTo!.id);
    expect(successor.items.map(i => i.sourceIssueKey)).toEqual([snoozed!.id, working!.id].sort());
    expect(successor.items.every(i => i.member && i.association === "added" && i.addedBy === core.SPRINT_ROLLOVER_ACTOR)).toBe(true);
    expect(core.SPRINT_ROLLOVER_ACTOR).not.toBe(f.me.actor);
    expect(core.SPRINT_ROLLOVER_ACTOR).not.toBe(f.llm.actor);
    // 終了記録の対象（アーカイブ済みを含むか）は手動終了と共通の記録に従う。ここでは引き継いだIssueが残件に入ることだけを見る。
    expect(previous.closureRecord!.issues.map(i => i.issueId)).toEqual(expect.arrayContaining([snoozed!.id, working!.id]));
    expect(core.getIssue(f.db, working!.id).status).toBe("in_progress");
    expect(core.getIssue(f.db, snoozed!.id).sprints.map(s => s.id)).toEqual([sprint.id, successor.id]);
    expect(eventsOf(f.db, working!.id).filter(e => e.type === "sprint_added").at(-1)).toEqual({ type: "sprint_added", actor: core.SPRINT_ROLLOVER_ACTOR,
      data: { sprintId: successor.id, sprintNumber: successor.number, sprintName: successor.name, automation: "sprint-rollover",
        fromSprintId: sprint.id, fromSprintNumber: sprint.number, fromSprintName: sprint.name } });
    // 人の合意の記録を作らない。前Sprintの計画と合意もそのまま。
    expect(successor.plans).toEqual([]);
    expect(successor.activatedBy).toBe(core.SPRINT_ROLLOVER_ACTOR);
    expect(previous.plans).toEqual(core.getSprint(f.db, sprint.id).plans);
    expect(previous.plans.map(p => p.agreedBy)).toEqual(["me"]);
    expect(ledger(f.db)).toEqual(before);
  } finally {
    f.db.close();
  }
});

test("同期を何度呼んでも、処理後にIssueを再オープンしてから呼んでも、後継と所属は増えず、処理対象が無ければtransactionを開かない", () => {
  const f = configured();
  try {
    const { sprint, issues } = activeSprint(f, ["未完了", "完了"]);
    core.updateIssue(f.me, issues[1]!.id, { status: "done" });
    const transaction = spyOn(f.db, "transaction");
    try {
      expect(core.syncSprintRollover(f.db, duringFirst)).toEqual([]);
      expect(transaction).not.toHaveBeenCalled();
    } finally { transaction.mockRestore(); }

    core.syncSprintRollover(f.db, afterEnd);
    const sprints = core.listSprints(f.db);
    const successor = core.getSprint(f.db, core.getSprint(f.db, sprint.id).rolloverTo!.id);
    core.updateIssue(f.me, issues[1]!.id, { status: "todo" });
    const again = spyOn(f.db, "transaction");
    try {
      expect(core.syncSprintRollover(f.db, afterEnd)).toEqual([]);
      expect(core.syncSprintRollover(f.db, at("2026-11-05T00:00:00.000Z"))).toEqual([]);
      expect(again).not.toHaveBeenCalled();
    } finally { again.mockRestore(); }
    expect(core.listSprints(f.db)).toEqual(sprints);
    expect(core.getSprint(f.db, successor.id).items).toEqual(successor.items);
    expect(core.getIssue(f.db, issues[1]!.id).sprints.map(s => s.id)).toEqual([sprint.id]);
  } finally {
    f.db.close();
  }
});

const linkOf = (s: core.SprintLink): core.SprintLink => ({ id: s.id, number: s.number, name: s.name, phase: s.phase });

test("人が用意した未来のdraftを後継に選び、開始待ちにして、期間を変えたら変更後の期間の開始以降に開始する", () => {
  const f = configured();
  try {
    const { sprint, issues } = activeSprint(f, ["未完了"]);
    const prepared = core.createSprint(f.llm, { workspaceKey: f.ws.key, name: "用意した次", startDate: "2026-11-05", endDate: "2026-11-18", timezone: tz, expectedVersion: 0, requestKey: "次を用意" });

    const first = core.syncSprintRollover(f.db, afterEnd);
    expect(first[0]).toMatchObject({ successors: [{ sprint: { id: prepared.id, name: "用意した次", phase: "draft" }, created: false }], started: [], carried: 1 });
    expect(core.listSprints(f.db).map(s => s.id)).toEqual([sprint.id, prepared.id]);
    let successor = core.getSprint(f.db, prepared.id);
    expect(successor).toMatchObject({ phase: "draft", rolloverFromSprintId: sprint.id, activatedAt: null, startDate: "2026-11-05" });
    expect(successor.items.map(i => i.sourceIssueKey)).toEqual([issues[0]!.id]);
    expect(core.resolveCurrentSprints(f.db, { clock: afterEnd }).sprints).toEqual([]);

    const moved = core.updateSprint(f.me, prepared.id, { expectedVersion: successor.version, requestKey: "後ろへ", startDate: "2026-11-07", endDate: "2026-11-20" });
    expect(core.syncSprintRollover(f.db, at("2026-11-05T00:00:00.000Z"))).toEqual([]);
    const started = core.syncSprintRollover(f.db, at("2026-11-07T00:00:00.000Z"));
    successor = core.getSprint(f.db, prepared.id);
    expect(started[0]).toMatchObject({ ended: [], successors: [], started: [linkOf(successor)], carried: 0 });
    expect(successor).toMatchObject({ phase: "active", activatedAt: "2026-11-07T00:00:00.000Z", rolloverFromSprintId: sprint.id, startDate: moved.startDate, endDate: "2026-11-20" });
    expect(successor.items.map(i => i.sourceIssueKey)).toEqual([issues[0]!.id]);
  } finally {
    f.db.close();
  }
});

test("人が合意した計画を持つreadyの後継は、計画と採択を保ったまま自動で開始する", () => {
  const f = configured();
  try {
    const { sprint, issues } = activeSprint(f, ["引き継ぐ"]);
    const next = core.createSprint(f.llm, { workspaceKey: f.ws.key, startDate: "2026-11-02", endDate: "2026-11-08", timezone: tz, expectedVersion: 0, requestKey: "次" });
    const planned = core.createIssue(f.me, { workspaceId: f.ws.id, title: "計画した" });
    const added = core.addIssueToSprint(f.llm, next.id, { issueRef: planned.id });
    const proposed = core.proposeSprintPlan(f.llm, next.id, { expectedVersion: added.sprint.version, requestKey: "次計画", goal: "次のゴール", verificationMethod: "確認",
      items: [{ itemId: added.item.id, contribution: "貢献", executionPlan: "進め方" }], definitionOfDone: [{ id: "次", text: "次の完成" }],
      constraints: { executionScope: "WS", maxParallel: 1, notes: "なし" }, changeReason: "提案" });
    const ready = core.acceptSprintPlan(f.me, next.id, proposed.plan.id, { expectedVersion: proposed.sprint.version, requestKey: "次合意", contentHash: proposed.plan.contentHash });
    const plansBefore = core.getSprint(f.db, next.id).plans;

    core.syncSprintRollover(f.db, afterEnd);

    const successor = core.getSprint(f.db, next.id);
    expect(successor).toMatchObject({ phase: "active", adoptedPlanId: ready.plan.id, goal: "次のゴール", rolloverFromSprintId: sprint.id, activatedBy: core.SPRINT_ROLLOVER_ACTOR });
    expect(successor.plans).toEqual(plansBefore);
    expect(successor.items.map(i => [i.sourceIssueKey, i.member]).sort()).toEqual([[issues[0]!.id, true], [planned.id, true]].sort());
    expect(core.resolveCurrentSprints(f.db, { clock: afterEnd }).issues.map(i => i.id).sort()).toEqual([issues[0]!.id, planned.id].sort());
  } finally {
    f.db.close();
  }
});

test("複数の期間を飛ばした時計では、処理時点を含む期間の後継だけを1件作る", () => {
  const f = configured();
  try {
    const { sprint, issues } = activeSprint(f, ["未完了"]);
    // 11-02〜08、11-09〜15、11-16〜22 を飛ばし、Tokyoの11-25を含む 11-23〜29 を作る。
    const results = core.syncSprintRollover(f.db, at("2026-11-25T03:00:00.000Z"));
    expect(core.listSprints(f.db).length).toBe(2);
    const successor = core.getSprint(f.db, core.getSprint(f.db, sprint.id).rolloverTo!.id);
    expect(successor).toMatchObject({ phase: "active", startDate: "2026-11-23", endDate: "2026-11-29", startsAt: "2026-11-22T15:00:00.000Z" });
    expect(results[0]).toMatchObject({ ended: [linkOf(core.getSprint(f.db, sprint.id))], successors: [{ created: true }], started: [linkOf(successor)], carried: 1 });
    expect(successor.items.map(i => i.sourceIssueKey)).toEqual([issues[0]!.id]);
  } finally {
    f.db.close();
  }
});

test("結んだ未来の後継が丸ごと過ぎていたら、開始せずに終了し、さらに次の後継へ引き継ぐ", () => {
  const f = configured();
  try {
    const { sprint, issues } = activeSprint(f, ["未完了"]);
    core.syncSprintRollover(f.db, at("2026-11-01T14:00:00.000Z"));
    expect(core.getSprint(f.db, sprint.id).phase).toBe("active");
    // 期限直後の契機で後継（11-02〜08）を作って開始する前に止まった状態を、未来の後継を結ぶことで作る。
    const prepared = core.createSprint(f.llm, { workspaceKey: f.ws.key, startDate: "2026-11-03", endDate: "2026-11-04", timezone: tz, expectedVersion: 0, requestKey: "短い次" });
    core.syncSprintRollover(f.db, at("2026-11-02T00:00:00.000Z"));
    expect(core.getSprint(f.db, prepared.id)).toMatchObject({ phase: "draft", rolloverFromSprintId: sprint.id });

    const results = core.syncSprintRollover(f.db, at("2026-11-10T00:00:00.000Z"));

    const skipped = core.getSprint(f.db, prepared.id);
    expect(skipped).toMatchObject({ phase: "ended", activatedAt: null, closureRecord: { kind: "ended", automation: "sprint-rollover", issues: [{ issueId: issues[0]!.id }] } });
    const next = core.getSprint(f.db, skipped.rolloverTo!.id);
    // 2日の長さで 11-05 から区切り、Tokyoの11-10を含む 11-09〜10。
    expect(next).toMatchObject({ phase: "active", startDate: "2026-11-09", endDate: "2026-11-10", rolloverFromSprintId: prepared.id });
    expect(next.items.map(i => [i.sourceIssueKey, i.rolloverFromItemId])).toEqual([[issues[0]!.id, skipped.items[0]!.id]]);
    expect(results[0]).toMatchObject({ ended: [linkOf(skipped)], successors: [{ sprint: linkOf(next), created: true }], started: [linkOf(next)], carried: 1 });
    expect(core.getIssue(f.db, issues[0]!.id).sprints.map(s => s.id)).toEqual([sprint.id, prepared.id, next.id]);
  } finally {
    f.db.close();
  }
});

test("作る後継の期間が連鎖外のSprintと重なるときは、Workspaceを変えずに止まり、状態の表示に理由を出す", () => {
  const f = configured();
  try {
    const { sprint } = activeSprint(f, ["未完了"]);
    // 人が作って開始しなかった、期限切れのdraft。
    const stale = core.createSprint(f.llm, { workspaceKey: f.ws.key, name: "置き去り", startDate: "2026-11-02", endDate: "2026-11-03", timezone: tz, expectedVersion: 0, requestKey: "置き去り" });
    const clock = at("2026-11-05T00:00:00.000Z");
    expect(core.getSprintRolloverStatus(f.db, f.ws.key, duringFirst)).toEqual({ workspaceKey: f.ws.key, enabled: true, scrumEnabled: true,
      nextRunAt: sprint.endsAt, successor: { kind: "existing", sprint: linkOf(stale) }, blocked: null });
    const before = { sprints: core.listSprints(f.db), previous: core.getSprint(f.db, sprint.id) };

    const results = core.syncSprintRollover(f.db, clock);

    expect(results).toEqual([{ workspaceId: f.ws.id, workspaceKey: f.ws.key, ended: [], successors: [], started: [], carried: 0,
      blocked: { code: "SPRINT_ROLLOVER_BLOCKED", message: expect.stringContaining(`Sprint ${stale.number}「置き去り」`) }, error: null }]);
    expect(core.listSprints(f.db)).toEqual(before.sprints);
    expect(core.getSprint(f.db, sprint.id)).toEqual(before.previous);
    const status = core.getSprintRolloverStatus(f.db, f.ws.key, clock);
    expect(status).toEqual({ workspaceKey: f.ws.key, enabled: true, scrumEnabled: true, nextRunAt: sprint.endsAt,
      successor: { kind: "create", startDate: "2026-11-02", endDate: "2026-11-08", timezone: tz }, blocked: results[0]!.blocked });
    // 読取は変更を行わない。
    expect(core.listSprints(f.db)).toEqual(before.sprints);

    core.cancelSprint(f.me, stale.id, { expectedVersion: stale.version, requestKey: "片付け", reason: "使わない" });
    expect(core.syncSprintRollover(f.db, clock)[0]).toMatchObject({ blocked: null, successors: [{ created: true }] });
  } finally {
    f.db.close();
  }
});

test("自動処理が結んだ後継を人が中止したら連鎖を止め、代わりを作らず、状態の表示に理由を出す", () => {
  const f = configured();
  try {
    const { sprint, issues } = activeSprint(f, ["未完了"]);
    core.syncSprintRollover(f.db, afterEnd);
    const successor = core.getSprint(f.db, core.getSprint(f.db, sprint.id).rolloverTo!.id);
    expect(core.getSprintRolloverStatus(f.db, f.ws.key, afterEnd)).toMatchObject({ nextRunAt: successor.endsAt, blocked: null,
      successor: { kind: "create", startDate: "2026-11-09", endDate: "2026-11-15" } });
    core.cancelSprint(f.me, successor.id, { expectedVersion: successor.version, requestKey: "中止", reason: "流れを止める" }, afterEnd);
    const sprints = core.listSprints(f.db);

    expect(core.syncSprintRollover(f.db, at("2026-11-20T00:00:00.000Z"))).toEqual([]);

    expect(core.listSprints(f.db)).toEqual(sprints);
    expect(core.getSprint(f.db, successor.id).items.map(i => i.sourceIssueKey)).toEqual([issues[0]!.id]);
    expect(core.getSprintRolloverStatus(f.db, f.ws.key, at("2026-11-20T00:00:00.000Z"))).toEqual({ workspaceKey: f.ws.key, enabled: true, scrumEnabled: true,
      nextRunAt: null, successor: null, blocked: { code: "SPRINT_ROLLOVER_CHAIN_STOPPED", message: expect.stringContaining(`Sprint ${successor.number}`) } });
  } finally {
    f.db.close();
  }
});

test("自動引継ぎの設定は人だけが変えられ、無効やSprint運用の無効では何も変わらず、有効に戻すと期限切れのactiveだけを処理する", () => {
  const f = configured();
  try {
    expect(core.getScrumWorkspace(f.db, f.ws.key)).toMatchObject({ autoRollover: true, version: 1 });
    expect(codeOf(() => core.setSprintRollover(f.llm, f.ws.key, { enabled: false }))).toBe("FORBIDDEN_FOR_LLM");
    expect(codeOf(() => core.setSprintRollover(f.me, f.ws.key, { enabled: "no" } as any))).toBe("INVALID_ARGS");
    // 設定の値だけを変え、Scrum設定の版は上げない。
    expect(core.setSprintRollover(f.me, f.ws.key, { enabled: false })).toMatchObject({ autoRollover: false, version: 1, enabled: true });
    expect(core.getSprintRolloverStatus(f.db, f.ws.key, afterEnd)).toMatchObject({ enabled: false, blocked: { code: "SPRINT_ROLLOVER_DISABLED" } });

    // 無効の間に手で終了したSprintには後継を作らない。
    const old = activeSprint(f, ["過去に残った"]).sprint;
    core.endSprint(f.me, old.id, { expectedVersion: old.version, requestKey: "手で終了", reason: "期間終了" }, afterEnd);
    const { sprint, issues } = activeSprint(f, ["期限切れに残った"], { startDate: "2026-11-02", endDate: "2026-11-08" });
    const later = at("2026-11-10T00:00:00.000Z");
    const before = core.listSprints(f.db);
    expect(core.syncSprintRollover(f.db, later)).toEqual([]);
    core.configureScrumWorkspace(f.me, f.ws.key, { expectedVersion: 1, requestKey: "運用停止", enabled: false, problem: "停滞", productGoal: "開発を進める", priorityRationale: "判断を優先" });
    core.setSprintRollover(f.me, f.ws.key, { enabled: true });
    expect(core.getScrumWorkspace(f.db, f.ws.key)).toMatchObject({ autoRollover: true, enabled: false });
    expect(core.syncSprintRollover(f.db, later)).toEqual([]);
    expect(core.getSprintRolloverStatus(f.db, f.ws.key, later)).toMatchObject({ scrumEnabled: false, blocked: { code: "SCRUM_DISABLED" } });
    expect(core.listSprints(f.db)).toEqual(before);

    core.configureScrumWorkspace(f.me, f.ws.key, { expectedVersion: 2, requestKey: "運用再開", enabled: true, problem: "停滞", productGoal: "開発を進める", priorityRationale: "判断を優先" });
    const results = core.syncSprintRollover(f.db, later);

    expect(results[0]).toMatchObject({ ended: [{ id: sprint.id }], successors: [{ created: true }], carried: 1 });
    expect(core.getSprint(f.db, old.id)).toMatchObject({ phase: "ended", rolloverTo: null });
    expect(core.getSprint(f.db, core.getSprint(f.db, sprint.id).rolloverTo!.id)).toMatchObject({ phase: "active", startDate: "2026-11-09",
      items: [{ sourceIssueKey: issues[0]!.id }] });
  } finally {
    f.db.close();
  }
});

test("Sprint運用の方向設定が無いWorkspaceでは自動引継ぎの設定を変えられない", () => {
  const f = setup();
  try {
    expect(core.getScrumWorkspace(f.db, f.ws.key).autoRollover).toBe(true);
    expect(codeOf(() => core.setSprintRollover(f.me, f.ws.key, { enabled: false }))).toBe("INVALID_STATE");
    expect(codeOf(() => core.setSprintRollover(f.me, "NOPE", { enabled: false }))).toBe("NOT_FOUND");
  } finally {
    f.db.close();
  }
});

test("期限後に人が手で終了すると、同じtransactionで自動処理と同じ後継決定・引継ぎ・開始を行い、再送には保存済みの結果を返す", () => {
  const f = configured();
  try {
    const { sprint, issues } = activeSprint(f, ["未完了"]);
    const input = { expectedVersion: sprint.version, requestKey: "手で終了", reason: "期間が終わった" };
    const ended = core.endSprint(f.me, sprint.id, input, afterEnd);

    const previous = core.getSprint(f.db, sprint.id);
    expect(previous.closureRecord).toEqual({ kind: "ended", recordedAt: afterEnd.now.toISOString(), reason: "期間が終わった", issues: [{ issueId: issues[0]!.id, status: "todo" }], questions: [] });
    const successor = core.getSprint(f.db, previous.rolloverTo!.id);
    expect(successor).toMatchObject({ phase: "active", startDate: "2026-11-02", endDate: "2026-11-08", activatedBy: core.SPRINT_ROLLOVER_ACTOR, rolloverFromSprintId: sprint.id,
      items: [{ sourceIssueKey: issues[0]!.id, addedBy: core.SPRINT_ROLLOVER_ACTOR, member: true }] });
    expect(eventsOf(f.db, issues[0]!.id).filter(e => e.type === "sprint_added").map(e => e.actor)).toEqual([f.llm.actor, core.SPRINT_ROLLOVER_ACTOR]);
    expect(core.endSprint(f.me, sprint.id, input, afterEnd)).toEqual(ended);
    expect(core.listSprints(f.db).length).toBe(2);
  } finally {
    f.db.close();
  }
});

test("後継の処理が失敗する条件では手動終了も確定させず、失敗を返す", () => {
  const f = configured();
  try {
    const { sprint } = activeSprint(f, ["未完了"]);
    core.createSprint(f.llm, { workspaceKey: f.ws.key, name: "置き去り", startDate: "2026-11-02", endDate: "2026-11-03", timezone: tz, expectedVersion: 0, requestKey: "置き去り" });
    const before = { sprints: core.listSprints(f.db), previous: core.getSprint(f.db, sprint.id) };
    const input = { expectedVersion: sprint.version, requestKey: "手で終了", reason: "期間が終わった" };

    expect(codeOf(() => core.endSprint(f.me, sprint.id, input, at("2026-11-05T00:00:00.000Z")))).toBe("SPRINT_ROLLOVER_BLOCKED");

    expect(core.listSprints(f.db)).toEqual(before.sprints);
    expect(core.getSprint(f.db, sprint.id)).toEqual(before.previous);
  } finally {
    f.db.close();
  }
});

test("自動処理で終了したSprintへの手動終了は、後継が分かる理由で拒否し、終了記録を上書きしない", () => {
  const f = configured();
  try {
    const { sprint } = activeSprint(f, ["未完了"]);
    core.syncSprintRollover(f.db, afterEnd);
    const previous = core.getSprint(f.db, sprint.id);
    const successor = previous.rolloverTo!;
    let error: { code?: string; message?: string } = {};
    try { core.endSprint(f.me, sprint.id, { expectedVersion: previous.version, requestKey: "後から終了", reason: "手で区切る" }, afterEnd); } catch (e) { error = e as typeof error; }
    expect(error.code).toBe("INVALID_STATE");
    expect(error.message).toContain("自動処理で終了");
    expect(error.message).toContain(`Sprint ${successor.number}「${successor.name}」`);
    expect(core.getSprint(f.db, sprint.id)).toEqual(previous);
  } finally {
    f.db.close();
  }
});

test("中止では後継を作らない", () => {
  const f = configured();
  try {
    const { sprint } = activeSprint(f, ["未完了"]);
    core.cancelSprint(f.me, sprint.id, { expectedVersion: sprint.version, requestKey: "中止", reason: "やめる" }, afterEnd);
    expect(core.syncSprintRollover(f.db, afterEnd)).toEqual([]);
    expect(core.listSprints(f.db).map(s => [s.id, s.phase])).toEqual([[sprint.id, "canceled"]]);
    expect(core.getSprint(f.db, sprint.id).rolloverTo).toBeNull();
  } finally {
    f.db.close();
  }
});

test("止まったWorkspaceは無変更に戻し、他のWorkspaceの処理は続ける", () => {
  const f = configured();
  try {
    const blocked = activeSprint(f, ["止まる側"]).sprint;
    core.createSprint(f.llm, { workspaceKey: f.ws.key, name: "置き去り", startDate: "2026-11-02", endDate: "2026-11-03", timezone: tz, expectedVersion: 0, requestKey: "置き去り" });
    const other = core.initWorkspace(f.db, { key: "BBB", name: "別Workspace", path: "/tmp/repos/bbb" }).workspace;
    core.configureScrumWorkspace(f.me, other.key, { expectedVersion: 0, requestKey: "設定", enabled: true, problem: "別", productGoal: "別", priorityRationale: "別" });
    const g = { ...f, ws: other };
    const moving = activeSprint(g, ["進む側"]).sprint;

    const results = core.syncSprintRollover(f.db, at("2026-11-05T00:00:00.000Z"));

    expect(results.map(r => [r.workspaceKey, r.blocked?.code ?? null, r.ended.map(s => s.id)])).toEqual([[f.ws.key, "SPRINT_ROLLOVER_BLOCKED", []], [other.key, null, [moving.id]]]);
    expect(core.getSprint(f.db, blocked.id)).toMatchObject({ phase: "active", rolloverTo: null });
    expect(core.getSprint(f.db, moving.id).rolloverTo).not.toBeNull();
  } finally {
    f.db.close();
  }
});
