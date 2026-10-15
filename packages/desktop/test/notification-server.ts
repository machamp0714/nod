// 別プロセスの実API・DB接続で、利用者の書き込みとネイティブ配信のロック競合を再現する。
import { setSystemTime } from "bun:test";
import { openDb } from "../../core/src";
import { createApp } from "../../server/src/app";

setSystemTime(new Date(process.argv[3]!));
const db = openDb(process.argv[2]!, { busyTimeoutMs: process.argv[5] ? Number(process.argv[5]) : 5000 });
const app = createApp({ db, orcaRunner: null });
let fault = process.argv[4] ?? "none";
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
    if (pathname.endsWith("/claim") && fault === "claim-before") {
      fault = "none";
      return new Response("テスト用の取得前障害", { status: 503 });
    }
    if ((pathname.endsWith("/claim") && fault === "claim-after") || (pathname.endsWith("/result") && fault === "result-before")) {
      const commit = fault === "claim-after";
      fault = "none";
      if (commit) await app.fetch(request);
      return new Response("テスト用の確定後応答喪失", { status: 503 });
    }
    return app.fetch(request);
  },
});
console.log(`http://127.0.0.1:${server.port}`);
