import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { openDb, schemaVersion } from "../src/db";
import { addProjectUpdate, createProject, getProject, listProjects, listProjectUpdates } from "../src/ops/projects";
import { MIGRATIONS } from "../src/schema";
import { PROJECT_HEALTHS } from "../src/types";
import { codeOf, setup, tempDbPath } from "./helpers";

describe("Project の健全性", () => {
  test("健全性の値は on_track・at_risk・off_track の3つ", () => {
    expect([...PROJECT_HEALTHS]).toEqual(["on_track", "at_risk", "off_track"]);
  });

  test("報告に添えた健全性が報告ごとに残り、現在の健全性は健全性つきの最新の報告の値になる", () => {
    const { db, me, llm } = setup();
    createProject(me, { name: "検索" });
    expect(getProject(db, "検索").health).toBeNull();
    const first = addProjectUpdate(me, "検索", "順調", "on_track");
    const second = addProjectUpdate(llm, "検索", "遅れそう", "at_risk");
    expect(first.health).toBe("on_track");
    expect(second).toMatchObject({ author: "claude-code", health: "at_risk" });
    expect(getProject(db, "検索").health).toBe("at_risk");
    expect(listProjectUpdates(db, "検索").map((u) => u.health)).toEqual(["at_risk", "on_track"]);
  });

  test("健全性なしの報告は現在の健全性を変えない", () => {
    const { db, me } = setup();
    createProject(me, { name: "検索" });
    addProjectUpdate(me, "検索", "危ない", "off_track");
    const plain = addProjectUpdate(me, "検索", "メモだけ");
    expect(plain.health).toBeNull();
    expect(getProject(db, "検索").health).toBe("off_track");
    expect(listProjects(db).find((p) => p.name === "検索")?.health).toBe("off_track");
  });

  test("none を添えた報告は健全性を未設定に戻し、その報告は healthCleared になる（#154）", () => {
    const { db, me, llm } = setup();
    createProject(me, { name: "検索" });
    addProjectUpdate(me, "検索", "危ない", "off_track");
    const cleared = addProjectUpdate(llm, "検索", "判断を保留", "none");
    expect(cleared).toMatchObject({ health: null, healthCleared: true });
    expect(getProject(db, "検索").health).toBeNull();
    expect(listProjects(db).find((p) => p.name === "検索")?.health).toBeNull();
    // 健全性なしの報告は解除ではなく、戻したあとも未設定のまま
    expect(addProjectUpdate(me, "検索", "メモ")).toMatchObject({ health: null, healthCleared: false });
    expect(getProject(db, "検索").health).toBeNull();
    addProjectUpdate(me, "検索", "持ち直した", "on_track");
    expect(getProject(db, "検索").health).toBe("on_track");
    expect(listProjectUpdates(db, "検索").map((u) => [u.health, u.healthCleared])).toEqual([
      ["on_track", false],
      [null, false],
      [null, true],
      ["off_track", false],
    ]);
  });

  test("同じ時刻の報告は id の大きい方の健全性を現在値にする", () => {
    const { db, me } = setup();
    createProject(me, { name: "検索" });
    addProjectUpdate(me, "検索", "一", "off_track");
    addProjectUpdate(me, "検索", "二", "on_track");
    db.query("UPDATE project_updates SET created_at = '2026-09-29T00:00:00.000Z'").run();
    expect(getProject(db, "検索").health).toBe("on_track");
  });

  test("一覧は Project ごとに現在の健全性を返し、報告のない Project は null", () => {
    const { db, me } = setup();
    createProject(me, { name: "検索" });
    createProject(me, { name: "認証" });
    addProjectUpdate(me, "検索", "危ない", "at_risk");
    expect(Object.fromEntries(listProjects(db).map((p) => [p.name, p.health]))).toEqual({ 検索: "at_risk", 認証: null });
  });

  test("不正な健全性は INVALID_ARGS で、何も保存しない", () => {
    const { db, me } = setup();
    createProject(me, { name: "検索" });
    expect(codeOf(() => addProjectUpdate(me, "検索", "本文", "good" as never))).toBe("INVALID_ARGS");
    expect(db.query("SELECT count(*) AS n FROM project_updates").get()).toEqual({ n: 0 });
  });

  test("健全性だけで本文が空の報告は INVALID_ARGS", () => {
    const { db, me } = setup();
    createProject(me, { name: "検索" });
    expect(codeOf(() => addProjectUpdate(me, "検索", " ", "on_track"))).toBe("INVALID_ARGS");
    expect(db.query("SELECT count(*) AS n FROM project_updates").get()).toEqual({ n: 0 });
  });

  test("DB の CHECK 制約で不正な値を保存できない", () => {
    const { db, me } = setup();
    const p = createProject(me, { name: "検索" });
    expect(() =>
      db
        .query("INSERT INTO project_updates (project_id, author, body, health, created_at) VALUES (?, 'me', 'x', 'good', '2026-01-01')")
        .run(p.id),
    ).toThrow();
    // 解除した報告に健全性の値は持たせない
    expect(() =>
      db
        .query("INSERT INTO project_updates (project_id, author, body, health, health_cleared, created_at) VALUES (?, 'me', 'x', 'on_track', 1, '2026-01-01')")
        .run(p.id),
    ).toThrow();
  });
});

test("健全性の前の版の DB を移行しても既存の報告を保ち、健全性は未設定になる", () => {
  const index = MIGRATIONS.findIndex((steps) => steps.some((s) => typeof s === "string" && s.includes("ADD COLUMN health")));
  expect(index).toBeGreaterThan(0);
  const path = tempDbPath();
  const old = new Database(path, { create: true });
  old.exec("PRAGMA foreign_keys=ON");
  for (const [v, steps] of MIGRATIONS.slice(0, index).entries()) {
    for (const step of steps) {
      if (typeof step === "string") old.exec(step);
      else step(old);
    }
    old.exec(`PRAGMA user_version=${v + 1}`);
  }
  old.exec("INSERT INTO projects (id,name,status,created_by,created_at,updated_at) VALUES (1,'既存','started','me','2026-01-01','2026-01-02')");
  old.exec("INSERT INTO project_updates (project_id,author,body,created_at) VALUES (1,'me','古い報告','2026-01-03')");
  old.close();

  const db = openDb(path);
  expect(schemaVersion(db)).toBe(MIGRATIONS.length);
  const p = getProject(db, "既存");
  expect(p.health).toBeNull();
  expect(p.updates.map((u) => [u.body, u.health, u.healthCleared])).toEqual([["古い報告", null, false]]);
  db.close();
});
