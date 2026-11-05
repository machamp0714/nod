import type { Database } from "bun:sqlite";
import { isLlm, now, type OpCtx } from "../ctx";
import { tx } from "../db";
import { NodError, toNodError } from "../errors";
import { recordEvent } from "../events";
import { formatIssueId, issueRowById } from "../issue-query";
import { SPRINT_ITEM_MEMBER } from "../sprint-membership";
import type { Sprint, SprintClock, SprintClosureRecord, SprintItem, SprintLink } from "../sprint-types";
import { invalidSprint, sprintObject, sprintPeriod } from "../sprint-validation";
import { saveSprintClosure } from "./sprint-closure";
import { getScrumWorkspace, type ScrumWorkspace } from "./sprint-planning";
import { nextSprintNumber, readSprintItems, resolveSprint } from "./sprints";
import { findWorkspace } from "./workspaces";

// 期限到来時の自動引継ぎ。人専用の公開操作を通らず、自動処理専用の状態遷移で行う。
// 記録上の主体は固定の自動処理actorにし、me や契機を起こした呼出し元の名前で記録しない。
export const SPRINT_ROLLOVER_ACTOR = "nod-automation";
export const SPRINT_ROLLOVER_AUTOMATION = "sprint-rollover" as const;
const BLOCKED = "SPRINT_ROLLOVER_BLOCKED";
// 対象が無くなるまで順に処理する。壊れたデータで無限に回らないための上限。
const MAX_STEPS = 100;

export interface SprintRolloverResult {
  workspaceId: number;
  workspaceKey: string;
  ended: SprintLink[];
  successors: { sprint: SprintLink; created: boolean }[];
  started: SprintLink[];
  carried: number;
  // 期間の重なりなどで止まった理由。Workspaceは無変更のまま、次の契機で再試行する。
  blocked: { code: string; message: string } | null;
  // 想定外の失敗。Workspaceは無変更のまま、呼出し側が警告として出す。
  error: { code: string; message: string } | null;
}

interface Progress { ended: string[]; successors: { id: string; created: boolean }[]; started: string[]; carried: number }
const emptyProgress = (): Progress => ({ ended: [], successors: [], started: [], carried: 0 });

function instantOf(clock: SprintClock): Date {
  const instant = clock.now ?? new Date();
  if (!Number.isFinite(instant.getTime())) invalidSprint("時計の時刻が不正です");
  return instant;
}
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86400000).toISOString().slice(0, 10);
}
function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86400000);
}
function localDate(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
}
function link(sprint: Sprint): SprintLink {
  return { id: sprint.id, number: sprint.number, name: sprint.name, phase: sprint.phase };
}
function sprintById(db: Database, sql: string, ...params: (string | number)[]): Sprint | null {
  const row = db.query(sql).get(...params) as { id: string } | null;
  return row ? resolveSprint(db, row.id) : null;
}

// 自動処理が結んだ後継のうち、まだ開始していないもの（s=sprints）。
const CHAINED_UNSTARTED = `s.phase IN ('draft','ready') AND s.rollover_from_sprint_id IS NOT NULL`;
// 処理対象（期限切れのactive、期限切れの未開始の後継、開始待ちの後継）がある行。
const DUE = `((s.phase='active' AND julianday(s.ends_at)<=julianday(?))
  OR (${CHAINED_UNSTARTED} AND (julianday(s.ends_at)<=julianday(?)
    OR (julianday(s.starts_at)<=julianday(?) AND NOT EXISTS (SELECT 1 FROM sprints a WHERE a.workspace_id=s.workspace_id AND a.phase='active')))))`;
const ENABLED = `c.enabled=1 AND c.auto_rollover=1`;

function rolloverEnabled(db: Database, workspaceId: number): boolean {
  return !!db.query(`SELECT 1 FROM scrum_workspaces c WHERE c.workspace_id=? AND ${ENABLED}`).get(workspaceId);
}

type SuccessorDecision =
  | { kind: "linked" | "existing"; sprint: Sprint }
  // overlapがあれば作らずに止まる（期間をずらす・縮める・既存を中止することはしない）。
  | { kind: "create"; period: ReturnType<typeof sprintPeriod>; overlap: NodError | null };

