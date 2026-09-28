import { expect, test } from "bun:test";
import { openDb } from "../src/db";
import { findWorkspace, initWorkspace, listWorkspaces, removeWorkspace } from "../src/ops/workspaces";
import { tempDbPath } from "./helpers";

// hash割当や未保存の実装では、一意性・再起動後の値の検証が失敗する。
test("1000 Workspaceへ重複しない保存色を割り当て、初期パレット数で登録を制限しない", () => {
  const path = tempDbPath();
  const db = openDb(path);
  const colors = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const { workspace } = initWorkspace(db, { path: `/repos/${i}`, key: `W${i}` });
    expect(workspace.color).toMatch(/^#[0-9A-F]{6}$/);
    expect(colors.has(workspace.color)).toBe(false);
    colors.add(workspace.color);
  }
  expect(colors.size).toBe(1000);
  const before = listWorkspaces(db);
  db.close();
  const reopened = openDb(path);
  expect(listWorkspaces(reopened)).toEqual(before);
  reopened.close();
});

test("APIとWEBを区別し、再init・削除・再登録で残存Workspaceの色を変えない", () => {
  const db = openDb(tempDbPath());
  try {
    const api = initWorkspace(db, { path: "/repos/api", key: "API" }).workspace;
    const web = initWorkspace(db, { path: "/repos/web", key: "WEB" }).workspace;
    expect(api.color).toMatch(/^#[0-9A-F]{6}$/);
    expect(web.color).not.toBe(api.color);
    expect(initWorkspace(db, { path: api.path, key: "NEW" }).workspace).toEqual(api);
    expect(removeWorkspace(db, "API").workspace.color).toBe(api.color);
    const next = initWorkspace(db, { path: "/repos/next", key: "NX" }).workspace;
    expect(next.color).toBe(api.color);
    expect(findWorkspace(db, "WEB")).toEqual(web);
  } finally { db.close(); }
});

test("DBは省略・NULL・不正HEX・小文字・重複色を拒否する", () => {
  const db = openDb(tempDbPath());
  try {
    const ws = initWorkspace(db, { path: "/repos/api", key: "API" }).workspace;
    expect(() => db.query("INSERT INTO workspaces (key,name,path,created_at) VALUES ('NO','no','/no','')").run()).toThrow();
    for (const color of [null, "", "#abc123", "#GGGGGG", "#12345", "#1234567", "red"]) {
      expect(() => db.query("UPDATE workspaces SET color=? WHERE id=?").run(color, ws.id)).toThrow();
      expect(() => db.query("INSERT INTO workspaces (key,name,path,created_at,color) VALUES ('NO','no','/no','',?)").run(color)).toThrow();
    }
    const next = initWorkspace(db, { path: "/repos/web", key: "WEB" }).workspace;
    expect(() => db.query("UPDATE workspaces SET color=? WHERE id=?").run(ws.color, next.id)).toThrow();
    expect(() => db.query("INSERT INTO workspaces (key,name,path,created_at,color) VALUES ('NO','no','/no','',?)").run(ws.color)).toThrow();
    expect(listWorkspaces(db)).toHaveLength(2);
  } finally { db.close(); }
});

// 輝度の検証は製品側の判定関数を再利用せず、表示背景との比を独立に算出する。
function luminance(hex: string): number {
  return [0.2126, 0.7152, 0.0722].reduce((sum, weight, i) => {
    const channel = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return sum + weight * (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  }, 0);
}

test("初期色と追加色は対象背景で識別でき、使用済み順序によらず同じ空きを選ぶ", async () => {
  const { allocateWorkspaceColor } = await import("../src/workspace-colors");
  const used = new Set<string>();
  const backgrounds = ["#FFFFFF", "#F5F6F8", "#EEF0F3", "#FAFBFC", "#E8EBFC", "#FDF0D8"];
  for (let i = 0; i < 1000; i++) {
    const color = allocateWorkspaceColor(used);
    for (const background of backgrounds) {
      expect((luminance(background) + 0.05) / (luminance(color) + 0.05)).toBeGreaterThanOrEqual(3);
    }
    used.add(color);
  }
  expect(allocateWorkspaceColor(new Set([...used].reverse()))).toBe(allocateWorkspaceColor(used));
});

test("候補が尽きた場合は重複色へ戻さず明示エラーにする", async () => {
  const { firstUnusedColor } = await import("../src/workspace-colors");
  const { codeOf } = await import("./helpers");
  expect(firstUnusedColor(new Set(["#123456"]), ["#123456", "#654321"])).toBe("#654321");
  expect(codeOf(() => firstUnusedColor(new Set(["#123456", "#654321"]), ["#123456", "#654321"]))).toBe("WORKSPACE_COLOR_EXHAUSTED");
});

test.each(["insert", "update"])("NULを含むHEX文字列を%sで拒否する", (operation) => {
  const db = openDb(tempDbPath());
  try {
    const ws = initWorkspace(db, { path: "/repos/api", key: "API" }).workspace;
    const invalid = "#123456\u0000BAD";
    if (operation === "insert") {
      expect(() => db.query("INSERT INTO workspaces (key,name,path,created_at,color) VALUES ('NO','no','/no','',?)").run(invalid)).toThrow();
    } else {
      expect(() => db.query("UPDATE workspaces SET color=? WHERE id=?").run(invalid, ws.id)).toThrow();
    }
    expect(listWorkspaces(db)).toEqual([ws]);
  } finally { db.close(); }
});
