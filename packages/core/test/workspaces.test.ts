import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { deriveKey, findWorkspace, initWorkspace, listWorkspaces, removeWorkspace } from "../src/ops/workspaces";
import { codeOf, tempDbPath } from "./helpers";

describe("deriveKey", () => {
  test("リポジトリ名の英数字から先頭の3文字を大文字にする", () => {
    expect(deriveKey("api-server")).toBe("API");
    expect(deriveKey("nod")).toBe("NOD");
    expect(deriveKey("my_app2")).toBe("MYA");
  });

  test("英数字が2文字に満たなければ null", () => {
    expect(deriveKey("x")).toBeNull();
    expect(deriveKey("日本語")).toBeNull();
  });
});

describe("initWorkspace", () => {
  test("リポジトリ名からキーと名前を作って登録する", () => {
    const db = openDb(tempDbPath());
    const r = initWorkspace(db, { path: "/repos/api-server" });
    expect(r.created).toBe(true);
    expect(r.workspace).toMatchObject({ key: "API", name: "api-server", path: "/repos/api-server" });
    expect(listWorkspaces(db).map((w) => w.key)).toEqual(["API"]);
  });

  test("同じパスをもう一度登録しても増やさない", () => {
    const db = openDb(tempDbPath());
    initWorkspace(db, { path: "/repos/api-server" });
    const again = initWorkspace(db, { path: "/repos/api-server", key: "ZZZ" });
    expect(again.created).toBe(false);
    expect(again.workspace.key).toBe("API");
    expect(listWorkspaces(db)).toHaveLength(1);
  });

  test("--key は大文字にして使う", () => {
    const db = openDb(tempDbPath());
    expect(initWorkspace(db, { path: "/repos/frontend", key: "web" }).workspace.key).toBe("WEB");
  });

  test("キーが使われていれば KEY_TAKEN、形式が違えば INVALID_ARGS", () => {
    const db = openDb(tempDbPath());
    initWorkspace(db, { path: "/repos/api-server" });
    expect(codeOf(() => initWorkspace(db, { path: "/work/api-gateway" }))).toBe("KEY_TAKEN");
    expect(codeOf(() => initWorkspace(db, { path: "/work/api-gateway", key: "TOOLONGKEY" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => initWorkspace(db, { path: "/work/x" }))).toBe("INVALID_ARGS");
  });

  test("名前が使われていれば NAME_TAKEN", () => {
    const db = openDb(tempDbPath());
    initWorkspace(db, { path: "/a/app" });
    expect(codeOf(() => initWorkspace(db, { path: "/b/app", key: "APB" }))).toBe("NAME_TAKEN");
  });
});

describe("findWorkspace と removeWorkspace", () => {
  test("キー（大文字小文字を問わない）かパスで引ける", () => {
    const db = openDb(tempDbPath());
    initWorkspace(db, { path: "/repos/api-server" });
    expect(findWorkspace(db, "api")?.key).toBe("API");
    expect(findWorkspace(db, "/repos/api-server")?.key).toBe("API");
    expect(findWorkspace(db, "/repos/other")).toBeNull();
  });

  test("登録を解除すると Issue も消える", () => {
    const db = openDb(tempDbPath());
    const ws = initWorkspace(db, { path: "/repos/api-server" }).workspace;
    db.query(
      "INSERT INTO issues (workspace_id, number, title, status, created_by, created_at, updated_at) VALUES (?, 1, 't', 'todo', 'me', '', '')",
    ).run(ws.id);
    const r = removeWorkspace(db, "API");
    expect(r.deletedIssues).toBe(1);
    expect((db.query("SELECT count(*) AS n FROM issues").get() as { n: number }).n).toBe(0);
    expect(codeOf(() => removeWorkspace(db, "API"))).toBe("NOT_FOUND");
  });
});
