import { afterEach, beforeAll, expect, setSystemTime, test } from "bun:test";
import { join } from "node:path";
import { createApp } from "../../server/src/app";
import { openDb, initWorkspace, createIssue, setReminder, clearReminder, setDesktopNotificationSettings, getDesktopNotificationDelivery, listNotifications, updateIssue, archiveIssue, unarchiveIssue, snoozeNotifications, unsnoozeNotifications, markNotificationsRead, markNotificationsUnread, deleteNotifications, restoreNotifications, deleteIssue, type DesktopNotification } from "../../core/src";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { MIGRATIONS } from "../../core/src/schema";
import { subscribeIssue } from "../../core/src/ops/notifications";
const root = join(import.meta.dir, "notification-harness");
const harness = join(root, "target/debug/notification-delivery-harness");
const supported = process.platform === "darwin" && Bun.which("cargo") !== null;
beforeAll(async () => {
  if (!supported) return;
  const child = Bun.spawn(["cargo", "build", "--manifest-path", join(root, "Cargo.toml")], { stdout: "ignore", stderr: "pipe" });
  const errors = await new Response(child.stderr).text();
  if (await child.exited !== 0) throw new Error(errors);
}, 180000);
afterEach(() => setSystemTime());

function fixture(initialTime = "2026-10-15T00:00:00Z", prepare?: (path: string) => void) {
  setSystemTime(new Date(initialTime));
  const directory = mkdtempSync(join(tmpdir(), "nod-delivery-state-"));
  const path = join(directory, "nod.db");
  prepare?.(path);
  const db = openDb(path);
  const me = { db, actor: "me" };
  const ws = initWorkspace(db, { path: "/tmp/native-state", key: "STATE" }).workspace;
  const app = createApp({ db, orcaRunner: null });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    db, me, ws, origin,
    at: (seconds: number) => setSystemTime(new Date(`2026-10-15T00:00:${String(seconds).padStart(2, "0")}Z`)),
    async tick(mode = "ok"): Promise<DesktopNotification[]> {
      const child = Bun.spawn([harness, origin, mode], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, stderr).toBe(0);
      if (mode === "permission-error") expect(stderr).toContain("偽OSの許可取得失敗");
      return JSON.parse(stdout);
    },
    close() { server.stop(true); db.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

for (const introducedHour of [8, 15]) test.skipIf(!supported)(`実ネイティブ配信：${introducedHour}時台にschema40から移行し、古い期日を除外して既存の将来期日を届ける`, async () => {
  const f = fixture(new Date(2026, 9, 15, introducedHour, 59, 58).toISOString(), path => {
    const old = new Database(path, { create: true });
    try {
      for (const steps of MIGRATIONS.slice(0, 40)) for (const step of steps) typeof step === "string" ? old.exec(step) : step(old);
      old.exec("PRAGMA user_version = 40");
      old.query("INSERT INTO workspaces (key, name, path, created_at, color) VALUES ('OLD', '旧Workspace', '/tmp/legacy-due', ?, '#7C5CFF')").run(new Date(2026, 9, 1).toISOString());
      for (const [number, dueDate] of [[1, "2026-10-14"], [2, "2026-10-15"], [3, "2026-10-16"]] as const) {
        old.query("INSERT INTO issues (workspace_id, number, title, status, due_date, created_by, created_at, updated_at) VALUES (1, ?, ?, 'todo', ?, 'me', ?, ?)").run(number, `既存の作業${number}`, dueDate, new Date(2026, 9, 1).toISOString(), new Date(2026, 9, 1).toISOString());
      }
      old.query("INSERT INTO notifications (recipient, issue_id, kind, event_type, actor, data, created_at) VALUES ('me', 1, 'issue_change', 'title_changed', 'claude-code', '{}', ?)").run(new Date(2026, 9, 1).toISOString());
    } finally { old.close(); }
  });
  try {
    setDesktopNotificationSettings(f.db, true);
    expect(listNotifications(f.db)).toEqual([expect.objectContaining({ issueId: "OLD-1", kind: "issue_change" })]);
    expect(await f.tick()).toEqual([]);
    if (introducedHour === 8) {
      setSystemTime(new Date(2026, 9, 15, 9));
      expect(await f.tick()).toEqual([expect.objectContaining({ issueId: "OLD-2", scheduledAt: new Date(2026, 9, 15, 9).toISOString() })]);
    }
    setSystemTime(new Date(2026, 9, 16, 9));
    expect(await f.tick()).toEqual([expect.objectContaining({ issueId: "OLD-3" })]);
    expect(await f.tick()).toEqual([]);
    expect(listNotifications(f.db)).toHaveLength(introducedHour === 8 ? 3 : 2);
    expect(listNotifications(f.db).filter(n => n.issueId === "OLD-1")).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

for (const permission of ["denied", "notDetermined"] as const) test.skipIf(!supported)(`実ネイティブ配信：期日到来も${permission}で永久除外し、Inboxを保って後から再送しない`, async () => {
  const f = fixture(new Date(2026, 9, 15, 8, 59, 58).toISOString());
  try {
    setDesktopNotificationSettings(f.db, true);
    const issue = createIssue(f.me, { workspaceId: f.ws.id, title: "許可共通の期日", dueDate: "2026-10-15" });
    setSystemTime(new Date(2026, 9, 15, 9));
    expect(await f.tick(permission)).toEqual([]);
    expect(listNotifications(f.db)).toEqual([expect.objectContaining({ issueId: issue.id, kind: "due_date" })]);
    expect(await f.tick()).toEqual([]);
  } finally { f.close(); }
}, 20000);

test.skipIf(!supported)("実ネイティブ配信：全Workspaceの人・LLM・Web・一括更新の期日を届け、失敗した一括更新からは作らない", async () => {
  const f = fixture(new Date(2026, 9, 15, 8, 59, 58).toISOString());
  try {
    setDesktopNotificationSettings(f.db, true);
    const other = initWorkspace(f.db, { path: "/tmp/due-other", key: "OTHER" }).workspace;
    const a = createIssue(f.me, { workspaceId: f.ws.id, title: "人が起票", dueDate: "2026-10-15" });
    updateIssue(f.me, a.id, { assignee: "claude-code" });
    const b = createIssue({ db: f.db, actor: "claude-code" }, { workspaceId: other.id, title: "LLMが起票", dueDate: "2026-10-15" });
    const c = createIssue(f.me, { workspaceId: other.id, title: "Webで設定" });
    const d = createIssue(f.me, { workspaceId: other.id, title: "一括で設定" });
    const failed = createIssue(f.me, { workspaceId: f.ws.id, title: "ロールバックする" });
    const post = (path: string, body: unknown) => fetch(`${f.origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await post(`/api/issues/${c.id}/update`, { dueDate: "2026-10-15" })).status).toBe(200);
    expect((await post("/api/issues/bulk-update", { ids: [d.id], dueDate: "2026-10-15" })).status).toBe(200);
    const error = await post("/api/issues/bulk-update", { ids: [failed.id, "STATE-9999"], dueDate: "2026-10-15" });
    expect(error.status).toBe(409);
    expect((await error.json()).error.code).toBe("BULK_UPDATE_FAILED");
    setSystemTime(new Date(2026, 9, 15, 9));
    expect((await f.tick()).map(n => n.issueId).sort()).toEqual([a.id, b.id, c.id, d.id].sort());
    expect(listNotifications(f.db).map(n => n.issueId).sort()).toEqual([a.id, b.id, c.id, d.id].sort());
    expect(await f.tick()).toEqual([]);
  } finally { f.close(); }
}, 20000);

test.skipIf(!supported)("実ネイティブ配信：同時刻の明示リマインダーと期日を各一件送り、購読通知を保ち、クリックした期日だけ既読にする", async () => {
  const f = fixture(new Date(2026, 9, 15, 8, 59, 58).toISOString());
  try {
    setDesktopNotificationSettings(f.db, true);
    const issue = createIssue(f.me, { workspaceId: f.ws.id, title: "二つの予定" });
    subscribeIssue(f.me, issue.id);
    updateIssue({ db: f.db, actor: "claude-code" }, issue.id, { dueDate: "2026-10-15" });
    setReminder(f.me, issue.id, { at: new Date(2026, 9, 15, 9).toISOString(), note: "独立したメモ" });
    setSystemTime(new Date(2026, 9, 15, 9));
    const sent = await f.tick();
    expect(sent.map(n => n.body).sort()).toEqual(["期日が到来しました（2026-10-15）", "独立したメモ"].sort());
    expect(sent.every(n => n.issueId === issue.id)).toBe(true);
    const inbox = listNotifications(f.db);
    expect(inbox.map(n => n.kind).sort()).toEqual(["due_date", "issue_change", "reminder"]);
    const due = inbox.find(n => n.kind === "due_date")!;
    const response = await fetch(`${f.origin}/api/desktop-notifications/opened`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ issueId: issue.id, notificationId: due.id }) });
    expect(response.status).toBe(200);
    expect(listNotifications(f.db).map(n => n.kind).sort()).toEqual(["issue_change", "reminder"]);
    expect(await f.tick()).toEqual([]);
  } finally { f.close(); }
}, 20000);

test.skipIf(!supported)("実ネイティブ配信：OFF中も期日をInbox化し、ONにした後は遡及送信しない", async () => {
  const f = fixture(new Date(2026, 9, 15, 8, 59, 58).toISOString());
  try {
    const issue = createIssue(f.me, { workspaceId: f.ws.id, title: "OFF中の期日", dueDate: "2026-10-15" });
    setSystemTime(new Date(2026, 9, 15, 9));
    expect(await f.tick()).toEqual([]);
    expect(listNotifications(f.db)).toEqual([expect.objectContaining({ issueId: issue.id, kind: "due_date" })]);
    setSystemTime(new Date(2026, 9, 15, 9, 0, 1));
    setDesktopNotificationSettings(f.db, true);
    expect(await f.tick()).toEqual([]);
    expect(listNotifications(f.db)).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

test.skipIf(!supported)("実ネイティブ配信：期日当日のローカル09:00に現在のタイトルと期日を一度だけ届ける", async () => {
  const f = fixture(new Date(2026, 9, 15, 8, 59, 58).toISOString());
  try {
    setDesktopNotificationSettings(f.db, true);
    const issue = createIssue(f.me, { workspaceId: f.ws.id, title: "期日の作業", dueDate: "2026-10-15" });
    setSystemTime(new Date(2026, 9, 15, 8, 59, 59));
    expect(await f.tick()).toEqual([]);
    expect(listNotifications(f.db)).toEqual([]);
    updateIssue(f.me, issue.id, { title: "現在の期日の作業" });
    setSystemTime(new Date(2026, 9, 15, 9));
    expect(await f.tick()).toEqual([expect.objectContaining({ issueId: issue.id, title: "現在の期日の作業", body: "期日が到来しました（2026-10-15）", scheduledAt: new Date(2026, 9, 15, 9).toISOString() })]);
    expect(listNotifications(f.db)).toEqual([expect.objectContaining({ kind: "due_date", eventType: "due_date_arrived", data: { dueDate: "2026-10-15" } })]);
    expect(await f.tick()).toEqual([]);
  } finally { f.close(); }
}, 20000);

for (const dueDate of ["2026-10-15", "2026-10-14"]) for (const operation of ["起票", "変更"] as const) {
  test.skipIf(!supported)(`実ネイティブ配信：15時の${operation}で${dueDate}を設定すると設定時刻に一度通知し、同じ値の再保存で予定時刻を変えない`, async () => {
    const f = fixture(new Date(2026, 9, 15, 14, 59).toISOString());
    try {
      setDesktopNotificationSettings(f.db, true);
      const existing = operation === "変更" ? createIssue(f.me, { workspaceId: f.ws.id, title: "後から期日を設定" }) : null;
      setSystemTime(new Date(2026, 9, 15, 15));
      const issue = existing ? updateIssue(f.me, existing.id, { dueDate }) : createIssue(f.me, { workspaceId: f.ws.id, title: "新しく期日を設定", dueDate });
      setSystemTime(new Date(2026, 9, 15, 15, 1));
      updateIssue(f.me, issue.id, { dueDate });
      expect(await f.tick()).toEqual([expect.objectContaining({ issueId: issue.id, body: `期日が到来しました（${dueDate}）`, scheduledAt: new Date(2026, 9, 15, 15).toISOString() })]);
      expect(await f.tick()).toEqual([]);
      expect(listNotifications(f.db)).toHaveLength(1);
    } finally { f.close(); }
  }, 20000);
}

function lines(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return async () => {
    while (!buffer.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`プロセスが応答前に終了しました: ${buffer}`);
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    const end = buffer.indexOf("\n");
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    return line;
  };
}

for (const held of ["archive", "snooze"] as const) test.skipIf(!supported)(`実ネイティブ配信：${held}中は不許可でも保留し、解除後の許可済み未読を一度送る`, async () => {
  const f = fixture();
  try {
    setDesktopNotificationSettings(f.db, true);
    const issue = createIssue(f.me, { workspaceId: f.ws.id, title: "保留中のリマインダー" });
    setReminder(f.me, issue.id, { at: "2026-10-15T00:00:02Z" });
    f.at(2);
    const [notification] = listNotifications(f.db);
    if (held === "archive") archiveIssue(f.me, issue.id);
    else snoozeNotifications(f.me, { ids: [notification!.id], until: "2026-10-15T00:00:20Z" });
    expect(await f.tick("denied")).toEqual([]);
    if (held === "archive") unarchiveIssue(f.me, issue.id);
    else unsnoozeNotifications(f.me, { ids: [notification!.id] });
    expect(await f.tick()).toEqual([expect.objectContaining({ issueId: issue.id, notificationId: notification!.id })]);
    expect(await f.tick()).toEqual([]);
    expect(listNotifications(f.db)).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

for (const operation of ["変更", "解除"] as const) {
  test.skipIf(!supported)(`実ネイティブ配信：期限前の${operation}を反映し、古い予定を送らない`, async () => {
    const f = fixture();
    try {
      setDesktopNotificationSettings(f.db, true);
      const issue = createIssue(f.me, { workspaceId: f.ws.id, title: "予定変更" });
      setReminder(f.me, issue.id, { at: "2026-10-15T00:00:02Z", note: "旧メモ" });
      f.at(1);
      if (operation === "変更") setReminder(f.me, issue.id, { at: "2026-10-15T00:00:04Z", note: "新メモ" });
      else clearReminder(f.me, issue.id);
      f.at(2);
      expect(await f.tick()).toEqual([]);
      expect(listNotifications(f.db)).toEqual([]);
      f.at(4);
      const sent = await f.tick();
      expect(sent).toEqual(operation === "変更" ? [expect.objectContaining({ issueId: issue.id, body: "新メモ", scheduledAt: "2026-10-15T00:00:04.000Z" })] : []);
    } finally { f.close(); }
  }, 20000);

  test.skipIf(!supported)(`実ネイティブ配信：到来直後の${operation}は旧Inboxを保持し、旧分も一度送る`, async () => {
    const f = fixture();
    try {
      setDesktopNotificationSettings(f.db, true);
      const issue = createIssue(f.me, { workspaceId: f.ws.id, title: "到来後の予定変更" });
      setReminder(f.me, issue.id, { at: "2026-10-15T00:00:02Z", note: "旧メモ" });
      f.at(2);
      if (operation === "変更") setReminder(f.me, issue.id, { at: "2026-10-15T00:00:04Z", note: "新メモ" });
      else clearReminder(f.me, issue.id);
      expect(await f.tick()).toEqual([expect.objectContaining({ body: "旧メモ", scheduledAt: "2026-10-15T00:00:02.000Z" })]);
      f.at(4);
      const next = await f.tick();
      expect(next).toEqual(operation === "変更" ? [expect.objectContaining({ body: "新メモ" })] : []);
      expect(listNotifications(f.db)).toHaveLength(operation === "変更" ? 2 : 1);
    } finally { f.close(); }
  }, 20000);
}

for (const status of ["done", "canceled"] as const) test.skipIf(!supported)(`実ネイティブ配信：${status}だけでは明示的なリマインダーを取り消さない`, async () => {
  const f = fixture();
  try {
    setDesktopNotificationSettings(f.db, true);
    const issue = createIssue(f.me, { workspaceId: f.ws.id, title: "終了後も思い出す" });
    setReminder(f.me, issue.id, { at: "2026-10-15T00:00:02Z" });
    updateIssue(f.me, issue.id, { status });
    f.at(2);
    expect(await f.tick()).toEqual([expect.objectContaining({ issueId: issue.id })]);
    expect(listNotifications(f.db)).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

for (const period of ["初回ON前", "OFF中", "再ON前の保留"] as const) test.skipIf(!supported)(`実ネイティブ配信：${period}の到来分をON後に遡及せず、Inboxを保持する`, async () => {
  const f = fixture();
  try {
    if (period !== "初回ON前") setDesktopNotificationSettings(f.db, true);
    const old = createIssue(f.me, { workspaceId: f.ws.id, title: "遡及しない" });
    setReminder(f.me, old.id, { at: "2026-10-15T00:00:02Z" });
    if (period === "OFF中") setDesktopNotificationSettings(f.db, false);
    f.at(2);
    listNotifications(f.db);
    if (period === "再ON前の保留") {
      archiveIssue(f.me, old.id);
      expect(await f.tick()).toEqual([]);
      setDesktopNotificationSettings(f.db, false);
    } else expect(await f.tick()).toEqual([]);
    f.at(3);
    setDesktopNotificationSettings(f.db, true);
    // 再有効化より前の通知は、保留中でも永久除外する。
    expect(await f.tick()).toEqual([]);
    if (period === "再ON前の保留") unarchiveIssue(f.me, old.id);
    const fresh = createIssue(f.me, { workspaceId: f.ws.id, title: "ON後の予定" });
    setReminder(f.me, fresh.id, { at: "2026-10-15T00:00:04Z" });
    f.at(4);
    expect(await f.tick()).toEqual([expect.objectContaining({ issueId: fresh.id })]);
    expect(listNotifications(f.db)).toHaveLength(2);
  } finally { f.close(); }
}, 20000);

for (const permission of ["denied", "notDetermined", "permission-error"] as const) test.skipIf(!supported)(`実ネイティブ配信：${permission}は${permission === "permission-error" ? "保留して回復後に送る" : "永久除外して許可後も再送しない"}`, async () => {
  const f = fixture();
  try {
    setDesktopNotificationSettings(f.db, true);
    const issue = createIssue(f.me, { workspaceId: f.ws.id, title: "許可を確認" });
    setReminder(f.me, issue.id, { at: "2026-10-15T00:00:02Z" });
    f.at(2);
    expect(await f.tick(permission)).toEqual([]);
    expect(await f.tick()).toEqual(permission === "permission-error" ? [expect.objectContaining({ issueId: issue.id })] : []);
    expect(listNotifications(f.db)).toHaveLength(1);
  } finally { f.close(); }
}, 20000);

for (const operation of ["既読", "削除"] as const) for (const archived of [false, true]) test.skipIf(!supported)(`実ネイティブ配信：${archived ? "アーカイブ中も" : ""}${operation}を確認した通知は未読・復元後も再送しない`, async () => {
  const f = fixture();
  try {
    setDesktopNotificationSettings(f.db, true);
    const issue = createIssue(f.me, { workspaceId: f.ws.id, title: "処理済み" });
    setReminder(f.me, issue.id, { at: "2026-10-15T00:00:02Z" });
    f.at(2);
    const [notification] = listNotifications(f.db);
    const ids = [notification!.id];
    if (operation === "既読") markNotificationsRead(f.me, { ids });
    else deleteNotifications(f.me, { ids });
    if (archived) archiveIssue(f.me, issue.id);
    expect(await f.tick()).toEqual([]);
    if (operation === "既読") markNotificationsUnread(f.me, { ids });
    else restoreNotifications(f.me, { ids });
    if (archived) unarchiveIssue(f.me, issue.id);
    expect(await f.tick()).toEqual([]);
    expect(listNotifications(f.db).map(n => n.id)).toEqual(ids);
  } finally { f.close(); }
}, 20000);

test.skipIf(!supported)("実ネイティブ配信：スヌーズ期限後の未読を初回送信し、永久削除Issueを送らない", async () => {
  const f = fixture();
  try {
    setDesktopNotificationSettings(f.db, true);
    const sleeping = createIssue(f.me, { workspaceId: f.ws.id, title: "自然にスヌーズ解除" });
    const deleted = createIssue(f.me, { workspaceId: f.ws.id, title: "永久削除する" });
    for (const issue of [sleeping, deleted]) setReminder(f.me, issue.id, { at: "2026-10-15T00:00:02Z" });
    f.at(2);
    listNotifications(f.db);
    snoozeNotifications(f.me, { issueRef: sleeping.id, until: "2026-10-15T00:00:04Z" });
    archiveIssue(f.me, deleted.id);
    deleteIssue(f.me, deleted.id);
    expect(await f.tick()).toEqual([]);
    f.at(4);
    expect(await f.tick()).toEqual([expect.objectContaining({ issueId: sleeping.id })]);
  } finally { f.close(); }
}, 20000);

for (const operation of ["既読", "期限前解除", "OFF"] as const) test.skipIf(!supported)(`実DB競合：${operation}のcommitを待つclaimは確定後の条件に従って送信しない`, async () => {
  const f = fixture();
  let api: import("bun").Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let native: import("bun").Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    setDesktopNotificationSettings(f.db, true);
    const issue = createIssue(f.me, { workspaceId: f.ws.id, title: "利用者操作を先に確定" });
    setReminder(f.me, issue.id, { at: "2026-10-15T00:00:02Z" });
    if (operation !== "期限前解除") f.at(2);
    const notification = operation === "期限前解除" ? undefined : listNotifications(f.db)[0]!;
    api = Bun.spawn(["bun", join(import.meta.dir, "notification-server.ts"), f.db.filename, "2026-10-15T00:00:02Z"], { stdout: "pipe", stderr: "pipe" });
    const nextLine = lines(api.stdout);
    const origin = await nextLine();
    expect(origin).toStartWith("http://127.0.0.1:");
    f.db.exec("BEGIN IMMEDIATE");
    if (operation === "既読") markNotificationsRead(f.me, { ids: [notification!.id] });
    else if (operation === "期限前解除") clearReminder(f.me, issue.id);
    else setDesktopNotificationSettings(f.db, false);
    native = Bun.spawn([harness, origin, "ok"], { stdout: "pipe", stderr: "pipe" });
    expect(await nextLine()).toBe("claim");
    // APIが実DBの書き込みロックを待っている間は、OS送信へ進めない。
    expect(await Promise.race([native.exited.then(() => "exited"), Bun.sleep(30).then(() => "waiting")])).toBe("waiting");
    f.db.exec("COMMIT");
    const [stdout, stderr, code] = await Promise.all([new Response(native.stdout).text(), new Response(native.stderr).text(), native.exited]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
    f.at(3);
    if (operation === "既読") markNotificationsUnread(f.me, { ids: [notification!.id] });
    else if (operation === "OFF") setDesktopNotificationSettings(f.db, true);
    expect(await f.tick()).toEqual([]);
    expect(listNotifications(f.db)).toHaveLength(operation === "期限前解除" ? 0 : 1);
  } finally {
    if (f.db.inTransaction) f.db.exec("ROLLBACK");
    native?.kill(); api?.kill();
    if (native) await native.exited;
    if (api) await api.exited;
    f.close();
  }
}, 20000);

for (const operation of ["既読", "到来後解除", "OFF"] as const) test.skipIf(!supported)(`実DB競合：claim確定後の${operation}は取得済みの一回を撤回せず、次のtickで再送しない`, async () => {
  const f = fixture();
  let native: import("bun").Subprocess<"pipe", "pipe", "pipe"> | undefined;
  try {
    setDesktopNotificationSettings(f.db, true);
    const issue = createIssue(f.me, { workspaceId: f.ws.id, title: "claimを先に確定" });
    setReminder(f.me, issue.id, { at: "2026-10-15T00:00:02Z" });
    f.at(2);
    native = Bun.spawn([harness, f.origin, "pause-before-send"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    expect(await lines(native.stderr)()).toBe("送信待機");
    const notification = listNotifications(f.db)[0]!;
    if (operation === "既読") markNotificationsRead(f.me, { ids: [notification.id] });
    else if (operation === "到来後解除") clearReminder(f.me, issue.id);
    else setDesktopNotificationSettings(f.db, false);
    native.stdin.write("release\n"); native.stdin.end();
    const stdout = await new Response(native.stdout).text();
    expect(await native.exited).toBe(0);
    expect(JSON.parse(stdout)).toEqual([expect.objectContaining({ issueId: issue.id, notificationId: notification.id })]);
    f.at(3);
    if (operation === "既読") markNotificationsUnread(f.me, { ids: [notification.id] });
    else if (operation === "OFF") setDesktopNotificationSettings(f.db, true);
    expect(await f.tick()).toEqual([]);
    expect(listNotifications(f.db)).toHaveLength(1);
  } finally {
    native?.kill();
    if (native) await native.exited;
    f.close();
  }
}, 20000);
for (const fail of [false, true]) test.skipIf(!supported)(`実ネイティブtick→HTTP→実DB→偽OS：${fail ? "失敗を再送しない" : "複数WorkspaceとCLI先行分を一度送る"}`, async () => {
  setSystemTime(new Date("2026-10-15T00:00:00Z"));
  const db = openDb(join(mkdtempSync(join(tmpdir(), "nod-delivery-")), "nod.db"));
  const me = { db, actor: "me" };
  const first = initWorkspace(db, { path: "/tmp/native-api", key: "ONE" }).workspace;
  const second = initWorkspace(db, { path: "/tmp/native-other", key: "TWO" }).workspace;
  setDesktopNotificationSettings(db, true);
  const a = createIssue(me, { workspaceId: first.id, title: "古いタイトル" });
  const b = createIssue(me, { workspaceId: second.id, title: "別Workspace" });
  for (const issue of [a, b]) setReminder(me, issue.id, { at: "2026-10-15T00:00:02Z", note: "メモ" });
  setSystemTime(new Date("2026-10-15T00:00:02Z"));
  const inbox = listNotifications(db);
  updateIssue(me, a.id, { title: "現在のタイトル" });
  const app = createApp({ db, orcaRunner: null });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  try {
    const children = [1, 2].map(() => Bun.spawn([harness, `http://127.0.0.1:${server.port}`, fail ? "fail" : "ok"], { stdout: "pipe", stderr: "pipe" }));
    const outputs = await Promise.all(children.map(async child => {
      const text = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      return JSON.parse(text) as { title: string; body: string }[];
    }));
    const sent = outputs.flat();
    expect(sent).toHaveLength(2);
    expect(sent).toContainEqual(expect.objectContaining({ title: "現在のタイトル", body: "メモ" }));
    expect(listNotifications(db)).toHaveLength(2);
    for (const item of inbox) expect(getDesktopNotificationDelivery(db, item.id)?.state).toBe(fail ? "failed" : "sent");
  } finally { server.stop(true); db.close(); }
}, 20000);
