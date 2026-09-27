import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ChangeFeed } from "../change-feed";

// 接続の直後に ready を、外部の書き込みを検知するたびに change を送る。
// web はどちらを受け取ってもクエリを無効にする（ready は再接続の間の変更を取りこぼさないため）
export function registerEventRoutes(app: Hono, feed: ChangeFeed): void {
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const send = (event: "ready" | "change", version: number) =>
        stream.writeSSE({ event, data: JSON.stringify({ dataVersion: version }) }).catch(() => {});
      const unsubscribe = feed.subscribe((version) => void send("change", version));
      const closed = new Promise<void>((resolve) =>
        stream.onAbort(() => {
          unsubscribe();
          resolve();
        }),
      );
      await send("ready", feed.version);
      await closed;
    }),
  );
}
