import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { openDb } from "../src/db";
import { MIGRATIONS } from "../src/schema";
import { tempDbPath } from "./helpers";

test("委任中とMy Issuesの保存設定だけを撤去し、ほかの条件と表示設定を残す", () => {
  const path = tempDbPath();
  const old = new Database(path, { create: true });
  for (const migration of MIGRATIONS.slice(0, 52)) {
    for (const step of migration) {
      if (typeof step === "string") old.exec(step);
      else step(old);
    }
  }
  old.exec("PRAGMA user_version = 52");
  old.query("INSERT INTO views (name, filter, display) VALUES (?, ?, ?)")
    .run("保存ビュー", JSON.stringify({ delegated: true, status: ["todo"], label: ["bug"] }), JSON.stringify({ layout: "board", sort: "title" }));
  old.query("INSERT INTO page_displays (page, display, updated_at) VALUES (?, ?, '')")
    .run("my-issues", JSON.stringify({ groupBy: "status" }));
  old.query("INSERT INTO page_displays (page, display, updated_at) VALUES (?, ?, '')")
    .run("issues", JSON.stringify({ layout: "board", columns: ["status"] }));
  old.close();
  const db = openDb(path);
  try {
    const view = db.query("SELECT filter, display FROM views").get() as { filter: string; display: string };
    expect(JSON.parse(view.filter)).toEqual({ status: ["todo"], label: ["bug"] });
    expect(JSON.parse(view.display)).toEqual({ layout: "board", sort: "title" });
    const pages = db.query("SELECT page, display FROM page_displays ORDER BY page").all() as { page: string; display: string }[];
    expect(pages.map(row => ({ page: row.page, display: JSON.parse(row.display) })))
      .toEqual([{ page: "issues", display: { layout: "board", columns: ["status"] } }]);
  } finally {
    db.close();
  }
});
