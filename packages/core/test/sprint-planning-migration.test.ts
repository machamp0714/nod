import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { getSprint, listSprints, nextSprintNumber, openDb, resolveLegacyCycle } from "../src/index";
import { MIGRATIONS } from "../src/schema";
import { legacySprintFixture } from "./fixtures/sprint";
import { tempDbPath } from "./helpers";

test("版43のSprint移行履歴を版44へ欠落なく移し、対応IDと共通採番を維持する", () => {
  const path = tempDbPath(); legacySprintFixture(path);
  const old = new Database(path);
  for (const step of MIGRATIONS[42]!) { if (typeof step === "string") old.exec(step); else step(old); }
  old.exec("PRAGMA user_version=43");
  const originals = old.query("SELECT * FROM sprints ORDER BY number").all() as {id:string;number:number;legacy_cycle_id:number;legacy_data:string}[];
  const snapshots = old.query("SELECT snapshot FROM sprint_items ORDER BY source_issue_key").all() as {snapshot:string}[];
  old.close();
  const db = openDb(path);
  expect(listSprints(db).map(s=>[s.id,s.number,s.phase])).toEqual(originals.map(s=>[s.id,s.number,"imported"]));
  for (const original of originals) {
    expect(getSprint(db,original.id).legacy).toEqual(JSON.parse(original.legacy_data));
    expect(resolveLegacyCycle(db,original.legacy_cycle_id)).toEqual({kind:"imported",sprintId:original.id});
  }
  expect(getSprint(db,originals[0]!.id).items.map(i=>i.snapshot)).toEqual(snapshots.map(r=>JSON.parse(r.snapshot)));
  expect(nextSprintNumber(db)).toBe(5);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.query("PRAGMA integrity_check").get()).toEqual({integrity_check:"ok"});
  db.close();
});