// 後継の決定。書込みをしないので状態の表示からも使う。
// 1) 既に結んだ後継（選び直さない） 2) 前Sprintの終了以降に始まりまだ終わっていない連鎖外のdraft/ready
// 3) 前Sprintと同じ長さで翌日から区切り、処理時点を含む区間を新しく作る（間の空のSprintは作らない）。
function decideSuccessor(db: Database, previous: Sprint, instant: Date): SuccessorDecision {
  const linked = sprintById(db, "SELECT id FROM sprints WHERE rollover_from_sprint_id=?", previous.id);
  if (linked) return { kind: "linked", sprint: linked };
  const existing = sprintById(db, `SELECT id FROM sprints WHERE workspace_id=? AND phase IN ('draft','ready') AND rollover_from_sprint_id IS NULL
    AND id<>? AND julianday(starts_at)>=julianday(?) AND julianday(ends_at)>julianday(?) ORDER BY julianday(starts_at),number LIMIT 1`,
    previous.workspaceId!, previous.id, previous.endsAt!, instant.toISOString());
  if (existing) return { kind: "existing", sprint: existing };
  const timezone = previous.timezone!;
  const length = dayDiff(previous.startDate, previous.endDate) + 1;
  const first = addDays(previous.endDate, 1);
  const start = addDays(first, Math.max(0, Math.floor(dayDiff(first, localDate(instant, timezone)) / length)) * length);
  const period = sprintPeriod(start, addDays(start, length - 1), timezone);
  const overlap = db.query(`SELECT number,name FROM sprints WHERE workspace_id=? AND phase NOT IN ('imported','canceled')
    AND julianday(starts_at)<julianday(?) AND julianday(ends_at)>julianday(?) ORDER BY number LIMIT 1`)
    .get(previous.workspaceId!, period.endsAt, period.startsAt) as { number: number; name: string } | null;
  return { kind: "create", period, overlap: overlap && new NodError("SPRINT_ROLLOVER_BLOCKED",
    `作成する後継の期間（${period.startDate}〜${period.endDate}）が Sprint ${overlap.number}「${overlap.name}」と重なるため、自動引継ぎを止めています。重なるSprintの期間を変えるか中止してください`) };
}

function createSuccessor(db: Database, previous: Sprint, period: ReturnType<typeof sprintPeriod>): Sprint {
  const ws = db.query("SELECT id,key,name FROM workspaces WHERE id=?").get(previous.workspaceId!) as { id: number; key: string; name: string };
  const id = crypto.randomUUID(), number = nextSprintNumber(db), timestamp = now();
  // ゴール・完成の定義・計画は前Sprintから写さず未設定にする。
  db.query(`INSERT INTO sprints(id,number,workspace_id,name,phase,start_date,end_date,timezone,starts_at,ends_at,created_at,updated_at,version,working_days,workspace_snapshot,rollover_from_sprint_id)
    VALUES(?,?,?,?,'draft',?,?,?,?,?,?,?,1,?,?,?)`).run(id, number, ws.id, `Sprint ${number}`, period.startDate, period.endDate, period.timezone,
    period.startsAt, period.endsAt, timestamp, timestamp, JSON.stringify(previous.workingDays), JSON.stringify(ws), previous.id);
  return resolveSprint(db, id);
}

// 前Sprintの所属Issueのうち、処理時点で完了・中止でないものを後継の所属（直接所属）にする。
// 候補だけのIssue、アーカイブ・削除済みのIssueは含めない。前Sprintの所属と終了記録はそのまま残す。
function carryOver(db: Database, previous: Sprint, successor: Sprint, instant: Date): number {
  const rows = db.query(`SELECT si.id AS itemId,i.id AS issueId FROM sprint_items si JOIN sprints s ON s.id=si.sprint_id JOIN issues i ON i.id=si.issue_id
    WHERE s.id=? AND ${SPRINT_ITEM_MEMBER} AND i.status NOT IN ('done','canceled') AND i.archived_at IS NULL AND i.workspace_id=s.workspace_id
    ORDER BY i.id`).all(previous.id) as { itemId: string; issueId: number }[];
  const items = readSprintItems(db, successor.id), addedAt = instant.toISOString();
  let carried = 0;
  for (const row of rows) {
    const issue = issueRowById(db, row.issueId), sourceIssueKey = formatIssueId(issue.ws_key, issue.number);
    const existing = items.find(item => item.sourceIssueKey === sourceIssueKey);
    // 既に所属していれば何もしない。別のIssueに使われた番号のitemへはつながない。
    if (existing && (existing.member || existing.issueId !== issue.id)) continue;
    if (existing) {
      db.query("UPDATE sprint_items SET added_by=?,added_at=?,rollover_from_item_id=? WHERE id=?").run(SPRINT_ROLLOVER_ACTOR, addedAt, row.itemId, existing.id);
    } else {
      const workspace = db.query("SELECT id,key,name FROM workspaces WHERE id=?").get(issue.workspace_id) as { id: number; key: string; name: string };
      const snapshot: SprintItem["snapshot"] = { schemaVersion: 1, capturedAt: addedAt, statusBasis: "candidate_snapshot", workspace, issue: { ...issue },
        labels: (db.query("SELECT label FROM issue_labels WHERE issue_id=? ORDER BY label").all(issue.id) as { label: string }[]).map(r => r.label),
        project: issue.project_id === null ? null : db.query("SELECT * FROM projects WHERE id=?").get(issue.project_id) as Record<string, unknown> | null };
      db.query(`INSERT INTO sprint_items(id,sprint_id,issue_id,source_issue_key,snapshot,origin,added_by,added_at,rollover_from_item_id)
        VALUES(?,?,?,?,?,'candidate',?,?,?)`).run(crypto.randomUUID(), successor.id, issue.id, sourceIssueKey, JSON.stringify(snapshot), SPRINT_ROLLOVER_ACTOR, addedAt, row.itemId);
    }
    recordEvent(db, issue.id, SPRINT_ROLLOVER_ACTOR, "sprint_added", { sprintId: successor.id, sprintNumber: successor.number, sprintName: successor.name,
      automation: SPRINT_ROLLOVER_AUTOMATION, fromSprintId: previous.id, fromSprintNumber: previous.number, fromSprintName: previous.name });
    carried++;
  }
  return carried;
}

