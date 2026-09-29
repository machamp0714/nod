import { expect, test } from "bun:test";
import { initWorkspace, listWorkspaces } from "@nod/core";
import { call, setup } from "./helpers";

test("Workspace APIはDBに保存した一意の色を返す", async () => {
  const { db, app } = setup();
  try {
    initWorkspace(db, { path: "/repos/web", key: "WEB" });
    const result = await call(app, "GET", "/api/workspaces");
    expect(result.status).toBe(200);
    expect(result.json).toEqual(listWorkspaces(db));
    const colors = result.json.map((w: { color: string }) => w.color);
    expect(colors.every((color: string) => /^#[0-9A-F]{6}$/.test(color))).toBe(true);
    expect(new Set(colors).size).toBe(2);
  } finally { db.close(); }
});
