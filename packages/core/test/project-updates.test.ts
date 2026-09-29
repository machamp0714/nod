import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { openDb, SCHEMA_VERSION, schemaVersion } from "../src/db";
import { askQuestion, startIssue } from "../src/ops/agent";
import { createIssue, getIssue } from "../src/ops/issues";
import {
  addProjectUpdate,
  createProject,
  getProject,
  listProjectUpdates,
  PROJECT_UPDATE_MAX_LENGTH,
  updateProject,
} from "../src/ops/projects";
import { MIGRATIONS } from "../src/schema";
import { codeOf, setup, tempDbPath } from "./helpers";

describe("Project の進捗報告", () => {
  test("書き手・日時つきで保存し、詳細と一覧で新しい順に再取得できる", () => {
    const { db, me, llm } = setup();
    const p = createProject(me, { name: "検索" });
    const first = addProjectUpdate(me, "検索", "索引を作り直した\n次は計測");
    const second = addProjectUpdate(llm, String(p.id), "計測を終えた");
    expect(first).toMatchObject({ projectId: p.id, author: "me", body: "索引を作り直した\n次は計測" });
    expect(second).toMatchObject({ projectId: p.id, author: "claude-code", body: "計測を終えた" });
    expect(Number.isNaN(Date.parse(first.createdAt))).toBe(false);
    expect(getProject(db, "検索").updates).toEqual([second, first]);
    expect(listProjectUpdates(db, String(p.id))).toEqual([second, first]);
  });

  test("同じ時刻の報告は id の大きい順に並ぶ", () => {
    const { db, me } = setup();
    const p = createProject(me, { name: "検索" });
    const ids = ["一", "二", "三"].map((body) => addProjectUpdate(me, p.name, body).id);
    db.query("UPDATE project_updates SET created_at = '2026-09-29T00:00:00.000Z'").run();
    expect(listProjectUpdates(db, p.name).map((u) => u.id)).toEqual([...ids].reverse());
  });

  test("他の Project の報告と混ざらない", () => {
    const { db, me } = setup();
    createProject(me, { name: "検索" });
    createProject(me, { name: "認証" });
    addProjectUpdate(me, "検索", "検索の報告");
    addProjectUpdate(me, "認証", "認証の報告");
    expect(listProjectUpdates(db, "検索").map((u) => u.body)).toEqual(["検索の報告"]);
    expect(getProject(db, "認証").updates.map((u) => u.body)).toEqual(["認証の報告"]);
  });

  test("空の本文・上限超過は INVALID_ARGS、ない Project は NOT_FOUND で、何も保存しない", () => {
    const { db, me } = setup();
    createProject(me, { name: "検索" });
    expect(codeOf(() => addProjectUpdate(me, "検索", ""))).toBe("INVALID_ARGS");
    expect(codeOf(() => addProjectUpdate(me, "検索", " \n\t "))).toBe("INVALID_ARGS");
    expect(codeOf(() => addProjectUpdate(me, "検索", "あ".repeat(PROJECT_UPDATE_MAX_LENGTH + 1)))).toBe("INVALID_ARGS");
    expect(codeOf(() => addProjectUpdate(me, "ない", "本文"))).toBe("NOT_FOUND");
    expect(codeOf(() => addProjectUpdate(me, "999", "本文"))).toBe("NOT_FOUND");
    expect(codeOf(() => listProjectUpdates(db, "ない"))).toBe("NOT_FOUND");
    expect(db.query("SELECT count(*) AS n FROM project_updates").get()).toEqual({ n: 0 });
    // 上限ちょうどは保存でき、本文は前後の空白も含めて原文のまま残す
    const max = addProjectUpdate(me, "検索", ` ${"あ".repeat(PROJECT_UPDATE_MAX_LENGTH - 2)} `);
    expect(max.body.length).toBe(PROJECT_UPDATE_MAX_LENGTH);
  });

  test("完了・中止の Project にも書ける", () => {
    const { db, me } = setup();
    createProject(me, { name: "古い" });
    updateProject(me, "古い", { status: "canceled" });
    addProjectUpdate(me, "古い", "中止の経緯");
    expect(getProject(db, "古い").updates.map((u) => u.body)).toEqual(["中止の経緯"]);
  });

  test("Project の状態・updated_at と所属 Issue の状態・担当・event・Triage を変えない", () => {
    const { db, ws, me, llm } = setup();
    const p = createProject(me, { name: "検索" });
    updateProject(me, "検索", { status: "started" });
    const triage = createIssue(llm, { workspaceId: ws.id, title: "未判断", projectRef: "検索" });
    const working = createIssue(me, { workspaceId: ws.id, title: "作業中", projectRef: "検索" });
    startIssue(llm, working.id);
    askQuestion(llm, working.id, "どちらにするか");
    const beforeProject = db.query("SELECT * FROM projects WHERE id = ?").get(p.id);
    const beforeIssues = [getIssue(db, triage.id), getIssue(db, working.id)];
    const beforeEvents = db.query("SELECT * FROM events ORDER BY id").all();
    const beforeComments = db.query("SELECT * FROM comments ORDER BY id").all();

    addProjectUpdate(llm, "検索", "進捗");
    addProjectUpdate(me, "検索", "承知");

    expect(db.query("SELECT * FROM projects WHERE id = ?").get(p.id)).toEqual(beforeProject);
    expect([getIssue(db, triage.id), getIssue(db, working.id)]).toEqual(beforeIssues);
    expect(getIssue(db, triage.id).status).toBe("triage");
    expect(db.query("SELECT * FROM events ORDER BY id").all()).toEqual(beforeEvents);
    expect(db.query("SELECT * FROM comments ORDER BY id").all()).toEqual(beforeComments);
  });

  test("Project を消すと報告も消える", () => {
    const { db, me } = setup();
    const p = createProject(me, { name: "検索" });
    addProjectUpdate(me, "検索", "報告");
    db.query("DELETE FROM projects WHERE id = ?").run(p.id);
    expect(db.query("SELECT count(*) AS n FROM project_updates").get()).toEqual({ n: 0 });
  });
});

test("版2の DB を移行しても既存データを保ち、報告は空で始まる", () => {
  const path = tempDbPath();
  const old = new Database(path, { create: true });
  old.exec("PRAGMA foreign_keys=ON");
  for (const [v, steps] of MIGRATIONS.slice(0, 2).entries()) {
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
  expect(getProject(db, "既存").updates).toEqual([]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});
