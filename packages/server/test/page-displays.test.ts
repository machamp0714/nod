import { describe, expect, test } from "bun:test";
import { call, setup } from "./helpers";

describe("ページの表示設定の API", () => {
  test("保存・一覧・上書き・削除ができ、エンコードしたキーも受け付ける", async () => {
    const { app } = setup();
    expect((await call(app, "GET", "/api/page-displays")).json).toEqual({});
    const put = await call(app, "PUT", "/api/page-displays/issues", { display: { layout: "board", groupBy: "project", sort: "default" } });
    expect(put.status).toBe(200);
    expect(put.json).toEqual({ layout: "board", groupBy: "project" });
    await call(app, "PUT", `/api/page-displays/${encodeURIComponent("project:1")}`, { display: { layout: "board" } });
    await call(app, "PUT", "/api/page-displays/project:2", { display: {} });
    expect((await call(app, "GET", "/api/page-displays")).json).toEqual({
      issues: { layout: "board", groupBy: "project" },
      "project:1": { layout: "board" },
      "project:2": {},
    });
    expect((await call(app, "DELETE", "/api/page-displays/issues")).json).toEqual({ ok: true });
    expect(Object.keys((await call(app, "GET", "/api/page-displays")).json)).toEqual(["project:1", "project:2"]);
  });

  test("不正なページ・本文・tab は 400", async () => {
    const { app } = setup();
    for (const [path, body] of [
      ["/api/page-displays/views", { display: {} }],
      ["/api/page-displays/project:abc", { display: {} }],
      ["/api/page-displays/issues", {}],
      ["/api/page-displays/issues", { display: { tab: "ready" } }],
      ["/api/page-displays/issues", { display: {}, extra: 1 }],
    ] as const) {
      const r = await call(app, "PUT", path, body);
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe("INVALID_ARGS");
    }
  });
});
