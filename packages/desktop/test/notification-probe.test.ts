import { expect, setSystemTime, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIssue, initWorkspace, listNotifications, openDb, setReminder } from "../../core/src";
import { createApp } from "../../server/src/app";

test.skipIf(process.platform !== "darwin" || Bun.which("swiftc") === null)("試作の実DB・API・時計から偽OSへリマインダーを一回だけ渡し、Inboxを維持する", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nod-probe-test-"));
  const executable = join(dir, "probe-engine-test");
  const compile = Bun.spawnSync(["swiftc", new URL("../probe/engine.swift", import.meta.url).pathname,
    new URL("../probe/engine-test.swift", import.meta.url).pathname, "-o", executable]);
  if (compile.exitCode !== 0) throw new Error(`Swift境界のコンパイルに失敗しました:\n${compile.stderr.toString()}`);
  const db = openDb(join(dir, "nod.db"));
  const ws = initWorkspace(db, { path: join(dir, "repo") }).workspace;
  const me = { db, actor: "me" };
  try {
    setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const issue = createIssue(me, { workspaceId: ws.id, title: "期限の確認" });
    setReminder(me, issue.id, { at: "2030-01-01T00:00:03.000Z", note: "レビューを確認" });
    const app = createApp({ db, orcaRunner: null });
    expect(await (await app.request("/api/notifications")).json()).toEqual([]);
    setSystemTime(new Date("2030-01-01T00:00:03.000Z"));
    const candidates = await (await app.request("/api/notifications")).json();
    const run = Bun.spawnSync([executable], { stdin: new TextEncoder().encode(JSON.stringify(candidates)) });
    if (run.exitCode !== 0) throw new Error(`偽OSへの配信に失敗しました:\n${run.stderr.toString()}`);
    expect(JSON.parse(run.stdout.toString())).toEqual([
      { issueId: issue.id, notificationId: candidates[0].id, title: "期限の確認", body: "レビューを確認" },
    ]);
    expect(listNotifications(db).map((item) => ({ id: item.id, readAt: item.readAt })))
      .toEqual([{ id: candidates[0].id, readAt: null }]);
  } finally {
    setSystemTime();
    db.close();
  }
});
