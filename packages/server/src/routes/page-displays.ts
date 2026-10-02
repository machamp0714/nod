import type { Database } from "bun:sqlite";
import { deletePageDisplay, listPageDisplays, setPageDisplay } from "@nod/core";
import type { Hono } from "hono";
import { readBody } from "../input";

// Issue 一覧のページごとの表示設定（#218）。ページのキーと display の中身は core の validatePage・validatePageDisplay が確かめる
export function registerPageDisplayRoutes(app: Hono, db: Database): void {
  app.get("/api/page-displays", (c) => c.json(listPageDisplays(db)));
  app.put("/api/page-displays/:page", async (c) => {
    const b = await readBody(c, ["display"]);
    return c.json(setPageDisplay(db, c.req.param("page"), b.display));
  });
  app.delete("/api/page-displays/:page", (c) => {
    deletePageDisplay(db, c.req.param("page"));
    return c.json({ ok: true });
  });
}
