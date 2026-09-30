import { describe, expect, test } from "bun:test";
import { addRecurringIssue, getTemplate, listTemplates, saveTemplate } from "@nod/core";
import { call, setup } from "./helpers";

describe("テンプレート API（#160）", () => {
  test("登録・一覧・本文の置き換え・削除ができる", async () => {
    const { app, db } = setup();
    const created = await call(app, "POST", "/api/templates", { name: " bug ", body: "## 再現手順\n" });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ name: "bug", body: "## 再現手順\n" });
    await call(app, "POST", "/api/templates", { name: "a/b c", body: "x" });
    expect((await call(app, "GET", "/api/templates")).json.map((t: { name: string }) => t.name)).toEqual(["a/b c", "bug"]);

    const updated = await call(app, "POST", "/api/templates/update", { name: "bug", body: "## 再現手順\n\n## 期待\n" });
    expect(updated.status).toBe(200);
    expect(updated.json).toMatchObject({ name: "bug", body: "## 再現手順\n\n## 期待\n" });
    expect(getTemplate(db, "bug").body).toBe("## 再現手順\n\n## 期待\n");

    const removed = await call(app, "POST", "/api/templates/remove", { name: "a/b c" });
    expect(removed.status).toBe(200);
    expect(removed.json).toEqual({ name: "a/b c", removed: true });
    expect(listTemplates(db).map((t) => t.name)).toEqual(["bug"]);
  });

  test("同じ名前の登録は 409 TEMPLATE_EXISTS で本文を変えず、ないものの置き換え・削除は 404", async () => {
    const { app, db, me } = setup();
    saveTemplate(me, { name: "bug", body: "v1" });
    const dup = await call(app, "POST", "/api/templates", { name: "bug", body: "v2" });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe("TEMPLATE_EXISTS");
    expect(getTemplate(db, "bug").body).toBe("v1");
    expect((await call(app, "POST", "/api/templates/update", { name: "none", body: "x" })).status).toBe(404);
    expect((await call(app, "POST", "/api/templates/remove", { name: "none" })).status).toBe(404);
    expect(listTemplates(db).map((t) => t.name)).toEqual(["bug"]);
  });

  test("不正な本文を 400 INVALID_ARGS で拒み、何も書き込まない", async () => {
    const { app, db } = setup();
    const cases: [string, unknown][] = [
      ["/api/templates", {}],
      ["/api/templates", { name: "bug" }],
      ["/api/templates", { name: " ", body: "x" }],
      ["/api/templates", { name: "bug", body: " \n" }],
      ["/api/templates", { name: "bug", body: 1 }],
      ["/api/templates", { name: "bug", body: "x", actor: "codex" }],
      ["/api/templates", "{"],
      ["/api/templates/update", { name: "bug" }],
      ["/api/templates/update", { name: "bug", body: "" }],
      ["/api/templates/remove", {}],
    ];
    for (const [url, body] of cases) {
      const res = await call(app, "POST", url, body);
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe("INVALID_ARGS");
    }
    expect(listTemplates(db)).toEqual([]);
  });

  test("定期Issue が使うテンプレートも消せ、定期Issue は残る", async () => {
    const { app, db, me, ws } = setup();
    saveTemplate(me, { name: "weekly", body: "## 手順" });
    addRecurringIssue(me, ws.key, { title: "週次", template: "weekly", cadence: "daily", startDate: "2026-01-01", timeZone: "UTC" });
    expect((await call(app, "POST", "/api/templates/remove", { name: "weekly" })).status).toBe(200);
    expect(listTemplates(db)).toEqual([]);
    expect((await call(app, "GET", `/api/workspaces/${ws.key}/recurring`)).json).toMatchObject([{ template: "weekly" }]);
  });
});
