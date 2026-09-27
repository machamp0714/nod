import { describe, expect, test } from "bun:test";
import { createIssue, queryIssues } from "../src/ops/issues";
import { createView, deleteView, getView, listViews, updateView } from "../src/ops/views";
import { initWorkspace, removeWorkspace } from "../src/ops/workspaces";
import { codeOf, setup } from "./helpers";

describe("View", () => {
  test("作った順に並び、filter は正規化して保存し、そのまま queryIssues に渡せる", () => {
    const { db, ws, me } = setup();
    const web = initWorkspace(db, { path: "/tmp/repos/web" }).workspace;
    createIssue(me, { workspaceId: ws.id, title: "api" });
    const w = createIssue(me, { workspaceId: web.id, title: "web" });
    const work = createView(db, {
      name: "仕事",
      color: "#5E6AD2",
      filter: { workspace: ["web"], status: "todo,in_progress" },
    });
    createView(db, { name: "すべて" });
    expect(work).toMatchObject({
      name: "仕事",
      color: "#5E6AD2",
      position: 1,
      filter: { workspace: ["WEB"], status: ["todo", "in_progress"] },
    });
    expect(listViews(db).map((v) => [v.name, v.position, v.filter])).toEqual([
      ["仕事", 1, { workspace: ["WEB"], status: ["todo", "in_progress"] }],
      ["すべて", 2, {}],
    ]);
    expect(queryIssues(db, getView(db, work.id).filter).issues.map((i) => i.id)).toEqual([w.id]);
  });

  test("名前、色、filter、並び順を変え、消せる", () => {
    const { db } = setup();
    const a = createView(db, { name: "a", color: "#000000" });
    const b = createView(db, { name: "b" });
    const updated = updateView(db, a.id, { name: "A", color: null, filter: { ready: true }, position: 3 });
    expect(updated).toMatchObject({ name: "A", color: null, filter: { ready: true }, position: 3 });
    expect(updateView(db, a.id, { position: 4 })).toMatchObject({ name: "A", filter: { ready: true } });
    expect(listViews(db).map((v) => v.name)).toEqual(["b", "A"]);
    expect(deleteView(db, b.id).name).toBe("b");
    expect(listViews(db).map((v) => v.name)).toEqual(["A"]);
  });

  test("名前の重複は VIEW_EXISTS、空の名前や不正な filter と position は INVALID_ARGS、ない id は NOT_FOUND", () => {
    const { db } = setup();
    const a = createView(db, { name: "a" });
    const b = createView(db, { name: "b" });
    expect(codeOf(() => createView(db, { name: "a" }))).toBe("VIEW_EXISTS");
    expect(codeOf(() => updateView(db, b.id, { name: "a" }))).toBe("VIEW_EXISTS");
    expect(updateView(db, a.id, { name: "a" }).name).toBe("a");
    expect(codeOf(() => createView(db, { name: " " }))).toBe("INVALID_ARGS");
    expect(codeOf(() => createView(db, { name: "c", filter: { status: ["wip"] } }))).toBe("INVALID_ARGS");
    expect(codeOf(() => updateView(db, a.id, { position: -1 }))).toBe("INVALID_ARGS");
    expect(codeOf(() => getView(db, 999))).toBe("NOT_FOUND");
    expect(codeOf(() => updateView(db, 999, { name: "x" }))).toBe("NOT_FOUND");
    expect(codeOf(() => deleteView(db, 999))).toBe("NOT_FOUND");
  });

  test("filter の Workspace の登録を解除しても、View は空の一覧を返す", () => {
    const { db, me } = setup();
    const web = initWorkspace(db, { path: "/tmp/repos/web" }).workspace;
    createIssue(me, { workspaceId: web.id, title: "web" });
    const v = createView(db, { name: "web", filter: { workspace: ["WEB"] } });
    removeWorkspace(db, "WEB");
    expect(queryIssues(db, getView(db, v.id).filter).issues).toEqual([]);
  });
});
