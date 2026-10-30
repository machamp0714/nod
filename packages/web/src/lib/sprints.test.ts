import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { archiveIssue, deleteIssue, getSprint, openDb, updateIssue } from "@nod/core";
import { legacySprintFixture } from "../../../core/test/fixtures/sprint";
import { tempDbPath } from "../../../core/test/helpers";
import { sprintSnapshotRows } from "./sprints";

test("履歴の親キーは保存済みの根拠だけから読み、期間外の親キーを推定しない", () => {
  const path = tempDbPath(); legacySprintFixture(path);
  const old = new Database(path);
  old.exec(`UPDATE issues SET parent_id=3 WHERE id=1;
    UPDATE issues SET parent_id=1 WHERE id=2;`);
  old.close();
  const db = openDb(path);
  updateIssue({db,actor:"me"}, "BBB-1", {parentRef:null});
  archiveIssue({db,actor:"me"}, "AAA-1"); deleteIssue({db,actor:"me"}, "AAA-1");
  const rows = sprintSnapshotRows(getSprint(db,"1"));
  expect(rows.map(row => [row.issue.id,row.issue.parentId,row.hasParent])).toEqual([
    ["AAA-1",null,true], ["BBB-1","AAA-1",true],
  ]);
  db.close();
});
