import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "@nod/core";
import { createApp } from "../src/app";
import { call, tempDir } from "./helpers";

// <tmp>/secret.txt と <tmp>/dist/{index.html, assets/app.js} を作る
function setupStatic(withIndex = true) {
  const root = tempDir();
  writeFileSync(join(root, "secret.txt"), "SECRET");
  const dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  if (withIndex) writeFileSync(join(dist, "index.html"), "<!doctype html><div id=root></div>");
  writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
  const db = openDb(join(root, "nod.db"));
  return createApp({ db, staticDir: dist });
}

describe("静的ファイルの配信", () => {
  test("ファイル・ディレクトリ・index の symlink でも配信範囲の外を読まない", async () => {
    const root = tempDir();
    const dist = join(root, "dist");
    const outside = join(root, "outside");
    mkdirSync(dist);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "SECRET");
    writeFileSync(join(dist, "safe.txt"), "公開内容");
    symlinkSync(join(outside, "secret.txt"), join(dist, "secret.txt"));
    symlinkSync(outside, join(dist, "linked"));
    symlinkSync(join(outside, "secret.txt"), join(dist, "index.html"));
    symlinkSync(join(dist, "safe.txt"), join(dist, "safe-link.txt"));
    const db = openDb(join(root, "nod.db"));
    try {
      const app = createApp({ db, staticDir: dist });
      for (const path of ["/secret.txt", "/linked/secret.txt", "/index.html", "/issues/API-1"]) {
        const res = await app.request(path);
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain("SECRET");
      }
      const safe = await app.request("/safe-link.txt");
      expect(safe.status).toBe(200);
      expect(await safe.text()).toBe("公開内容");
    } finally {
      db.close();
    }
  });

  test("ファイルがあれば返し、拡張子のないパスには index.html を返す", async () => {
    const app = setupStatic();
    const js = await app.request("/assets/app.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(await js.text()).toBe("console.log(1)");
    for (const path of ["/", "/issues/API-1", "/views/3", "/inbox?selected=API-2"]) {
      const res = await app.request(path);
      expect([path, res.status, res.headers.get("content-type")?.includes("text/html")]).toEqual([path, 200, true]);
      expect(await res.text()).toContain("id=root");
    }
  });

  test("拡張子のあるパスでファイルがなければ 404。staticDir の外は読まない", async () => {
    const app = setupStatic();
    expect((await app.request("/assets/missing.js")).status).toBe(404);
    for (const path of ["/..%2fsecret.txt", "/%2e%2e%2fsecret.txt", "/assets/..%2f..%2fsecret.txt", "/../secret.txt"]) {
      const res = await app.request(path);
      expect([path, (await res.text()).includes("SECRET")]).toEqual([path, false]);
    }
  });

  test("/api/ の誤ったパスは index.html ではなく JSON の 404。GET 以外も JSON の 404", async () => {
    const app = setupStatic();
    const api = await call(app, "GET", "/api/nope");
    expect(api.status).toBe(404);
    expect(api.json.error.code).toBe("NOT_FOUND");
    expect((await call(app, "POST", "/issues")).json.error.code).toBe("NOT_FOUND");
    expect((await call(app, "GET", "/api/workspaces")).json).toEqual([]);
  });

  test("index.html がなければ、ビルドを促す 404 を返す", async () => {
    const app = setupStatic(false);
    const r = await call(app, "GET", "/");
    expect(r.status).toBe(404);
    expect(r.json.error.message).toContain("index.html");
  });
});
