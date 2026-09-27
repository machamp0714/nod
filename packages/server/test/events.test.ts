import { describe, expect, test } from "bun:test";
import { createIssue, openDb } from "@nod/core";
import { createApp } from "../src/app";
import { createChangeFeed, POLL_INTERVAL_MS } from "../src/change-feed";
import { call, setup, sseReader, waitFor } from "./helpers";

function setupFeed() {
  const s = setup();
  const feed = createChangeFeed(s.db);
  const app = createApp({ db: s.db, feed });
  return { ...s, feed, app };
}

describe("createChangeFeed", () => {
  test("確認の間隔は1秒", () => {
    expect(POLL_INTERVAL_MS).toBe(1000);
  });

  test("ほかの接続の書き込みで変化を知らせ、自分の接続の書き込みでは知らせない", () => {
    const { db, dbPath, me, ws, feed } = setupFeed();
    const seen: number[] = [];
    feed.subscribe((v) => seen.push(v));
    expect(feed.check()).toBe(false);
    createIssue(me, { workspaceId: ws.id, title: "server 自身の書き込み" });
    expect(feed.check()).toBe(false);
    const other = openDb(dbPath);
    createIssue({ db: other, actor: "claude-code" }, { workspaceId: ws.id, title: "nod の書き込み" });
    other.close();
    expect(feed.check()).toBe(true);
    expect(seen).toEqual([feed.version]);
    expect(feed.check()).toBe(false);
    expect(db.query("SELECT count(*) AS n FROM issues").get()).toEqual({ n: 2 });
  });

  test("購読をやめた相手には知らせず、1つの購読者の例外がほかを止めない", () => {
    const { dbPath, ws, feed } = setupFeed();
    const seen: string[] = [];
    const stop = feed.subscribe(() => seen.push("a"));
    feed.subscribe(() => {
      throw new Error("boom");
    });
    feed.subscribe(() => seen.push("c"));
    stop();
    const other = openDb(dbPath);
    createIssue({ db: other, actor: "codex" }, { workspaceId: ws.id, title: "t" });
    other.close();
    expect(feed.check()).toBe(true);
    expect(seen).toEqual(["c"]);
    expect(feed.listenerCount).toBe(2);
  });
});

describe("GET /api/events", () => {
  test("接続すると ready を送り、外部の書き込みを change で知らせる", async () => {
    const { app, dbPath, ws, feed } = setupFeed();
    const res = await app.request("/api/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const sse = sseReader(res);
    const ready = await sse.next();
    expect(ready?.event).toBe("ready");
    expect(JSON.parse(ready?.data ?? "")).toEqual({ dataVersion: feed.version });

    const other = openDb(dbPath);
    createIssue({ db: other, actor: "claude-code" }, { workspaceId: ws.id, title: "t" });
    other.close();
    feed.check();
    const change = await sse.next();
    expect(change?.event).toBe("change");
    expect(JSON.parse(change?.data ?? "")).toEqual({ dataVersion: feed.version });
    await sse.cancel();
  });

  test("web からの操作では change を送らない", async () => {
    const { app, me, ws, feed } = setupFeed();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const sse = sseReader(await app.request("/api/events"));
    expect((await sse.next())?.event).toBe("ready");
    expect((await call(app, "POST", `/api/issues/${i.id}/comment`, { body: "x" })).status).toBe(201);
    expect(feed.check()).toBe(false);
    expect(await sse.next(200)).toBeNull();
    await sse.cancel();
  });

  test("複数の接続のそれぞれに知らせ、切断した接続の購読をやめる", async () => {
    const { app, dbPath, ws, feed } = setupFeed();
    const a = sseReader(await app.request("/api/events"));
    const b = sseReader(await app.request("/api/events"));
    expect((await a.next())?.event).toBe("ready");
    expect((await b.next())?.event).toBe("ready");
    expect(feed.listenerCount).toBe(2);
    const other = openDb(dbPath);
    createIssue({ db: other, actor: "codex" }, { workspaceId: ws.id, title: "t" });
    other.close();
    feed.check();
    expect((await a.next())?.event).toBe("change");
    expect((await b.next())?.event).toBe("change");
    await a.cancel();
    expect(await waitFor(() => feed.listenerCount === 1)).toBe(true);
    await b.cancel();
    expect(await waitFor(() => feed.listenerCount === 0)).toBe(true);
  });
});