// 前Sprintの後継を決めて結び、未完了の所属を引き継ぐ。前Sprintの終了と同じtransactionで呼ぶ。
function succeed(db: Database, previous: Sprint, instant: Date, progress: Progress): void {
  const decision = decideSuccessor(db, previous, instant);
  let successor: Sprint;
  if (decision.kind === "create") {
    if (decision.overlap) throw decision.overlap;
    successor = createSuccessor(db, previous, decision.period);
  } else {
    successor = decision.sprint;
    if (decision.kind === "existing") {
      db.query("UPDATE sprints SET rollover_from_sprint_id=?,version=version+1,updated_at=? WHERE id=?").run(previous.id, now(), successor.id);
    }
  }
  progress.successors.push({ id: successor.id, created: decision.kind === "create" });
  progress.carried += carryOver(db, previous, successor, instant);
}

// 自動処理による終了。終了記録は処理時点の状態で残し、開始していないSprintに開始時刻を作らない。
// Sprint実行台帳（試行・予約・占有・セッション・通知）は変えない。
function endAutomatically(db: Database, sprint: Sprint, instant: Date): void {
  db.query("UPDATE sprints SET phase='ended',version=version+1,updated_at=? WHERE id=?").run(now(), sprint.id);
  saveSprintClosure(db, sprint.id, "ended", `自動処理による終了（期間の終了時刻: ${sprint.endsAt}）`, instant.toISOString(), SPRINT_ROLLOVER_AUTOMATION);
}

// 人の合意済み計画を要求も作成もせずに開始する。合意済み計画を持つreadyなら計画と採択はそのまま残る。
function startAutomatically(db: Database, sprint: Sprint, instant: Date): void {
  db.query("UPDATE sprints SET phase='active',activated_at=?,activated_by=?,version=version+1,updated_at=? WHERE id=?")
    .run(instant.toISOString(), SPRINT_ROLLOVER_ACTOR, now(), sprint.id);
}

// 1 Workspaceの処理対象が無くなるまで順に処理する。呼出し元のtransactionの中で呼ぶ。
function advanceWorkspace(db: Database, workspaceId: number, instant: Date, progress: Progress): Progress {
  const iso = instant.toISOString();
  for (let step = 0; step < MAX_STEPS; step++) {
    const active = sprintById(db, "SELECT id FROM sprints WHERE workspace_id=? AND phase='active'", workspaceId);
    const expired = active && julianLte(db, active.endsAt!, iso) ? active
      : sprintById(db, `SELECT s.id FROM sprints s WHERE s.workspace_id=? AND ${CHAINED_UNSTARTED} AND julianday(s.ends_at)<=julianday(?)
        ORDER BY julianday(s.starts_at),s.number LIMIT 1`, workspaceId, iso);
    if (expired) {
      endAutomatically(db, expired, instant);
      progress.ended.push(expired.id);
      succeed(db, expired, instant, progress);
      continue;
    }
    const pending = active ? null : sprintById(db, `SELECT s.id FROM sprints s WHERE s.workspace_id=? AND ${CHAINED_UNSTARTED}
      AND julianday(s.starts_at)<=julianday(?) ORDER BY julianday(s.starts_at),s.number LIMIT 1`, workspaceId, iso);
    if (!pending) return progress;
    startAutomatically(db, pending, instant);
    progress.started.push(pending.id);
  }
  throw new NodError("SPRINT_ROLLOVER_LOOP", "自動引継ぎの処理対象が収束しません");
}
function julianLte(db: Database, a: string, b: string): boolean {
  return (db.query("SELECT julianday(?)<=julianday(?) AS lte").get(a, b) as { lte: number }).lte === 1;
}

