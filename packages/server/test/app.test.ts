import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NodError } from "@nod/core";
import { ERROR_STATUS, toErrorResponse } from "../src/errors";
import { call, setup } from "./helpers";

// core のソースから、投げうるエラーコードを集める
function coreErrorCodes(): string[] {
  const dir = join(import.meta.dir, "../../core/src");
  const codes = new Set<string>();
  for (const file of new Bun.Glob("**/*.ts").scanSync({ cwd: dir })) {
    const src = readFileSync(join(dir, file), "utf8");
    for (const m of src.matchAll(/new NodError\(\s*"([A-Z_]+)"/g)) codes.add(m[1] as string);
    // human.ts の requireStatus(row, ref, "triage", "NOT_IN_TRIAGE") の形
    for (const m of src.matchAll(/requireStatus\([^)]*?"([A-Z_]+)"\s*\)/g)) codes.add(m[1] as string);
  }
  return [...codes].sort();
}

describe("エラーの対応表", () => {
  test("core が投げるコードは、すべて対応表にある", () => {
    const codes = coreErrorCodes();
    // 集め方が壊れていないことを、既知のコードで確かめる
    expect(codes).toContain("NOT_IN_TRIAGE");
    expect(codes).toContain("NEEDS_CLARIFICATION");
    expect(codes).toContain("VIEW_EXISTS");
    expect(codes.filter((c) => !(c in ERROR_STATUS))).toEqual([]);
  });

  test("コードに応じたステータスと、CLI の --json と同じ形の本文を返す", () => {
    expect(toErrorResponse(new NodError("INVALID_ARGS", "x"))).toEqual({
      status: 400,
      body: { error: { code: "INVALID_ARGS", message: "x" } },
    });
    expect(toErrorResponse(new NodError("NOT_FOUND", "x")).status).toBe(404);
    expect(toErrorResponse(new NodError("NOT_IN_TRIAGE", "x")).status).toBe(409);
    expect(toErrorResponse(new NodError("VIEW_EXISTS", "x")).status).toBe(409);
    expect(toErrorResponse(new NodError("DB_BUSY", "x")).status).toBe(503);
    expect(toErrorResponse(new NodError("SOMETHING_NEW", "x")).status).toBe(500);
  });

  test("SQLite のロックの例外は DB_BUSY、それ以外の例外は INTERNAL にする", () => {
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    expect(toErrorResponse(busy)).toMatchObject({ status: 503, body: { error: { code: "DB_BUSY" } } });
    expect(toErrorResponse(new Error("boom"))).toEqual({
      status: 500,
      body: { error: { code: "INTERNAL", message: "boom" } },
    });
  });
});

describe("createApp", () => {
  test("外部サイトからの書き込みを拒否し、View を変えない", async () => {
    const { app } = setup();
    const view = (await call(app, "POST", "/api/views", { name: "元の名前" })).json;
    const sources: Record<string, string>[] = [
      { origin: "https://untrusted.example" },
      { "sec-fetch-site": "cross-site" },
      { origin: "null" },
      { origin: "invalid-url" },
      { origin: "ftp://localhost" },
      { origin: "http://localhost.untrusted.example" },
    ];
    for (const headers of sources) {
      for (const method of ["POST", "PUT", "DELETE"]) {
        const res = await app.request(method === "POST" ? "/api/views" : `/api/views/${view.id}`, {
          method,
          headers: { ...headers, "content-type": "text/plain" },
          body: method === "DELETE" ? undefined : JSON.stringify({ name: "変更後" }),
        });
        expect(res.status).toBe(403);
        expect((await res.json() as { error: { code: string } }).error.code).toBe("FORBIDDEN_ORIGIN");
      }
    }
    expect((await call(app, "GET", "/api/views")).json).toEqual([view]);
  });

  test("ローカルの開発画面とヘッダーのない呼び出しから書き込める", async () => {
    const { app } = setup();
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:4700", "http://[::1]:5173"]) {
      const res = await app.request("/api/views", {
        method: "POST",
        headers: { origin, "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ name: origin }),
      });
      expect(res.status).toBe(201);
    }
    expect((await call(app, "POST", "/api/views", { name: "直接" })).status).toBe(201);
  });

  test("GET /api/workspaces は登録済みの Workspace を返す", async () => {
    const { app } = setup();
    const r = await call(app, "GET", "/api/workspaces");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject([{ key: "API", path: "/tmp/repos/api-server" }]);
  });

  test("/api/ の知らないパスやメソッドは JSON の 404", async () => {
    const { app } = setup();
    for (const [method, path] of [
      ["GET", "/api/nope"],
      ["POST", "/api/workspaces"],
      ["GET", "/api"],
    ] as const) {
      const r = await call(app, method, path);
      expect(r.status).toBe(404);
      expect(r.json.error.code).toBe("NOT_FOUND");
    }
  });

  test("/api/ の外の知らないパスも JSON の 404（staticDir がないとき）", async () => {
    const { app } = setup();
    const r = await call(app, "GET", "/issues");
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("NOT_FOUND");
  });
});
