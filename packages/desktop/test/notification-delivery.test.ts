import { afterEach, beforeAll, expect, setSystemTime, test } from "bun:test";
import { join } from "node:path";
import { createApp } from "../../server/src/app";
import { openDb, initWorkspace, createIssue, setReminder, clearReminder, setDesktopNotificationSettings, getDesktopNotificationDelivery, listNotifications, updateIssue, archiveIssue, unarchiveIssue, snoozeNotifications, unsnoozeNotifications, markNotificationsRead, markNotificationsUnread, deleteNotifications, restoreNotifications, deleteIssue, type DesktopNotification } from "../../core/src";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

function fixture() {
  setSystemTime(new Date("2026-10-15T00:00:00Z"));
  const directory = mkdtempSync(join(tmpdir(), "nod-delivery-state-"));
  const db = openDb(join(directory, "nod.db"));
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