// 期限到来時の自動引継ぎを全Workspaceについて行う。処理対象が無ければ書込みのtransactionを始めない。
// Workspaceごとに独立したtransactionで条件を調べ直し、失敗したWorkspaceは無変更に戻して他を続ける。
// 例外は投げず、止まった理由と失敗は結果に入れる（呼出し側が警告として出す）。
export function syncSprintRollover(db: Database, clock: SprintClock = {}): SprintRolloverResult[] {
  const instant = instantOf(clock), iso = instant.toISOString();
  const targets = db.query(`SELECT DISTINCT w.id,w.key FROM sprints s JOIN workspaces w ON w.id=s.workspace_id
    JOIN scrum_workspaces c ON c.workspace_id=w.id WHERE ${ENABLED} AND ${DUE} ORDER BY w.id`).all(iso, iso, iso) as { id: number; key: string }[];
  return targets.map(ws => {
    let progress = emptyProgress(), blocked: SprintRolloverResult["blocked"] = null, error: SprintRolloverResult["error"] = null;
    try {
      const run = db.transaction(() => rolloverEnabled(db, ws.id) ? advanceWorkspace(db, ws.id, instant, emptyProgress()) : emptyProgress());
      progress = db.inTransaction ? run() : run.immediate();
    } catch (e) {
      const err = toNodError(e);
      const reason = { code: err instanceof NodError ? err.code : "INTERNAL", message: err instanceof Error ? err.message : String(err) };
      if (reason.code === BLOCKED) blocked = reason; else error = reason;
    }
    const links = (ids: string[]) => ids.map(id => link(resolveSprint(db, id)));
    return { workspaceId: ws.id, workspaceKey: ws.key, ended: links(progress.ended),
      successors: progress.successors.map(s => ({ sprint: link(resolveSprint(db, s.id)), created: s.created })),
      started: links(progress.started), carried: progress.carried, blocked, error };
  });
}

// 人が期限後に手で終了したSprintから、自動処理と同じ後継決定・引継ぎ・開始を行う。
// 手動終了と同じtransactionで呼び、失敗は例外のまま返して終了も確定させない。
export function rolloverAfterManualEnd(db: Database, ended: Sprint, instant: Date): void {
  if (ended.workspaceId === null || !rolloverEnabled(db, ended.workspaceId)) return;
  const progress = emptyProgress();
  succeed(db, ended, instant, progress);
  advanceWorkspace(db, ended.workspaceId, instant, progress);
}

// 自動処理で終了済みのSprintへの手動終了を、引継ぎ先が分かる理由で拒否する。終了記録は上書きしない。
export function assertNotAutoEnded(db: Database, sprint: Sprint): void {
  if (sprint.phase !== "ended") return;
  const row = db.query("SELECT closure_record FROM sprints WHERE id=?").get(sprint.id) as { closure_record: string | null };
  const record = row.closure_record ? JSON.parse(row.closure_record) as SprintClosureRecord : null;
  if (record?.automation !== SPRINT_ROLLOVER_AUTOMATION) return;
  const next = db.query("SELECT number,name FROM sprints WHERE rollover_from_sprint_id=?").get(sprint.id) as { number: number; name: string } | null;
  throw new NodError("INVALID_STATE", `このSprintは期間の終了後に自動処理で終了し、${next ? `後継 Sprint ${next.number}「${next.name}」` : "後継のSprint"}へ引き継ぎ済みです`);
}

export interface SprintRolloverStatus {
  workspaceKey: string;
  enabled: boolean;
  scrumEnabled: boolean;
  // 次に処理する時刻（終了させるSprintの終了時刻、または開始待ちの後継の開始時刻）。実行は次の契機で、その時刻の実行は保証しない。
  nextRunAt: string | null;
  successor:
    | { kind: "existing"; sprint: SprintLink }
    | { kind: "create"; startDate: string; endDate: string; timezone: string }
    | { kind: "start"; sprint: SprintLink }
    | null;
  blocked: { code: string; message: string } | null;
}

