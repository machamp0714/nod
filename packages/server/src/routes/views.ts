import type { Database } from "bun:sqlite";
import { createView, deleteView, getView, listViews, updateView, type ViewInput } from "@nod/core";
import type { Hono } from "hono";
import { type Body, optInt, optNullableString, optString, paramInt, readBody, reqString } from "../input";

const VIEW_KEYS = ["name", "color", "filter", "display", "position"] as const;

// filter と display の中身は core の validateIssueQuery・validateViewDisplay が確かめる
function toViewInput(b: Body): ViewInput {
  return {
    name: optString(b, "name"),
    color: optNullableString(b, "color"),
    filter: b.filter,
    display: b.display,
    position: optInt(b, "position"),
  };
}

const viewId = (value: string) => paramInt(value, "View の id ");

export function registerViewRoutes(app: Hono, db: Database): void {
  app.get("/api/views", (c) => c.json(listViews(db)));
  app.get("/api/views/:id", (c) => c.json(getView(db, viewId(c.req.param("id")))));
  app.post("/api/views", async (c) => {
    const b = await readBody(c, VIEW_KEYS);
    return c.json(createView(db, { ...toViewInput(b), name: reqString(b, "name") }), 201);
  });
  app.put("/api/views/:id", async (c) => {
    const id = viewId(c.req.param("id"));
    return c.json(updateView(db, id, toViewInput(await readBody(c, VIEW_KEYS))));
  });
  app.delete("/api/views/:id", (c) => c.json(deleteView(db, viewId(c.req.param("id")))));
}
