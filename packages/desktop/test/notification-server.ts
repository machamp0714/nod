// 別プロセスの実API・DB接続で、利用者の書き込みとネイティブ配信のロック競合を再現する。
import { setSystemTime } from "bun:test";
import { openDb } from "../../core/src";
import { createApp } from "../../server/src/app";

setSystemTime(new Date(process.argv[3]!));
const db = openDb(process.argv[2]!);
const app = createApp({ db, orcaRunner: null });
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/__test/clock" && request.method === "POST") {
      const body = await request.json() as { at: string; timezone?: string };
      if (body.timezone) process.env.TZ = body.timezone;
      setSystemTime(new Date(body.at));
      return Response.json({ ok: true });
    }
    if (pathname.endsWith("/claim")) console.log("claim");
    return app.fetch(request);
  },
});
console.log(`http://127.0.0.1:${server.port}`);
