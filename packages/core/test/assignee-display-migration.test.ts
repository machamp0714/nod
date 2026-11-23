import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { IssueQuery } from "../src/issue-filter";
import { openDb } from "../src/db";
import { listPageDisplays } from "../src/ops/page-displays";
import { listViews } from "../src/ops/views";
import { MIGRATIONS } from "../src/schema";
import { tempDbPath } from "./helpers";

test("版53の保存ビューとページ表示設定から担当の条件・列・グループだけを消す", () => {
  const path = tempDbPath();
  const old = new Database(path, { create: true });
  for (const migration of MIGRATIONS.slice(0, 53)) {
    for (const step of migration) {
      if (typeof step === "string") old.exec(step);
      else step(old);
    }
  }
  old.exec("PRAGMA user_version = 53");
  const view = old.query("INSERT INTO views (name, filter, display) VALUES (?, ?, ?)");
  const filter: IssueQuery = { status: ["todo"], label: ["assignee"], sprint: "current" };
  view.run("主グループ", JSON.stringify({ ...filter, assignee: ["me"] }), JSON.stringify({
    layout: "board", groupBy: "assignee", subGroupBy: "project", columns: ["pr", "assignee", "status"], sort: "title",
  }));
  view.run("副グループ", JSON.stringify({ assignee: null, project: "1" }), JSON.stringify({
    groupBy: "status", subGroupBy: "assignee", columns: ["assignee"], showChildren: false,
  }));
  view.run("担当なし", JSON.stringify({ q: "assignee" }), JSON.stringify({ columns: [], direction: "desc" }));

  const page = old.query("INSERT INTO page_displays (page, display, updated_at) VALUES (?, ?, '2026-11-22')");
  page.run("issues", JSON.stringify({ groupBy: "assignee", columns: ["assignee", "workspace"], layout: "board" }));
  page.run("project:1", JSON.stringify({ groupBy: "priority", subGroupBy: "assignee", showCompleted: false }));
  page.run("project:2", JSON.stringify({ groupBy: "none", columns: [] }));
  old.close();

  const db = openDb(path);
  try {
    expect(listViews(db).map(({ name, filter, display }) => ({ name, filter, display }))).toEqual([
      { name: "主グループ", filter, display: { layout: "board", subGroupBy: "project", columns: ["pr", "status"], sort: "title" } },
      { name: "副グループ", filter: { project: "1" }, display: { groupBy: "status", columns: [], showChildren: false } },
      { name: "担当なし", filter: { q: "assignee" }, display: { columns: [], direction: "desc" } },
    ]);
    expect(listPageDisplays(db)).toEqual({
      issues: { columns: ["workspace"], layout: "board" },
      "project:1": { groupBy: "priority", showCompleted: false },
      "project:2": { groupBy: "none", columns: [] },
    });
    expect(db.query("SELECT DISTINCT updated_at FROM page_displays").all()).toEqual([{ updated_at: "2026-11-22" }]);
  } finally {
    db.close();
  }
});
