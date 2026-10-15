import { afterEach, beforeAll, expect, setSystemTime, test } from "bun:test";
import { join } from "node:path";
import { createApp } from "../../server/src/app";
import { openDb, initWorkspace, createIssue, setReminder, setDesktopNotificationSettings, getDesktopNotificationDelivery, listNotifications, updateIssue } from "../../core/src";
import { mkdtempSync } from "node:fs";
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
