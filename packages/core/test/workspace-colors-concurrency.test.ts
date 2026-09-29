import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDb, schemaVersion } from "../src/db";
import { initWorkspace, listWorkspaces } from "../src/ops/workspaces";
import { MIGRATIONS } from "../src/schema";
import { tempDbPath } from "./helpers";

const dbModule = new URL("../src/db.ts", import.meta.url).href;
const opsModule = new URL("../src/ops/workspaces.ts", import.meta.url).href;

async function concurrent(path: string, actions: { key: string; remove?: boolean }[], timeout = 5000) {
  const gate = join(dirname(path), `start-${crypto.randomUUID()}`);
  const ready: string[] = [];
  const processes = actions.map((action, index) => {
    const mark = `${gate}-${index}`;
    ready.push(mark);
    const source = `
      import { existsSync, writeFileSync } from "node:fs";
      import { openDb } from ${JSON.stringify(dbModule)};
      import { initWorkspace, removeWorkspace } from ${JSON.stringify(opsModule)};
      const [path, gate, mark, raw, timeout] = process.argv.slice(1);
      const action = JSON.parse(raw);
      writeFileSync(mark, "ready");
      while (!existsSync(gate)) await Bun.sleep(5);
      let db;
      try {
        db = openDb(path, { busyTimeoutMs: Number(timeout) });
        const result = action.remove ? removeWorkspace(db, action.key) : initWorkspace(db, { path: "/repos/" + action.key, key: action.key });
        console.log(JSON.stringify(result));
      } catch (error) { console.log(JSON.stringify({ error: error.code, message: error.message })); }
      finally { db?.close(); }
    `;
    return Bun.spawn([process.execPath, "-e", source, path, gate, mark, JSON.stringify(action), String(timeout)], {
      env: { ...process.env, NOD_DB: path, NOD_ORCA: "0", NOD_ACTOR: "codex" }, stdout: "pipe", stderr: "pipe",
    });
  });
  try {
    const deadline = Date.now() + 5000;
    while (!ready.every((mark) => existsSync(mark))) {
      if (Date.now() > deadline) throw new Error("子プロセスの開始準備が完了しません");
      await Bun.sleep(5);
    }
    writeFileSync(gate, "start");
    return await Promise.all(processes.map(async (proc) => {
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      return JSON.parse(stdout);
    }));
  } finally {
    for (const proc of processes) if (proc.exitCode === null) proc.kill();
    await Promise.all(processes.map((proc) => proc.exited));
  }
}

test("別プロセスの同時登録は一意の色を保存する", async () => {
  const path = tempDbPath();
  openDb(path).close();
  const results = await concurrent(path, [{ key: "API" }, { key: "WEB" }]);
  for (const result of results) expect(result.workspace.color).toMatch(/^#[0-9A-F]{6}$/);
  expect(results[0].workspace.color).not.toBe(results[1].workspace.color);
  const db = openDb(path);
  expect(listWorkspaces(db)).toHaveLength(2);
  db.close();
});

test("同時openで旧DBを一度だけ移行して既存色を保存する", async () => {
  const path = tempDbPath();
  const raw = new Database(path, { create: true });
  raw.exec("PRAGMA journal_mode=WAL");
  for (const sql of MIGRATIONS[0]!) { if (typeof sql === "string") raw.exec(sql); }
  raw.exec("INSERT INTO workspaces (key,name,path,created_at) VALUES ('OLD','old','/old','2000')");
  raw.exec("PRAGMA user_version=1");
  raw.close();
  const results = await concurrent(path, [{ key: "API" }, { key: "WEB" }]);
  expect(results.every((result) => result.created)).toBe(true);
  const db = openDb(path);
  expect(schemaVersion(db)).toBe(2);
  const rows = listWorkspaces(db);
  expect(rows.find((row) => row.key === "OLD")?.color).toBe("#7C5CFF");
  expect(new Set(rows.map((row) => row.color)).size).toBe(3);
  db.close();
});

test("ロック競合はDB_BUSYで行を残さず、解除後に登録できる", async () => {
  const path = tempDbPath();
  const db = openDb(path);
  db.exec("BEGIN IMMEDIATE");
  try {
    const [blocked] = await concurrent(path, [{ key: "API" }], 30);
    expect(blocked.error).toBe("DB_BUSY");
    expect(listWorkspaces(db)).toHaveLength(0);
  } finally { db.exec("ROLLBACK"); }
  const [retry] = await concurrent(path, [{ key: "API" }]);
  expect(retry.created).toBe(true);
  expect(retry.workspace.color).toMatch(/^#[0-9A-F]{6}$/);
  db.close();
});

test("削除と登録が競合しても残存色を変えず重複しない", async () => {
  const path = tempDbPath();
  const db = openDb(path);
  initWorkspace(db, { path: "/repos/API", key: "API" });
  const keep = initWorkspace(db, { path: "/repos/KEEP", key: "KEEP" }).workspace;
  const results = await concurrent(path, [{ key: "API", remove: true }, { key: "WEB" }]);
  expect(results.every((result) => !result.error)).toBe(true);
  const rows = listWorkspaces(db);
  expect(rows.find((row) => row.key === "KEEP")).toEqual(keep);
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((row) => row.color)).size).toBe(2);
  db.close();
});
