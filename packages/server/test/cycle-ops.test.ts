import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createIssue, getIssue, listSprints, listViews, openDb, queryIssues } from "@nod/core";
import { addInReview } from "../../core/src/migrations/add-in-review";
import { addActiveSprint, legacySprintFixture } from "../../core/test/fixtures/sprint";
import { createApp } from "../src/app";
import { call, setup, tempDir } from "./helpers";

test("旧Cycleと周期のAPIは入力によらず廃止案内を返し、Issueの他属性も部分変更しない", async () => {
  const {app,db,ws,me} = setup();
  const issue = createIssue(me,{workspaceId:ws.id,title:"元の要求"});
  const before = getIssue(db,issue.id);
  for (const [method,path,body] of [
    ["POST","/api/cycles",{}], ["POST","/api/cycles/不明/update",{name:"変更"}],
    ["DELETE","/api/cycles/1",undefined], ["PUT","/api/cycle-cadence",{}],
    ["DELETE","/api/cycle-cadence",undefined],
    ["POST","/api/views",{name:"旧条件",filter:{cycle:"current"}}], ["GET","/api/cycle-cadence",undefined],
    ["POST",`/api/issues/${issue.id}/update`,{title:"変更",cycleRef:null}],
    ["POST","/api/issues/bulk-update",{ids:[issue.id],priority:1,cycleRef:3}],
    ["POST",`/api/issues/${issue.id}/accept`,{priority:1,cycleRef:"1"}],
  ] as const) {
    const res = await call(app,method,path,body);
    expect([path,res.status,res.json.error.code]).toEqual([path,410,"CYCLE_RETIRED"]);
    expect(res.json.error.message).toContain("Sprint");
    expect(getIssue(db,issue.id)).toEqual(before);
  }
  expect(listViews(db)).toEqual([]);
  expect(listSprints(db)).toEqual([]);
  expect(queryIssues(db,{}).issues).toHaveLength(1);
  db.close();
});

test("レビュー中は移行した旧Cycleの写し・推移と採択Sprintで未完了・着手済みとして集計される", async () => {
  const path = join(tempDir(), "nod.db");
  legacySprintFixture(path);
  const old = new Database(path);
  addInReview(old);
  old.exec(`PRAGMA user_version=43;
    UPDATE issues SET status='in_review' WHERE id=1;
    UPDATE issues SET status='canceled' WHERE id=2;
    UPDATE events SET data='{"cycle_id":1,"status":"canceled"}' WHERE id=3;
    DELETE FROM events WHERE id=2;
    INSERT INTO events(issue_id,actor,type,data,created_at) VALUES
      (1,'codex','status_changed','{"from":"in_progress","to":"in_review","review_semantics":"pr_review"}','2026-01-01T04:00:00.000Z');`);
  old.close();
  const db = openDb(path);
  const app = createApp({ db });
  const analytics = (await call(app, "GET", "/api/cycles/1/analytics?tz=UTC")).json;
  expect(analytics).toMatchObject({ scope: 1, started: 1, completed: 0, startedRate: 1, completedRate: 0,
    burnup: expect.arrayContaining([{ date: "2026-01-14", scope: 1, started: 1, completed: 0, unknown: 0 }]) });
  expect(analytics.statuses).toContainEqual({ status: "in_review", count: 1 });
  const activeId = addActiveSprint(db, 1, 5, ["AAA-1"]);
  expect((await call(app, "GET", `/api/sprints/${activeId}/analytics?tz=UTC`)).json).toMatchObject({ scope: 1, started: 1, completed: 0 });
  db.close();
});
