import { describe, expect, test } from "bun:test";
import { createIssue, getIssue, initWorkspace, setCadence } from "@nod/core";
import { call, setup } from "./helpers";

// 期間は遠い将来・過去にして、実行日に左右されないようにする
const PAST = { name: "過去", startDate: "2000-01-01", endDate: "2000-01-14" };
const FUTURE = { name: "未来", startDate: "2999-01-01", endDate: "2999-01-14" };

describe("Cycle API", () => {
  test("作成・一覧・詳細・更新・削除と、Issue の Cycle の変更・絞り込み", async () => {
    const { app, db, ws, me } = setup();
    const past = await call(app, "POST", "/api/cycles", PAST);
    expect(past.status).toBe(201);
    expect(past.json).toMatchObject({ name: "過去", state: "completed", total: 0, open: 0 });
    const future = (await call(app, "POST", "/api/cycles", FUTURE)).json;
    expect(future.state).toBe("upcoming");
    expect((await call(app, "GET", "/api/cycles")).json.map((c: { name: string }) => c.name)).toEqual(["過去", "未来"]);
    expect((await call(app, "GET", "/api/cycles?tz=Asia/Tokyo")).json).toHaveLength(2);

    const issue = createIssue(me, { workspaceId: ws.id, title: "作業" });
    const updated = await call(app, "POST", `/api/issues/${issue.id}/update`, { cycleRef: String(past.json.id) });
    expect(updated.json.cycle).toEqual({ id: past.json.id, name: "過去" });
    expect((await call(app, "GET", `/api/issues?cycle=${past.json.id}`)).json.issues.map((i: { id: string }) => i.id)).toEqual([issue.id]);
    const loose = createIssue(me, { workspaceId: ws.id, title: "Cycle の外" });
    expect((await call(app, "GET", "/api/issues?cycle=none")).json.issues.map((i: { id: string }) => i.id)).toEqual([loose.id]);
    expect((await call(app, "GET", `/api/cycles/${past.json.id}`)).json).toMatchObject({ total: 1, open: 1, issues: [{ id: issue.id }] });

    const bulk = await call(app, "POST", "/api/issues/bulk-update", { ids: [issue.id], cycleRef: null });
    expect(bulk.json[0].cycle).toBeNull();

    expect((await call(app, "POST", `/api/cycles/${future.id}/update`, { name: "次" })).json.name).toBe("次");
    expect((await call(app, "DELETE", `/api/cycles/${future.id}`)).json).toMatchObject({ name: "次", issues: 0 });
    expect((await call(app, "GET", "/api/cycles")).json).toHaveLength(1);
  });

  test("別 Workspace の Issue を同じ Cycle に入れられる", async () => {
    const { app, db, ws, me } = setup();
    const other = initWorkspace(db, { path: "/tmp/repos/web" }).workspace;
    const past = (await call(app, "POST", "/api/cycles", PAST)).json;
    const a = createIssue(me, { workspaceId: ws.id, title: "API", cycleRef: String(past.id) });
    const b = createIssue(me, { workspaceId: other.id, title: "Web" });
    expect((await call(app, "POST", `/api/issues/${b.id}/update`, { cycleRef: String(past.id) })).json.cycle).toEqual({ id: past.id, name: "過去" });
    expect((await call(app, "GET", `/api/cycles/${past.id}`)).json.issues.map((i: { id: string }) => i.id)).toEqual([a.id, b.id]);
    expect((await call(app, "GET", `/api/issues?cycle=${encodeURIComponent("過去")}`)).json.issues.map((i: { id: string }) => i.id)).toEqual([a.id, b.id]);
    expect(getIssue(db, b.id).cycle?.name).toBe("過去");
  });

  test("重複・不正値・不存在と、廃止した経路を拒む", async () => {
    const { app, db, ws, me } = setup();
    const past = (await call(app, "POST", "/api/cycles", PAST)).json;
    const issue = createIssue(me, { workspaceId: ws.id, title: "作業" });
    for (const [method, path, body, status, code] of [
      ["POST", "/api/cycles", { ...PAST, name: "別名" }, 409, "CYCLE_OVERLAP"],
      ["POST", "/api/cycles", { ...FUTURE, name: "過去" }, 409, "CYCLE_EXISTS"],
      ["POST", "/api/cycles", { name: "x", startDate: "2999-02-02", endDate: "2999-02-01" }, 400, "INVALID_ARGS"],
      ["POST", "/api/cycles", { name: "x", startDate: "2999-02-01" }, 400, "INVALID_ARGS"],
      ["POST", "/api/cycles", { ...FUTURE, actor: "codex" }, 400, "INVALID_ARGS"],
      ["POST", `/api/workspaces/${ws.key}/cycles`, FUTURE, 404, "NOT_FOUND"],
      ["GET", "/api/cycles/999", undefined, 404, "NOT_FOUND"],
      ["GET", "/api/cycles?tz=%2B09:00", undefined, 400, "INVALID_ARGS"],
      ["POST", `/api/cycles/${past.id}/update`, {}, 400, "INVALID_ARGS"],
      ["POST", `/api/cycles/${past.id}/move-open`, { to: String(past.id) }, 404, "NOT_FOUND"],
      ["POST", `/api/issues/${issue.id}/update`, { cycleRef: "999" }, 404, "NOT_FOUND"],
      ["GET", "/api/issues?cycle=ない", undefined, 404, "NOT_FOUND"],
    ] as const) {
      const res = await call(app, method, encodeURI(path), body);
      expect([path, res.status, res.json.error.code]).toEqual([path, status, code]);
    }
    expect(getIssue(db, issue.id).cycle).toBeNull();
  });

  test("周期があっても、不正な tz は tz を使わない API を拒まない。tz を使う API は従来どおり拒む", async () => {
    const { app, me } = setup();
    setCadence(me, { weeks: 2 });
    expect((await call(app, "GET", "/api/workspaces?tz=%2B09:00")).status).toBe(200);
    expect((await call(app, "GET", "/api/cycles?tz=%2B09:00")).json.error.code).toBe("INVALID_ARGS");
    expect((await call(app, "GET", "/api/cycles")).json.map((c: { name: string }) => c.name)).toEqual(["Cycle 1", "Cycle 2"]);
  });

  test("分析と要約の API で cycle を受け付け、none（Cycle のない Issue）は Issue 一覧と同じく扱う", async () => {
    const { app, ws, me } = setup();
    const past = (await call(app, "POST", "/api/cycles", PAST)).json;
    createIssue(me, { workspaceId: ws.id, title: "入り", cycleRef: String(past.id) });
    createIssue(me, { workspaceId: ws.id, title: "外" });
    const titles = async (query: string) => {
      const res = await call(app, "GET", `/api/summary?${query}`);
      expect(res.status).toBe(200);
      return [...new Set(res.json.sections.flatMap((sec: { items: { title: string }[] }) => sec.items.map((i) => i.title)))];
    };
    expect(await titles(`cycle=${past.id}`)).toEqual(["入り"]);
    expect(await titles("cycle=none")).toEqual(["外"]);
    expect(await titles("cycle=%20None%20")).toEqual(["外"]);
    expect((await call(app, "GET", `/api/stats?cycle=${past.id}`)).status).toBe(200);
    expect((await call(app, "GET", "/api/stats?cycle=none")).status).toBe(200);
    expect((await call(app, "GET", "/api/stats/llm?cycle=none")).status).toBe(200);
    // milestone=none も Issue 一覧と同じく Milestone のない Issue を指す
    expect((await call(app, "GET", "/api/stats?milestone=none")).status).toBe(200);
    expect((await call(app, "GET", "/api/stats/llm?milestone=NONE&cycle=none")).status).toBe(200);
    expect((await call(app, "GET", "/api/issues?milestone=None&cycle=NONE")).json.issues.map((i: { title: string }) => i.title)).toEqual(["外"]);
  });

  test("周期の設定と、各リクエストの最初の自動作成・分析", async () => {
    const { app } = setup();
    expect((await call(app, "GET", "/api/cycle-cadence")).json).toBeNull();
    const today = new Intl.DateTimeFormat("en-CA").format(new Date()); // サーバーと同じローカルの暦日 YYYY-MM-DD
    const put = await call(app, "PUT", "/api/cycle-cadence", { weeks: 2, anchorDate: today });
    expect(put.json).toMatchObject({ weeks: 2, autoCarryOver: true });
    const list = (await call(app, "GET", "/api/cycles")).json; // ミドルウェアで作られる
    expect(list.map((c: { name: string }) => c.name)).toEqual(["Cycle 1", "Cycle 2"]);
    const analytics = (await call(app, "GET", `/api/cycles/${list[0].id}/analytics`)).json;
    expect(analytics).toMatchObject({ cycleId: list[0].id, scope: 0, completedRate: null });
    expect((await call(app, "PUT", "/api/cycle-cadence", { weeks: 9 })).status).toBe(400);
    expect((await call(app, "PUT", "/api/cycle-cadence", {})).status).toBe(400);
    expect((await call(app, "DELETE", "/api/cycle-cadence")).json).toEqual({ ok: true });
  });
});
