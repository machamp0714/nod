import type { Database } from "bun:sqlite";
import { listNotifications, markNotificationsRead, type OpCtx } from "@nod/core";
import type { Hono } from "hono";
import { type Body, invalid, optString, queryFlag, readBody } from "../input";

function optIds(body: Body): number[] | undefined {
  const v = body.ids;
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "number" || !Number.isInteger(x))) {
    throw invalid("ids は整数の配列で指定してください");
  }
  return v as number[];
}

function optTrue(body: Body, key: string): true | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v !== true) throw invalid(`${key} は true で指定してください`);
  return true;
}

// Inbox の通知（購読中の Issue の変化）。受け手は me
export function registerNotificationRoutes(app: Hono, db: Database, me: OpCtx): void {
  app.get("/api/notifications", (c) =>
    c.json(listNotifications(db, { includeRead: queryFlag(c.req.query("includeRead"), "includeRead") })),
  );
  app.post("/api/notifications/read", async (c) => {
    const body = await readBody(c, ["ids", "issueRef", "all"]);
    return c.json(markNotificationsRead(me, { ids: optIds(body), issueRef: optString(body, "issueRef"), all: optTrue(body, "all") }));
  });
}
