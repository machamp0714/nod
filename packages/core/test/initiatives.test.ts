import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { openDb, SCHEMA_VERSION, schemaVersion } from "../src/db";
import {
  addInitiativeProject,
  createInitiative,
  getInitiative,
  listInitiatives,
  removeInitiativeProject,
  updateInitiative,
} from "../src/ops/initiatives";
import { archiveIssue, createIssue, updateIssue } from "../src/ops/issues";
import { createProject, getProject, updateProject } from "../src/ops/projects";
import { MIGRATIONS } from "../src/schema";
import { codeOf, setup, tempDbPath } from "./helpers";

describe("Initiative", () => {
  test("名前・説明・目標日つきで作り、planned で始まる", () => {
    const { me } = setup();
    const i = createInitiative(me, { name: "検索の刷新", description: "年内に検索を置き換える", targetDate: "2026-12-31" });
    expect(i).toMatchObject({ name: "検索の刷新", description: "年内に検索を置き換える", targetDate: "2026-12-31", status: "planned", createdBy: "me" });
  });

  test("名前の空・数字だけ・重複、不正な目標日は拒む", () => {
    const { db, me } = setup();
    createInitiative(me, { name: "検索" });
    expect(codeOf(() => createInitiative(me, { name: " " }))).toBe("INVALID_ARGS");
    expect(codeOf(() => createInitiative(me, { name: "123" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => createInitiative(me, { name: "検索" }))).toBe("INITIATIVE_EXISTS");
    expect(codeOf(() => createInitiative(me, { name: "新", targetDate: "2026-02-30" }))).toBe("INVALID_ARGS");
    expect(db.query("SELECT count(*) AS n FROM initiatives").get()).toEqual({ n: 1 });
  });

  test("名前・説明・目標日・状態を変えられ、null で説明と目標日を外せる", () => {
    const { me, llm } = setup();
    createInitiative(me, { name: "検索", description: "説明", targetDate: "2026-12-31" });
    const updated = updateInitiative(llm, "検索", { name: "検索v2", status: "started", description: null, targetDate: null });
    expect(updated).toMatchObject({ name: "検索v2", status: "started", description: null, targetDate: null });
    expect(codeOf(() => updateInitiative(me, "検索v2", { status: "done" as never }))).toBe("INVALID_ARGS");
    expect(codeOf(() => updateInitiative(me, "検索v2", {}))).toBe("INVALID_ARGS");
    expect(codeOf(() => updateInitiative(me, "ない", { status: "started" }))).toBe("NOT_FOUND");
    createInitiative(me, { name: "認証" });
    expect(codeOf(() => updateInitiative(me, "認証", { name: "検索v2" }))).toBe("INITIATIVE_EXISTS");
  });

  test("Project を多対多で紐付け、配下 Project の Issue を合算した進捗を返す", () => {
    const { db, ws, me, llm } = setup();
    const init = createInitiative(me, { name: "上位" });
    const other = createInitiative(me, { name: "別" });
    const a = createProject(me, { name: "A" });
    createProject(me, { name: "B" });
    createProject(me, { name: "無関係" });
    addInitiativeProject(me, "上位", "A");
    addInitiativeProject(llm, String(init.id), "B");
    addInitiativeProject(me, "別", "A");
    // 同じ紐付けを重ねても1件のまま
    addInitiativeProject(me, "上位", "A");

    const done = createIssue(me, { workspaceId: ws.id, title: "完了", projectRef: "A" });
    updateIssue(me, done.id, { status: "done" });
    createIssue(me, { workspaceId: ws.id, title: "未完", projectRef: "B" });
    const canceled = createIssue(me, { workspaceId: ws.id, title: "中止", projectRef: "B" });
    updateIssue(me, canceled.id, { status: "canceled" });
    const archived = createIssue(me, { workspaceId: ws.id, title: "アーカイブ", projectRef: "A" });
    archiveIssue(me, archived.id);
    createIssue(me, { workspaceId: ws.id, title: "関係ない", projectRef: "無関係" });

    const detail = getInitiative(db, "上位");
    expect(detail).toMatchObject({ projectCount: 2, total: 2, done: 1 });
    expect(detail.projects.map((p) => [p.name, p.total, p.done])).toEqual([
      ["A", 1, 1],
      ["B", 1, 0],
    ]);
    expect(getInitiative(db, String(other.id))).toMatchObject({ projectCount: 1, total: 1, done: 1 });
    expect(getProject(db, "A").initiatives).toEqual([
      { id: init.id, name: "上位" },
      { id: other.id, name: "別" },
    ]);
    expect(getProject(db, String(a.id)).initiatives.length).toBe(2);
  });

  test("紐付けを外しても Project・Issue は残る。ない Project・Initiative は NOT_FOUND", () => {
    const { db, ws, me } = setup();
    createInitiative(me, { name: "上位" });
    createProject(me, { name: "A" });
    createIssue(me, { workspaceId: ws.id, title: "作業", projectRef: "A" });
    addInitiativeProject(me, "上位", "A");
    removeInitiativeProject(me, "上位", "A");
    expect(getInitiative(db, "上位")).toMatchObject({ projectCount: 0, total: 0, done: 0, projects: [] });
    expect(getProject(db, "A").issues.length).toBe(1);
    expect(codeOf(() => addInitiativeProject(me, "上位", "ない"))).toBe("NOT_FOUND");
    expect(codeOf(() => addInitiativeProject(me, "ない", "A"))).toBe("NOT_FOUND");
    expect(codeOf(() => removeInitiativeProject(me, "上位", "A"))).toBe("NOT_FOUND");
  });

  test("一覧は既定で完了・中止を除き、includeClosed で含める。名前順", () => {
    const { db, me } = setup();
    createInitiative(me, { name: "b" });
    createInitiative(me, { name: "a" });
    createInitiative(me, { name: "c" });
    updateInitiative(me, "c", { status: "completed" });
    expect(listInitiatives(db).map((i) => i.name)).toEqual(["a", "b"]);
    expect(listInitiatives(db, { includeClosed: true }).map((i) => i.name)).toEqual(["a", "b", "c"]);
  });

  test("Initiative の変更は Project の状態・Issue を変えない", () => {
    const { db, ws, me } = setup();
    createInitiative(me, { name: "上位" });
    createProject(me, { name: "A" });
    updateProject(me, "A", { status: "started" });
    createIssue(me, { workspaceId: ws.id, title: "作業", projectRef: "A" });
    addInitiativeProject(me, "上位", "A");
    const projects = db.query("SELECT * FROM projects").all();
    const issues = db.query("SELECT * FROM issues").all();
    const events = db.query("SELECT * FROM events").all();
    updateInitiative(me, "上位", { status: "completed" });
    removeInitiativeProject(me, "上位", "A");
    expect(db.query("SELECT * FROM projects").all()).toEqual(projects);
    expect(db.query("SELECT * FROM issues").all()).toEqual(issues);
    expect(db.query("SELECT * FROM events").all()).toEqual(events);
  });

  test("Project を消すと紐付けも消える", () => {
    const { db, me } = setup();
    createInitiative(me, { name: "上位" });
    const p = createProject(me, { name: "A" });
    addInitiativeProject(me, "上位", "A");
    db.query("DELETE FROM projects WHERE id = ?").run(p.id);
    expect(getInitiative(db, "上位").projectCount).toBe(0);
  });
});

test("Initiative の前の版の DB を移行しても既存の Project を保つ", () => {
  const before = MIGRATIONS.findIndex((steps) => steps.some((s) => typeof s === "string" && s.includes("CREATE TABLE initiatives")));
  expect(before).toBeGreaterThan(0);
  const path = tempDbPath();
  const old = new Database(path, { create: true });
  old.exec("PRAGMA foreign_keys=ON");
  for (const [v, steps] of MIGRATIONS.slice(0, before).entries()) {
    for (const step of steps) {
      if (typeof step === "string") old.exec(step);
      else step(old);
    }
    old.exec(`PRAGMA user_version=${v + 1}`);
  }
  old.exec("INSERT INTO projects (id,name,status,created_by,created_at,updated_at) VALUES (1,'既存','started','me','2026-01-01','2026-01-02')");
  const project = old.query("SELECT * FROM projects").all();
  old.close();

  const db = openDb(path);
  expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
  expect(db.query("SELECT * FROM projects").all()).toEqual(project);
  expect(getProject(db, "既存").initiatives).toEqual([]);
  expect(listInitiatives(db, { includeClosed: true })).toEqual([]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});
