import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { findIssueRow } from "../src/issue-query";
import { createIssue, updateIssue } from "../src/ops/issues";
import {
  addWorkspaceLabel,
  listAllWorkspaceLabels,
  listWorkspaceLabels,
  removeWorkspaceLabel,
  updateWorkspaceLabel,
} from "../src/ops/workspace-labels";
import { initWorkspace } from "../src/ops/workspaces";
import { MIGRATIONS } from "../src/schema";
import { codeOf, eventsOf, setup, tempDbPath } from "./helpers";

function labelsOf(db: Database, ref: string): string[] {
  const row = findIssueRow(db, ref);
  return (db.query("SELECT label FROM issue_labels WHERE issue_id = ? ORDER BY label").all(row.id) as { label: string }[]).map(
    (r) => r.label,
  );
}

describe("Workspace のラベル定義", () => {
  test("未定義なら空の一覧を返す", () => {
    const { db, ws } = setup();
    expect(listWorkspaceLabels(db, ws.key)).toEqual([]);
  });

  test("人が追加すると名前・色・説明・使用件数を返し、色は大文字に揃える", () => {
    const { db, ws, me } = setup();
    createIssue(me, { workspaceId: ws.id, title: "a", labels: ["bug"] });
    const added = addWorkspaceLabel(me, ws.key, { name: " bug ", color: "#db2777", description: " 不具合 " });
    expect(added).toMatchObject({ workspaceKey: ws.key, name: "bug", color: "#DB2777", description: "不具合", issueCount: 1 });
    expect(listWorkspaceLabels(db, ws.key)).toEqual([added]);
  });

  test("説明は省略でき、一覧は名前順", () => {
    const { db, ws, me } = setup();
    addWorkspaceLabel(me, ws.key, { name: "ui", color: "#2563EB" });
    addWorkspaceLabel(me, ws.key, { name: "bug", color: "#DB2777" });
    expect(listWorkspaceLabels(db, ws.key).map((l) => [l.name, l.description])).toEqual([
      ["bug", ""],
      ["ui", ""],
    ]);
  });

  test("名前・色・説明が不正なら INVALID_ARGS", () => {
    const { ws, me } = setup();
    expect(codeOf(() => addWorkspaceLabel(me, ws.key, { name: " ", color: "#2563EB" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => addWorkspaceLabel(me, ws.key, { name: "a b", color: "#2563EB" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => addWorkspaceLabel(me, ws.key, { name: "a,b", color: "#2563EB" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => addWorkspaceLabel(me, ws.key, { name: "a".repeat(51), color: "#2563EB" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => addWorkspaceLabel(me, ws.key, { name: "a", color: "blue" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => addWorkspaceLabel(me, ws.key, { name: "a", color: "#2563EB", description: "x".repeat(201) }))).toBe(
      "INVALID_ARGS",
    );
  });

  test("同じ Workspace に同名は追加できず LABEL_EXISTS、別の Workspace なら追加できる", () => {
    const { db, ws, me } = setup();
    const other = initWorkspace(db, { path: "/tmp/repos/web-app" }).workspace;
    addWorkspaceLabel(me, ws.key, { name: "bug", color: "#DB2777" });
    expect(codeOf(() => addWorkspaceLabel(me, ws.key, { name: "bug", color: "#2563EB" }))).toBe("LABEL_EXISTS");
    expect(addWorkspaceLabel(me, other.key, { name: "bug", color: "#2563EB" }).workspaceKey).toBe(other.key);
    expect(listAllWorkspaceLabels(db).map((l) => [l.workspaceKey, l.name])).toEqual([
      [ws.key, "bug"],
      [other.key, "bug"],
    ]);
  });

  test("色と説明を変更できる", () => {
    const { db, ws, me } = setup();
    addWorkspaceLabel(me, ws.key, { name: "bug", color: "#DB2777", description: "a" });
    const updated = updateWorkspaceLabel(me, ws.key, "bug", { color: "#2563eb", description: "" });
    expect(updated).toMatchObject({ name: "bug", color: "#2563EB", description: "" });
    expect(listWorkspaceLabels(db, ws.key)).toEqual([updated]);
  });

  test("改名すると、その Workspace の Issue のラベルも置き換え、別 Workspace の Issue と event は変えない", () => {
    const { db, ws, me } = setup();
    const other = initWorkspace(db, { path: "/tmp/repos/web-app" }).workspace;
    const a = createIssue(me, { workspaceId: ws.id, title: "a", labels: ["bug"] });
    const b = createIssue(me, { workspaceId: ws.id, title: "b", labels: ["bug", "defect"] });
    const c = createIssue(me, { workspaceId: other.id, title: "c", labels: ["bug"] });
    addWorkspaceLabel(me, ws.key, { name: "bug", color: "#DB2777" });
    const before = eventsOf(db, a.id).length;
    const renamed = updateWorkspaceLabel(me, ws.key, "bug", { name: "defect" });
    expect(renamed).toMatchObject({ name: "defect", issueCount: 2 });
    expect(labelsOf(db, a.id)).toEqual(["defect"]);
    expect(labelsOf(db, b.id)).toEqual(["defect"]);
    expect(labelsOf(db, c.id)).toEqual(["bug"]);
    expect(eventsOf(db, a.id).length).toBe(before);
  });

  test("既存の定義名への改名は LABEL_EXISTS で、何も変えない", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a", labels: ["bug"] });
    addWorkspaceLabel(me, ws.key, { name: "bug", color: "#DB2777" });
    addWorkspaceLabel(me, ws.key, { name: "ui", color: "#2563EB" });
    expect(codeOf(() => updateWorkspaceLabel(me, ws.key, "bug", { name: "ui" }))).toBe("LABEL_EXISTS");
    expect(labelsOf(db, a.id)).toEqual(["bug"]);
  });

  test("未定義のラベルの変更・削除は NOT_FOUND", () => {
    const { ws, me } = setup();
    expect(codeOf(() => updateWorkspaceLabel(me, ws.key, "bug", { color: "#2563EB" }))).toBe("NOT_FOUND");
    expect(codeOf(() => removeWorkspaceLabel(me, ws.key, "bug"))).toBe("NOT_FOUND");
  });

  test("削除は定義だけを消し、Issue のラベルは未定義ラベルとして残る", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a", labels: ["bug"] });
    addWorkspaceLabel(me, ws.key, { name: "bug", color: "#DB2777" });
    expect(removeWorkspaceLabel(me, ws.key, "bug")).toEqual({ workspaceKey: ws.key, name: "bug", removed: true });
    expect(listWorkspaceLabels(db, ws.key)).toEqual([]);
    expect(labelsOf(db, a.id)).toEqual(["bug"]);
  });

  test("未定義のラベルも従来どおり Issue に付けられる", () => {
    const { db, ws, me, llm } = setup();
    addWorkspaceLabel(me, ws.key, { name: "bug", color: "#DB2777" });
    const a = createIssue(llm, { workspaceId: ws.id, title: "a", labels: ["unknown"] });
    updateIssue(llm, a.id, { addLabels: ["other"] });
    expect(labelsOf(db, a.id)).toEqual(["other", "unknown"]);
  });

  test("LLM は追加・変更・削除できず FORBIDDEN_FOR_LLM、一覧は読める", () => {
    const { db, ws, me, llm } = setup();
    expect(codeOf(() => addWorkspaceLabel(llm, ws.key, { name: "bug", color: "#DB2777" }))).toBe("FORBIDDEN_FOR_LLM");
    addWorkspaceLabel(me, ws.key, { name: "bug", color: "#DB2777" });
    expect(codeOf(() => updateWorkspaceLabel(llm, ws.key, "bug", { color: "#2563EB" }))).toBe("FORBIDDEN_FOR_LLM");
    expect(codeOf(() => removeWorkspaceLabel(llm, ws.key, "bug"))).toBe("FORBIDDEN_FOR_LLM");
    expect(listWorkspaceLabels(db, ws.key).map((l) => l.name)).toEqual(["bug"]);
  });

  test("未登録の Workspace は NOT_FOUND", () => {
    const { db, me } = setup();
    expect(codeOf(() => listWorkspaceLabels(db, "NOPE"))).toBe("NOT_FOUND");
    expect(codeOf(() => addWorkspaceLabel(me, "NOPE", { name: "bug", color: "#DB2777" }))).toBe("NOT_FOUND");
  });

  test("Workspace を消すと定義も消える", () => {
    const { db, ws, me } = setup();
    addWorkspaceLabel(me, ws.key, { name: "bug", color: "#DB2777" });
    db.query("DELETE FROM workspaces WHERE id = ?").run(ws.id);
    expect(listAllWorkspaceLabels(db)).toEqual([]);
  });

  test("旧版の DB を開くとラベル定義と表示名のテーブルが足され、既存の Issue ラベルはそのまま", () => {
    const path = tempDbPath();
    const version = MIGRATIONS.findIndex((steps) =>
      steps.some((s) => typeof s === "string" && s.includes("CREATE TABLE workspace_labels")),
    );
    expect(version).toBeGreaterThan(0);
    const raw = new Database(path, { create: true });
    raw.exec("PRAGMA foreign_keys = ON");
    for (const steps of MIGRATIONS.slice(0, version)) {
      for (const step of steps) typeof step === "string" ? raw.exec(step) : step(raw);
    }
    raw.exec(`PRAGMA user_version = ${version}`);
    raw.close();
    const db = openDb(path);
    const ws = initWorkspace(db, { path: "/tmp/repos/api-server" }).workspace;
    const me = { db, actor: "me" };
    const a = createIssue(me, { workspaceId: ws.id, title: "a", labels: ["bug"] });
    expect(listWorkspaceLabels(db, ws.key)).toEqual([]);
    expect(labelsOf(db, a.id)).toEqual(["bug"]);
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toContain("workspace_status_names");
  });
});