// Workspaceの自動引継ぎの状態。後継の決定と同じ規則を読取だけで計算し、変更は行わない。
export function getSprintRolloverStatus(db: Database, workspaceKey: string, clock: SprintClock = {}): SprintRolloverStatus {
  const instant = instantOf(clock), iso = instant.toISOString();
  const read = (): SprintRolloverStatus => {
    const scrum = getScrumWorkspace(db, workspaceKey), wsId = scrum.workspaceId;
    const base: SprintRolloverStatus = { workspaceKey: findWorkspace(db, workspaceKey)!.key, enabled: scrum.autoRollover, scrumEnabled: scrum.enabled,
      nextRunAt: null, successor: null, blocked: null };
    if (!scrum.enabled) return { ...base, blocked: { code: "SCRUM_DISABLED", message: "WorkspaceのSprint運用が無効なため、自動引継ぎは動きません" } };
    if (!scrum.autoRollover) return { ...base, blocked: { code: "SPRINT_ROLLOVER_DISABLED", message: "期限到来時の自動引継ぎは無効に設定されています" } };
    // 次に終了させるSprint。実処理と同じ順で、期限切れの実行中、期間を丸ごと過ぎた未開始の後継、期限内の実行中の順に選ぶ。
    const active = sprintById(db, "SELECT id FROM sprints WHERE workspace_id=? AND phase='active'", wsId);
    const ending = (active && julianLte(db, active.endsAt!, iso) ? active : null)
      ?? sprintById(db, `SELECT s.id FROM sprints s WHERE s.workspace_id=? AND ${CHAINED_UNSTARTED} AND julianday(s.ends_at)<=julianday(?)
        ORDER BY julianday(s.starts_at),s.number LIMIT 1`, wsId, iso)
      ?? active;
    if (ending) {
      const decision = decideSuccessor(db, ending, Date.parse(ending.endsAt!) > instant.getTime() ? new Date(ending.endsAt!) : instant);
      const overlap = decision.kind === "create" ? decision.overlap : null;
      return { ...base, nextRunAt: ending.endsAt,
        successor: decision.kind === "create" ? { kind: "create", startDate: decision.period.startDate, endDate: decision.period.endDate, timezone: decision.period.timezone }
          : { kind: "existing", sprint: link(decision.sprint) },
        blocked: overlap && { code: overlap.code, message: overlap.message } };
    }
    const pending = sprintById(db, `SELECT s.id FROM sprints s WHERE s.workspace_id=? AND ${CHAINED_UNSTARTED} ORDER BY julianday(s.starts_at),s.number LIMIT 1`, wsId);
    if (pending) return { ...base, nextRunAt: Date.parse(pending.startsAt!) > instant.getTime() ? pending.startsAt : iso, successor: { kind: "start", sprint: link(pending) } };
    const last = sprintById(db, `SELECT id FROM sprints WHERE workspace_id=? AND rollover_from_sprint_id IS NOT NULL
      ORDER BY julianday(starts_at) DESC,number DESC LIMIT 1`, wsId);
    if (last?.phase === "canceled") {
      return { ...base, blocked: { code: "SPRINT_ROLLOVER_CHAIN_STOPPED",
        message: `後継 Sprint ${last.number}「${last.name}」を中止したため、自動引継ぎの連鎖は止まっています。次のSprintは人が作成・開始してください` } };
    }
    return base;
  };
  return db.inTransaction ? read() : db.transaction(read)();
}

export interface SetSprintRolloverInput { enabled: boolean }
// 自動引継ぎの有効・無効だけを変える。人だけが行え、Scrum設定の版・要求キーは使わない（問題・目標・根拠の再入力を求めない）。
// 無効から有効に戻すと、次の契機でその時点の処理対象だけを処理する（それより前に終了・中止したSprintは遡らない）。
export function setSprintRollover(ctx: OpCtx, workspaceKey: string, input: SetSprintRolloverInput): ScrumWorkspace {
  if (isLlm(ctx)) throw new NodError("FORBIDDEN_FOR_LLM", "このSprint操作は人だけが行えます");
  sprintObject(input, ["enabled"]);
  if (typeof input.enabled !== "boolean") invalidSprint("enabledは真偽値で指定してください");
  return tx(ctx.db, () => {
    const scrum = getScrumWorkspace(ctx.db, workspaceKey);
    if (scrum.version === 0) throw new NodError("INVALID_STATE", "先にWorkspaceのSprint運用の方向設定を保存してください");
    ctx.db.query("UPDATE scrum_workspaces SET auto_rollover=? WHERE workspace_id=?").run(input.enabled ? 1 : 0, scrum.workspaceId);
    return getScrumWorkspace(ctx.db, workspaceKey);
  });
}
