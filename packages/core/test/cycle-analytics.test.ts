import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { openDb } from "../src/db";
import { getSprint } from "../src/ops/sprints";
import { cycleAnalytics, sprintAnalytics } from "../src/ops/cycle-analytics";
import { archiveIssue, updateIssue } from "../src/ops/issues";
import { deleteIssue } from "../src/ops/issue-deletions";
import { legacySprintFixture } from "./fixtures/sprint";
import { tempDbPath } from "./helpers";

test("移行時の分析を取得済みの写しから読み、過去終了時点とみなさずIssue変更・削除後も保つ", () => {
  const path=tempDbPath(); legacySprintFixture(path); const db=openDb(path);
  const sprint=getSprint(db,"1");
  const result=sprintAnalytics(db,sprint.id);
  expect(result).toMatchObject({sprintId:sprint.id,number:1,statusBasis:"migration_snapshot",scope:2,completed:1,started:0});
  expect(result.capturedAt).toBe(sprint.legacy!.capturedAt);
  expect(result.history).toMatchObject({timezone:null,unavailableReason:"timezone_unknown"});
  expect(result.burnup).toEqual([]);
  expect(result.breakdown.workspaces.map(row=>[row.key,row.total])).toEqual([["AAA",1],["BBB",1]]);
  expect(cycleAnalytics(db,"1")).toEqual(result);
  updateIssue({db,actor:"me"},"AAA-1",{title:"後の要求",status:"todo"});
  archiveIssue({db,actor:"me"},"BBB-1");
  deleteIssue({db,actor:"me"},"BBB-1");
  expect(sprintAnalytics(db,sprint.id)).toEqual(result);
  expect(()=>cycleAnalytics(db,"99")).toThrow("削除");
  expect(()=>cycleAnalytics(db,"100")).toThrow("ありません");
  db.close();
});

test("明示した日時解釈では取得済みイベントだけで推移を読み、移行後の完了を過去へ補わない", () => {
  const path=tempDbPath(); legacySprintFixture(path); const db=openDb(path);
  const result=sprintAnalytics(db,"1",{timezone:"UTC",clock:{now:new Date('2026-10-26T00:00:00.000Z')}});
  expect(result.completed).toBe(1);
  expect(result.history).toMatchObject({timezone:"UTC",timezoneBasis:"requested",unavailableReason:null,recordedEventIds:[1,3],ambiguousEventIds:[2]});
  expect(result.burnup).toHaveLength(14);
  expect(result.burnup[0]).toEqual({date:"2026-01-01",scope:1,started:0,completed:0,unknown:0});
  expect(result.burnup.at(-1)).toEqual({date:"2026-01-14",scope:2,started:0,completed:0,unknown:0});
  expect(result.scopeAdded).toBe(1);
  expect(()=>sprintAnalytics(db,"1",{timezone:"+09:00"})).toThrow("タイムゾーン");
  db.close();
});

test("旧ID再利用疑いと欠落イベントを推測で埋めず、確定関連と分けて返す", () => {
  const path=tempDbPath(); legacySprintFixture(path);
  const old=new Database(path);
  old.exec("UPDATE events SET created_at='2025-01-01T03:00:00.000Z' WHERE id=1; DELETE FROM events WHERE id=3;"); old.close();
  const db=openDb(path);
  const before=getSprint(db,"1");
  const result=sprintAnalytics(db,"1",{timezone:"UTC",clock:{now:new Date('2026-10-26T00:00:00.000Z')}});
  expect(result.history.recordedEventIds).toEqual([]);
  expect(result.history.ambiguousEventIds).toEqual([1,2]);
  expect(result.burnup[0]).toEqual({date:"2026-01-01",scope:null,started:null,completed:null,unknown:2});
  expect(result.scopeAdded).toBeNull();
  expect(result.completed).toBe(1);
  expect(getSprint(db,"1").events).toEqual(before.events);
  db.close();
});

test("期間作成前の既知状態を後日の明示所属に引き継ぎ、作成前の同ID所属は確定しない", () => {
  const path=tempDbPath(); legacySprintFixture(path);
  const old=new Database(path);
  old.exec(`UPDATE cycles SET start_date='2026-10-01',end_date='2026-10-03',created_at='2026-10-01T00:00:00.000Z' WHERE id=1;
    DELETE FROM events;
    INSERT INTO events(id,issue_id,type,data,actor,created_at) VALUES
      (1,1,'created','{"status":"todo","cycle_id":1}','me','2026-09-01T00:00:00.000Z'),
      (2,2,'created','{"status":"todo","cycle_id":null}','me','2026-09-01T00:00:00.000Z'),
      (3,2,'status_changed','{"from":"todo","to":"in_progress"}','me','2026-09-02T00:00:00.000Z'),
      (4,1,'cycle_changed','{"from_id":null,"to_id":1}','me','2026-10-02T00:00:00.000Z'),
      (5,2,'cycle_changed','{"from_id":null,"to_id":1}','me','2026-10-02T00:00:00.000Z');`);
  old.close();
  const db=openDb(path);
  const result=sprintAnalytics(db,"1",{timezone:"UTC",clock:{now:new Date('2026-10-04T00:00:00.000Z')}});
  expect(result.burnup).toEqual([
    {date:"2026-10-01",scope:null,started:null,completed:null,unknown:2},
    {date:"2026-10-02",scope:2,started:1,completed:0,unknown:0},
    {date:"2026-10-03",scope:2,started:1,completed:0,unknown:0},
  ]);
  expect(result.history.ambiguousEventIds).toContain(1);
  expect(sprintAnalytics(db,"1").history.timezoneBasis).toBe("unknown");
  db.close();
});
