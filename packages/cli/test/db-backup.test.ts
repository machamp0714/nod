import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { MIGRATIONS } from "../../core/src/schema";
import { makeRepo, runNod, tempDb } from "./helpers";

test("旧版の DB を開くと、移行前のコピーが DB の隣の backups/ に 1 世代増える", async () => {
  const db = tempDb();
  const raw = new Database(db, { create: true });
  for (const step of MIGRATIONS[0]!) if (typeof step === "string") raw.exec(step);
  raw.exec("PRAGMA user_version = 1");
  raw.close();
  const backups = join(dirname(db), "backups");
  const r = await runNod(["workspace", "list", "--json"], { cwd: makeRepo("api-server"), db });
  expect(r.exitCode).toBe(0);
  expect(readdirSync(backups)).toHaveLength(1);
  // 現行版になったので、続けて開いても増えない
  await runNod(["workspace", "list", "--json"], { cwd: makeRepo("api-server"), db });
  expect(readdirSync(backups)).toHaveLength(1);
});
