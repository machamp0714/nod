import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { openDb, SCHEMA_VERSION, schemaVersion } from "../src/db";
import { createView, getView, listViews, updateView } from "../src/ops/views";
import { MIGRATIONS } from "../src/schema";
import { validateViewDisplay } from "../src/view-display";
import { codeOf, setup, tempDbPath } from "./helpers";

describe("View の表示設定（display）", () => {
  test("既定と違う値だけを残し、列は決まった順にそろえる", () => {
    expect(
      validateViewDisplay({
        tab: "ready",
        layout: "board",
        groupBy: "project",
        subGroupBy: "status",
        sort: "priority",
        direction: "desc",
        columns: ["pr", "status", "status"],
        showCompleted: false,
        showChildren: false,
      }),
    ).toEqual({
      tab: "ready",
      layout: "board",
      groupBy: "project",
      subGroupBy: "status",
      sort: "priority",
      direction: "desc",
      columns: ["status", "pr"],
      showCompleted: false,
      showChildren: false,
    });
    expect(
      validateViewDisplay({ tab: "all", layout: "list", groupBy: "none", sort: "default", direction: "asc", showCompleted: true, showChildren: true }),
    ).toEqual({});
    expect(validateViewDisplay({ columns: [] })).toEqual({ columns: [] });
    expect(validateViewDisplay({ tab: "needs_clarification" })).toEqual({ tab: "needs_clarification" });
  });

  test("サブグループは、グループ化があり別のプロパティのときだけ残す", () => {
    expect(validateViewDisplay({ subGroupBy: "status" })).toEqual({});
    expect(validateViewDisplay({ groupBy: "none", subGroupBy: "status" })).toEqual({});
    expect(validateViewDisplay({ groupBy: "status", subGroupBy: "status" })).toEqual({ groupBy: "status" });
  });

  test("知らないキーと値は INVALID_ARGS。委任中タブは filter の delegated で持つため受け付けない", () => {
    for (const bad of [
      [],
      "x",
      null,
      { preview: "NOD-1" },
      { q: "x" },
      { tab: "delegated" },
      { tab: "mine" },
      { layout: "table" },
      { groupBy: "title" },
      { subGroupBy: "none" },
      { sort: "id" },
      { direction: "up" },
      { columns: "status" },
      { columns: ["title"] },
      { showCompleted: "false" },
      { showChildren: 0 },
    ]) {
      expect(codeOf(() => validateViewDisplay(bad))).toBe("INVALID_ARGS");
    }
  });

  test("View に保存でき、省くと空、更新は渡したときだけ置き換える", () => {
    const { db } = setup();
    const plain = createView(db, { name: "plain", filter: { label: ["scope: docs"] } });
    expect(plain.display).toEqual({});
    const v = createView(db, { name: "docs", filter: { label: ["scope: docs"] }, display: { tab: "ready", groupBy: "project", sort: "priority" } });
    expect(v.display).toEqual({ tab: "ready", groupBy: "project", sort: "priority" });
    expect(updateView(db, v.id, { name: "docs2" }).display).toEqual({ tab: "ready", groupBy: "project", sort: "priority" });
    expect(updateView(db, v.id, { display: { layout: "board" } })).toMatchObject({ filter: { label: ["scope: docs"] }, display: { layout: "board" } });
    expect(updateView(db, v.id, { display: {} }).display).toEqual({});
    expect(listViews(db).map((x) => x.display)).toEqual([{}, {}]);
    expect(codeOf(() => createView(db, { name: "bad", display: { sort: "id" } }))).toBe("INVALID_ARGS");
    expect(codeOf(() => updateView(db, v.id, { display: { tab: "delegated" } }))).toBe("INVALID_ARGS");
    expect(getView(db, v.id).display).toEqual({});
  });

  test("display 列のない版の DB を開くと、既存の View は filter を保ち display は空になる", () => {
    const path = tempDbPath();
    const raw = new Database(path, { create: true });
    const before = MIGRATIONS.findIndex((steps) => steps.some((s) => typeof s === "string" && s.includes("ALTER TABLE views ADD COLUMN display")));
    expect(before).toBeGreaterThan(0);
    for (const steps of MIGRATIONS.slice(0, before)) {
      for (const step of steps) {
        if (typeof step === "string") raw.exec(step);
        else step(raw);
      }
    }
    raw.exec(`PRAGMA user_version = ${before}`);
    raw.query("INSERT INTO views (name, color, filter, position) VALUES (?, ?, ?, ?)").run("仕事", "#7C5CFF", '{"label":["scope: docs"]}', 1);
    raw.close();
    const db = openDb(path);
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(listViews(db)).toEqual([{ id: 1, name: "仕事", color: "#7C5CFF", filter: { label: ["scope: docs"] }, display: {}, position: 1 }]);
  });
});
