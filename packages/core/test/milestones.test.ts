import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { openDb, schemaVersion } from "../src/db";
import { bulkUpdateIssues } from "../src/ops/bulk-update";
import { archiveIssue, createIssue, getIssue, listIssues, queryIssues, updateIssue } from "../src/ops/issues";
import { createMilestone, deleteMilestone, listMilestones, MILESTONE_DESCRIPTION_MAX_LENGTH, updateMilestone } from "../src/ops/milestones";
import { createProject, getProject } from "../src/ops/projects";
import { MIGRATIONS } from "../src/schema";
import { codeOf, eventsOf, setup, tempDbPath } from "./helpers";

function withProjects() {
  const s = setup();
  createProject(s.me, { name: "検索" });
  createProject(s.me, { name: "認証" });
  return s;
}

describe("Milestone の作成・編集・削除", () => {
  test("名前・目標日・説明つきで作り、Project 詳細と一覧に目標日の早い順（未設定は最後）で出る", () => {
    const { db, me, llm } = withProjects();
    const late = createMilestone(me, "検索", { name: "β公開", targetDate: "2026-11-30", description: "社内向け" });
    const none = createMilestone(llm, "検索", { name: "いつか" });
    const early = createMilestone(me, "検索", { name: "α", targetDate: "2026-10-15" });
    createMilestone(me, "認証", { name: "別" });
    expect(late).toMatchObject({ name: "β公開", targetDate: "2026-11-30", description: "社内向け", createdBy: "me", total: 0, done: 0 });
    expect(none).toMatchObject({ targetDate: null, description: null, createdBy: "claude-code" });
    expect(listMilestones(db, "検索").map((m) => m.name)).toEqual(["α", "β公開", "いつか"]);
    expect(getProject(db, "検索").milestones.map((m) => m.id)).toEqual([early.id, late.id, none.id]);
  });

  test("名前の空・数字だけ・同じ Project 内の重複、目標日の形式、説明の上限を INVALID_ARGS で拒む", () => {
    const { db, me } = withProjects();
    createMilestone(me, "検索", { name: "α" });
    expect(codeOf(() => createMilestone(me, "検索", { name: " " }))).toBe("INVALID_ARGS");
    expect(codeOf(() => createMilestone(me, "検索", { name: "12" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => createMilestone(me, "検索", { name: "α" }))).toBe("MILESTONE_EXISTS");
    expect(codeOf(() => createMilestone(me, "検索", { name: "β", targetDate: "2026/10/01" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => createMilestone(me, "検索", { name: "β", description: "あ".repeat(MILESTONE_DESCRIPTION_MAX_LENGTH + 1) }))).toBe("INVALID_ARGS");
    expect(codeOf(() => createMilestone(me, "ない", { name: "β" }))).toBe("NOT_FOUND");
    // 別の Project なら同じ名前を使える
    expect(createMilestone(me, "認証", { name: "α" }).name).toBe("α");
    expect(db.query("SELECT count(*) AS n FROM milestones").get()).toEqual({ n: 2 });
  });

  test("名前・目標日・説明を変え、null で目標日と説明を外せる", () => {
    const { me } = withProjects();
    const m = createMilestone(me, "検索", { name: "α", targetDate: "2026-10-15", description: "説明" });
    const renamed = updateMilestone(me, m.id, { name: "α2", targetDate: null, description: null });
    expect(renamed).toMatchObject({ id: m.id, name: "α2", targetDate: null, description: null });
    const dated = updateMilestone(me, String(m.id), { targetDate: "2026-12-01" });
    expect(dated).toMatchObject({ name: "α2", targetDate: "2026-12-01" });
    createMilestone(me, "検索", { name: "β" });
    expect(codeOf(() => updateMilestone(me, m.id, { name: "β" }))).toBe("MILESTONE_EXISTS");
    expect(codeOf(() => updateMilestone(me, 999, { name: "γ" }))).toBe("NOT_FOUND");
  });

  test("削除すると紐付いた Issue は Milestone から外れるだけで、Issue は残る", () => {
    const { db, ws, me } = withProjects();
    const m = createMilestone(me, "検索", { name: "α" });
    const issue = createIssue(me, { workspaceId: ws.id, title: "a", projectRef: "検索" });
    updateIssue(me, issue.id, { milestoneRef: String(m.id) });
    expect(deleteMilestone(me, m.id)).toEqual({ id: m.id });
    expect(getIssue(db, issue.id)).toMatchObject({ milestone: null, project: { name: "検索" } });
    expect(listMilestones(db, "検索")).toEqual([]);
    expect(codeOf(() => deleteMilestone(me, m.id))).toBe("NOT_FOUND");
  });

  test("LLM は Milestone を作成・編集できるが、削除はできない（FORBIDDEN_FOR_LLM）", () => {
    const { db, llm } = withProjects();
    const m = createMilestone(llm, "検索", { name: "α" });
    expect(updateMilestone(llm, m.id, { name: "α2" }).name).toBe("α2");
    expect(codeOf(() => deleteMilestone(llm, m.id))).toBe("FORBIDDEN_FOR_LLM");
    expect(listMilestones(db, "検索").map((x) => x.id)).toEqual([m.id]);
  });

  test("名前の前後の空白は取り除いて保存し、重複判定もそれで行う", () => {
    const { me } = withProjects();
    const m = createMilestone(me, "検索", { name: "  α  " });
    expect(m.name).toBe("α");
    expect(codeOf(() => createMilestone(me, "検索", { name: "α " }))).toBe("MILESTONE_EXISTS");
    expect(codeOf(() => createMilestone(me, "検索", { name: " 12 " }))).toBe("INVALID_ARGS");
    expect(updateMilestone(me, m.id, { name: " β " }).name).toBe("β");
  });

  test("Project を消すと Milestone も消える", () => {
    const { db, me } = withProjects();
    const p = getProject(db, "検索");
    createMilestone(me, "検索", { name: "α" });
    db.query("DELETE FROM projects WHERE id = ?").run(p.id);
    expect(db.query("SELECT count(*) AS n FROM milestones").get()).toEqual({ n: 0 });
  });
});

describe("Issue と Milestone の紐付け", () => {
  test("同じ Project の Milestone を名前か ID で付け替え・解除でき、event を残す", () => {
    const { db, ws, me, llm } = withProjects();
    const a = createMilestone(me, "検索", { name: "α" });
    const b = createMilestone(me, "検索", { name: "β" });
    const issue = createIssue(me, { workspaceId: ws.id, title: "a", projectRef: "検索" });
    expect(updateIssue(me, issue.id, { milestoneRef: "α" }).milestone).toEqual({ id: a.id, name: "α" });
    expect(updateIssue(llm, issue.id, { milestoneRef: String(b.id) }).milestone).toEqual({ id: b.id, name: "β" });
    expect(updateIssue(me, issue.id, { milestoneRef: null }).milestone).toBeNull();
    expect(eventsOf(db, issue.id).filter((e) => e.type === "milestone_changed")).toEqual([
      { type: "milestone_changed", actor: "me", data: { from: null, to: "α" } },
      { type: "milestone_changed", actor: "claude-code", data: { from: "α", to: "β" } },
      { type: "milestone_changed", actor: "me", data: { from: "β", to: null } },
    ]);
  });

  test("Project のない Issue、別 Project の Milestone、存在しない Milestone は拒み、何も変えない", () => {
    const { db, ws, me } = withProjects();
    const other = createMilestone(me, "認証", { name: "別" });
    const loose = createIssue(me, { workspaceId: ws.id, title: "なし" });
    const issue = createIssue(me, { workspaceId: ws.id, title: "a", projectRef: "検索" });
    expect(codeOf(() => updateIssue(me, loose.id, { milestoneRef: String(other.id) }))).toBe("INVALID_ARGS");
    expect(codeOf(() => updateIssue(me, issue.id, { milestoneRef: String(other.id) }))).toBe("INVALID_ARGS");
    expect(codeOf(() => updateIssue(me, issue.id, { milestoneRef: "別" }))).toBe("NOT_FOUND");
    expect(codeOf(() => updateIssue(me, issue.id, { milestoneRef: "999" }))).toBe("NOT_FOUND");
    expect(codeOf(() => updateIssue(me, issue.id, { title: "変える", milestoneRef: "別" }))).toBe("NOT_FOUND");
    expect(getIssue(db, issue.id)).toMatchObject({ title: "a", milestone: null });
    expect(getIssue(db, loose.id).milestone).toBeNull();
  });

  test("Project と Milestone を同時に指定すると、新しい Project の Milestone を付けられる", () => {
    const { ws, me } = withProjects();
    const m = createMilestone(me, "認証", { name: "別" });
    const issue = createIssue(me, { workspaceId: ws.id, title: "a", projectRef: "検索" });
    expect(updateIssue(me, issue.id, { projectRef: "認証", milestoneRef: "別" })).toMatchObject({
      project: { name: "認証" },
      milestone: { id: m.id, name: "別" },
    });
  });

  test("Issue の Project を変える・外すと Milestone も外れる（一括編集も同じ）", () => {
    const { db, ws, me } = withProjects();
    createMilestone(me, "検索", { name: "α" });
    const a = createIssue(me, { workspaceId: ws.id, title: "a", projectRef: "検索" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b", projectRef: "検索" });
    const c = createIssue(me, { workspaceId: ws.id, title: "c", projectRef: "検索" });
    for (const i of [a, b, c]) updateIssue(me, i.id, { milestoneRef: "α" });
    expect(updateIssue(me, a.id, { projectRef: "認証" }).milestone).toBeNull();
    expect(updateIssue(me, b.id, { projectRef: null }).milestone).toBeNull();
    // 同じ Project を指定し直しても外れない
    expect(updateIssue(me, c.id, { projectRef: "検索" }).milestone).toMatchObject({ name: "α" });
    bulkUpdateIssues(me, [c.id], { projectRef: "認証" });
    expect(getIssue(db, c.id).milestone).toBeNull();
    expect(eventsOf(db, a.id).filter((e) => e.type === "milestone_changed").at(-1)?.data).toEqual({ from: "α", to: null });
  });

  test("Milestone ごとの進捗は Project と同じ定義（canceled とアーカイブ済みを除く総数、done の数）", () => {
    const { db, ws, me } = withProjects();
    const m = createMilestone(me, "検索", { name: "α" });
    createMilestone(me, "検索", { name: "空" });
    const make = (title: string, status?: "done" | "canceled" | "in_progress") => {
      const issue = createIssue(me, { workspaceId: ws.id, title, projectRef: "検索" });
      updateIssue(me, issue.id, { milestoneRef: "α", ...(status ? { status } : {}) });
      return issue;
    };
    make("未着手");
    make("作業中", "in_progress");
    make("完了", "done");
    make("中止", "canceled");
    const archived = make("完了してアーカイブ", "done");
    archiveIssue(me, archived.id);
    createIssue(me, { workspaceId: ws.id, title: "Milestone なし", projectRef: "検索" });
    const [alpha, empty] = getProject(db, "検索").milestones;
    expect(alpha).toMatchObject({ id: m.id, total: 3, done: 1 });
    expect(empty).toMatchObject({ total: 0, done: 0 });
  });

  test("Issue 一覧を Milestone で絞り込める", () => {
    const { db, ws, me } = withProjects();
    const m = createMilestone(me, "検索", { name: "α" });
    const inM = createIssue(me, { workspaceId: ws.id, title: "a", projectRef: "検索" });
    createIssue(me, { workspaceId: ws.id, title: "b", projectRef: "検索" });
    updateIssue(me, inM.id, { milestoneRef: "α" });
    const loose = createIssue(me, { workspaceId: ws.id, title: "c" });
    expect(queryIssues(db, { milestone: String(m.id) }).issues.map((i) => i.id)).toEqual([inM.id]);
    expect(queryIssues(db, { milestone: "none", project: "検索" }).issues.map((i) => i.title)).toEqual(["b"]);
    expect(queryIssues(db, { milestone: "none" }).issues.map((i) => i.id)).not.toContain(inM.id);
    expect(queryIssues(db, { milestone: "none" }).issues.map((i) => i.id)).toContain(loose.id);
    for (const bad of ["abc", "0", "-1", ""]) expect(codeOf(() => queryIssues(db, { milestone: bad }))).toBe("INVALID_ARGS");
    expect(codeOf(() => queryIssues(db, { milestone: "999" }))).toBe("NOT_FOUND");
  });
});

describe("Milestone の入口（#154）", () => {
  test("起票時に Project の Milestone を名前か ID で付けられ、Project なし・別 Project・存在しないものは拒んで起票しない", () => {
    const { db, ws, me, llm } = withProjects();
    const m = createMilestone(me, "検索", { name: "α" });
    const foreign = createMilestone(me, "認証", { name: "別" });
    expect(createIssue(me, { workspaceId: ws.id, title: "a", projectRef: "検索", milestoneRef: "α" }).milestone).toEqual({ id: m.id, name: "α" });
    expect(createIssue(llm, { workspaceId: ws.id, title: "b", projectRef: "検索", milestoneRef: String(m.id) })).toMatchObject({
      status: "triage",
      milestone: { id: m.id },
    });
    const before = listIssues(db, { statuses: ["triage", "todo"] }).length;
    expect(codeOf(() => createIssue(me, { workspaceId: ws.id, title: "x", milestoneRef: "α" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => createIssue(me, { workspaceId: ws.id, title: "x", projectRef: "検索", milestoneRef: String(foreign.id) }))).toBe("INVALID_ARGS");
    expect(codeOf(() => createIssue(me, { workspaceId: ws.id, title: "x", projectRef: "検索", milestoneRef: "ない" }))).toBe("NOT_FOUND");
    // 起票で空文字を渡しても黙って無視せず、理由を返す（更新の空文字は「外す」だが、起票には外すものがない）
    expect(() => createIssue(me, { workspaceId: ws.id, title: "x", projectRef: "検索", milestoneRef: " " })).toThrow("Milestone を指定してください");
    expect(codeOf(() => createIssue(me, { workspaceId: ws.id, title: "x", projectRef: "検索", milestoneRef: "" }))).toBe("INVALID_ARGS");
    expect(listIssues(db, { statuses: ["triage", "todo"] })).toHaveLength(before);
  });

  test("一覧は Milestone の ID・none、Project を指定したときは名前でも絞れる", () => {
    const { db, ws, me } = withProjects();
    const m = createMilestone(me, "検索", { name: "α" });
    const inM = createIssue(me, { workspaceId: ws.id, title: "a", projectRef: "検索", milestoneRef: "α" });
    const loose = createIssue(me, { workspaceId: ws.id, title: "b", projectRef: "検索" });
    expect(listIssues(db, { milestone: String(m.id) }).map((i) => i.id)).toEqual([inM.id]);
    expect(listIssues(db, { projectRef: "検索", milestone: "α" }).map((i) => i.id)).toEqual([inM.id]);
    expect(listIssues(db, { projectRef: "検索", milestone: "none" }).map((i) => i.id)).toEqual([loose.id]);
    expect(codeOf(() => listIssues(db, { milestone: "α" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => listIssues(db, { projectRef: "認証", milestone: "α" }))).toBe("NOT_FOUND");
    // 別の Project の Milestone の ID を組み合わせたら、分析（stats）と同じく断る
    expect(() => listIssues(db, { projectRef: "認証", milestone: String(m.id) })).toThrow("指定した Project のものではありません");
    expect(codeOf(() => listIssues(db, { projectRef: "認証", milestone: String(m.id) }))).toBe("INVALID_ARGS");
  });

  test("一括編集で Milestone を付け替え・外せ、Project の違う Issue が混ざると何も変えない", () => {
    const { db, ws, me } = withProjects();
    createMilestone(me, "検索", { name: "α" });
    const a = createIssue(me, { workspaceId: ws.id, title: "a", projectRef: "検索" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b", projectRef: "検索" });
    const other = createIssue(me, { workspaceId: ws.id, title: "c", projectRef: "認証" });
    expect(bulkUpdateIssues(me, [a.id, b.id], { milestoneRef: "α" }).map((i) => i.milestone?.name)).toEqual(["α", "α"]);
    expect(eventsOf(db, a.id).filter((e) => e.type === "milestone_changed").at(-1)?.data).toEqual({ from: null, to: "α" });
    expect(codeOf(() => bulkUpdateIssues(me, [a.id, other.id], { milestoneRef: null, priority: 1 }))).toBe(undefined);
    expect(getIssue(db, a.id).milestone).toBeNull();
    const failed = (() => {
      try {
        bulkUpdateIssues(me, [b.id, other.id], { milestoneRef: "α" });
      } catch (e) {
        return e as { code: string; details: { failures: { id: string }[] } };
      }
    })();
    expect(failed?.code).toBe("BULK_UPDATE_FAILED");
    expect(failed?.details.failures.map((f) => f.id)).toEqual([other.id]);
    expect(getIssue(db, b.id).milestone).toMatchObject({ name: "α" });
    // Project と Milestone を同時に変えると、新しい Project の Milestone を付けられる
    const m2 = createMilestone(me, "認証", { name: "β" });
    expect(bulkUpdateIssues(me, [a.id], { projectRef: "認証", milestoneRef: "β" })[0]?.milestone).toEqual({ id: m2.id, name: "β" });
  });
});

test("Milestone の前の版の DB を移行しても既存の Issue を保ち、Milestone は空で始まる", () => {
  const index = MIGRATIONS.findIndex((steps) => steps.some((s) => typeof s === "string" && s.includes("CREATE TABLE milestones")));
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
  old.close();
  const db = openDb(path);
  expect(schemaVersion(db)).toBe(MIGRATIONS.length);
  expect(getProject(db, "既存").milestones).toEqual([]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  db.close();
});
