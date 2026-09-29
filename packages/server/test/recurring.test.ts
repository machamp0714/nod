import { describe, expect, test } from "bun:test";
import { addRecurringIssue, getIssue, listRecurringIssues, saveTemplate } from "@nod/core";
import { call, setup } from "./helpers";

const RULE = { title: "日次チェック", cadence: "daily", startDate: "2026-01-01", timeZone: "UTC" };

describe("定期Issue API", () => {
  test("登録・一覧・取得・変更・削除ができ、書き手は me になる", async () => {
    const { app, db, ws } = setup();
    const created = await call(app, "POST", `/api/workspaces/${ws.key}/recurring`, { ...RULE, labels: ["ops"], priority: 2 });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ ...RULE, labels: ["ops"], priority: 2, enabled: true, createdBy: "me" });
    const id = created.json.id;
    expect((await call(app, "GET", `/api/workspaces/${ws.key}/recurring`)).json).toHaveLength(1);
    expect((await call(app, "GET", `/api/workspaces/${ws.key}/recurring/${id}`)).json.title).toBe("日次チェック");
    const updated = await call(app, "PUT", `/api/workspaces/${ws.key}/recurring/${id}`, { cadence: "monthly", monthDay: 31, enabled: false });
    expect(updated.json).toMatchObject({ cadence: "monthly", monthDay: 31, enabled: false });
    expect((await call(app, "DELETE", `/api/workspaces/${ws.key}/recurring/${id}`)).status).toBe(200);
    expect(listRecurringIssues(db, ws.key)).toEqual([]);
  });

  test("run は dryRun なら書かず、実行すると起票して、再実行では作らない", async () => {
    const { app, db, ws, me } = setup();
    addRecurringIssue(me, ws.key, { title: "日次チェック", cadence: "daily", startDate: "2026-01-01", timeZone: "UTC" });
    const dry = await call(app, "POST", `/api/workspaces/${ws.key}/recurring/run`, { dryRun: true });
    expect(dry.json).toMatchObject({ dryRun: true, items: [{ issueId: null }] });
    const run = await call(app, "POST", `/api/workspaces/${ws.key}/recurring/run`);
    expect(run.status).toBe(200);
    expect(getIssue(db, run.json.items[0].issueId)).toMatchObject({ status: "todo", createdBy: "me" });
    expect((await call(app, "POST", `/api/workspaces/${ws.key}/recurring/run`, {})).json.items).toEqual([]);
  });

  test("不正な本文・ID・未登録の Workspace を拒む", async () => {
    const { app, ws } = setup();
    const url = `/api/workspaces/${ws.key}/recurring`;
    for (const body of [{}, { ...RULE, cadence: "yearly" }, { ...RULE, weekday: "mon" }, { ...RULE, enabled: "yes" }, { ...RULE, actor: "codex" }, "{"]) {
      const res = await call(app, "POST", url, body);
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe("INVALID_ARGS");
    }
    expect((await call(app, "GET", `${url}/abc`)).status).toBe(400);
    expect((await call(app, "GET", `${url}/99`)).status).toBe(404);
    expect((await call(app, "POST", `${url}/run`, { dryRun: "x" })).status).toBe(400);
    expect((await call(app, "GET", "/api/workspaces/NOPE/recurring")).status).toBe(404);
  });

  test("テンプレートの一覧を返す", async () => {
    const { app, db } = setup();
    saveTemplate(db, { name: "review", body: "## 振り返り" });
    expect((await call(app, "GET", "/api/templates")).json).toMatchObject([{ name: "review", body: "## 振り返り" }]);
  });
});
