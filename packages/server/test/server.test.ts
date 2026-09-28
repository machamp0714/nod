import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { initWorkspace, openDb } from "@nod/core";
import { DEFAULT_PORT, HOSTNAME, type NodServer, startServer } from "../src/server";
import { sseReader, tempDir } from "./helpers";

const running: NodServer[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.stop();
});

function start(opts: Parameters<typeof startServer>[0] = {}) {
  const dir = tempDir();
  const server = startServer({ port: 0, dbPath: join(dir, "nod.db"), ...opts });
  running.push(server);
  return { server, dir };
}

describe("startServer", () => {
  test("127.0.0.1 で待ち受け、DB を作ってマイグレーションを適用し、API を返す", async () => {
    expect(DEFAULT_PORT).toBe(4700);
    const { server, dir } = start();
    expect(server.url).toBe(`http://${HOSTNAME}:${server.port}`);
    expect(server.port).toBeGreaterThan(0);
    expect(server.dbPath).toBe(join(dir, "nod.db"));
    const res = await fetch(`${server.url}/api/workspaces`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("staticDir を渡すと web を配信する", async () => {
    const dist = tempDir();
    writeFileSync(join(dist, "index.html"), "<div id=root></div>");
    const { server } = start({ staticDir: dist });
    expect(await (await fetch(`${server.url}/issues/API-1`)).text()).toContain("id=root");
  });

  test("外部の書き込みを、定期的な確認で SSE に知らせる。自身の書き込みでは知らせない", async () => {
    const { server } = start({ pollIntervalMs: 50 });
    const sse = sseReader(await fetch(`${server.url}/api/events`));
    expect((await sse.next())?.event).toBe("ready");
    const own = await fetch(`${server.url}/api/views`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "仕事" }),
    });
    expect(own.status).toBe(201);
    expect(await sse.next(300)).toBeNull();
    const other = openDb(server.dbPath);
    initWorkspace(other, { path: "/tmp/repos/web-app" });
    other.close();
    expect((await sse.next(2000))?.event).toBe("change");
    await sse.cancel();
  });

  test("ポートが使われていれば PORT_IN_USE を投げる", () => {
    const { server } = start();
    let code: string | undefined;
    try {
      running.push(startServer({ port: server.port, dbPath: join(tempDir(), "nod.db") }));
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("PORT_IN_USE");
  });

  test("DB の版が新しければ SCHEMA_TOO_NEW を投げる", () => {
    const dbPath = join(tempDir(), "nod.db");
    const db = new Database(dbPath, { create: true });
    db.exec("PRAGMA user_version = 999");
    db.close();
    let code: string | undefined;
    try {
      running.push(startServer({ port: 0, dbPath }));
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("SCHEMA_TOO_NEW");
  });
});

test("ポート 80 の URL が既定ポートを省略しても正しい接続先を返す", async () => {
  // ポート 80 を実際に占有せず、Bun が返す URL と port を再現する。
  const serve = spyOn(Bun, "serve").mockReturnValue({
    url: new URL("http://127.0.0.1:80/"), port: 80, stop: async () => {},
  } as unknown as ReturnType<typeof Bun.serve>);
  try {
    const { server } = start({ port: 80 });
    expect(server.port).toBe(80);
    expect(server.url).toBe("http://127.0.0.1:80");
  } finally {
    serve.mockRestore();
  }
});
