import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "../../core/src/schema";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

test("LLM が me の Inbox を操作し、解除後も操作者と操作内容を履歴で確認できる", async () => {
  const db = tempDb();
  const cwd = makeRepo();
  registerRepo(db, cwd, "API");
  const nod = (args: string[], actor = "codex") => runNod([...args, "--json"], { cwd, db, actor });
  expect((await nod(["issue", "create", "Inbox", "--requested"])).exitCode).toBe(0);
  expect((await nod(["issue", "subscribe", "API-1"])).json.subscribed).toBe(true);
  expect((await nod(["issue", "show", "API-1"], "me")).json.subscribed).toBe(true);
  await nod(["issue", "comment", "API-1", "確認"], "claude-code");
  const id = String((await nod(["notification", "list"], "me")).json[0].id);
  for (const args of [["read", id], ["unread", id], ["snooze", id, "--until", "2999-01-01"], ["unsnooze", id], ["delete", id], ["restore", id]]) {
    expect((await nod(["notification", ...args])).json.updated).toBe(1);
    const visible = (await nod(["inbox"], "me")).json.notifications;
    expect(visible).toHaveLength(["read", "snooze", "delete"].includes(args[0]!) ? 0 : 1);
  }
  expect((await nod(["issue", "remind", "API-1", "--at", "2999-01-01", "--note", "確認する"])).exitCode).toBe(0);
  expect((await nod(["reminder", "list"], "me")).json).toMatchObject([{ issueId: "API-1", note: "確認する" }]);
  expect((await nod(["issue", "remind", "API-1", "--clear"])).json.cleared).toBe(true);
  expect((await nod(["reminder", "list"], "me")).json).toEqual([]);
  expect((await nod(["issue", "unsubscribe", "API-1"])).json.subscribed).toBe(false);
  expect((await nod(["issue", "show", "API-1"], "me")).json.subscribed).toBe(false);
  expect((await nod(["notification", "read", "999999"])).json.error.code).toBe("NOT_FOUND");
  const history = await nod(["notification", "history"], "me");
  expect(history.exitCode).toBe(0);
  expect(history.json.map((r: { operation: string }) => r.operation)).toEqual([
    "unsubscribe", "reminder_clear", "reminder_set", "restore", "delete", "unsnooze", "snooze", "unread", "read", "subscribe",
  ]);
  for (const record of history.json) expect(record).toMatchObject({ actor: "codex", recipient: "me" });
  expect(history.json.find((r: { operation: string }) => r.operation === "reminder_set").input).toMatchObject({ issueRef: "API-1", at: "2999-01-01", note: "確認する" });
  expect(history.json.find((r: { operation: string }) => r.operation === "delete").result).toMatchObject({ ids: [Number(id)], updated: 1 });
  const text = await runNod(["notification", "history"], { cwd, db, actor: "me" });
  expect(text.stdout).toContain("codex");
  expect(text.stdout).toContain("reminder_clear");
});

test("履歴導入前の DB は CLI 起動で移行しても既存データを変更しない", async () => {
  const db = tempDb();
  const cwd = makeRepo();
  const old = new Database(db);
  for (const migration of MIGRATIONS.slice(0, 55)) for (const step of migration) {
    if (typeof step === "string") old.exec(step); else step(old);
  }
  old.exec(`PRAGMA user_version=55;
    INSERT INTO workspaces (id,key,name,path,created_at,color) VALUES (1,'API','api','${cwd}','2026-01-01','#123456');
    INSERT INTO issues (id,workspace_id,number,title,status,created_by,created_at,updated_at) VALUES (1,1,1,'既存','todo','me','2026-01-01','2026-01-01');
    INSERT INTO subscriptions VALUES (1,'codex','2026-01-01');
    INSERT INTO reminders VALUES (1,'codex','2999-01-01','既存','2026-01-01');
    INSERT INTO notifications (recipient,issue_id,kind,event_type,actor,data,created_at) VALUES ('codex',1,'reminder','reminder','me','{}','2026-01-01');`);
  const tables = (old.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(r => r.name);
  const before = tables.map(t => old.query(`SELECT * FROM ${t}`).all());
  old.close();
  const migrated = await runNod(["notification", "history", "--json"], { cwd, db, actor: "codex" });
  expect(migrated.exitCode).toBe(0);
  expect(migrated.json).toEqual([]);
  const after = new Database(db);
  expect(tables.map(t => after.query(`SELECT * FROM ${t}`).all())).toEqual(before);
  expect(after.query("PRAGMA foreign_key_check").all()).toEqual([]);
  after.close();
});
