import { describe, expect, test } from "bun:test";
import { ISSUE_SORT_KEYS, sortIssues } from "../src/issue-sort";
import { createIssue, listIssues, queryIssues, updateIssue } from "../src/ops/issues";
import { setup } from "./helpers";

// API-1 Low/todo、API-2 Urgent/backlog、API-3 なし/todo、API-4 High/in_progress、API-5 Urgent/todo
function seed() {
  const s = setup();
  const make = (title: string, priority: number, extra: { estimate?: number; dueDate?: string } = {}) =>
    createIssue(s.me, { workspaceId: s.ws.id, title, priority, ...extra });
  make("e", 4, { estimate: 5, dueDate: "2026-10-03" });
  make("d", 1, { estimate: 2 });
  make("c", 0, { dueDate: "2026-10-01" });
  make("b", 2);
  make("a", 1, { estimate: 8, dueDate: "2026-10-02" });
  updateIssue(s.me, "API-2", { status: "backlog" });
  updateIssue(s.me, "API-4", { status: "in_progress" });
  return s;
}

const ids = (issues: { id: string }[]) => issues.map((i) => i.id);

describe("listIssues の priorities", () => {
  test("どれかに合う Issue を返し、0 は優先度なしを指す", () => {
    const { db } = seed();
    expect(ids(listIssues(db, { priorities: [1] }))).toEqual(["API-2", "API-5"]);
    expect(ids(listIssues(db, { priorities: [0, 2] }))).toEqual(["API-3", "API-4"]);
    expect(ids(listIssues(db, { priorities: [3] }))).toEqual([]);
    expect(ids(listIssues(db, { priorities: [1], statuses: ["todo"] }))).toEqual(["API-5"]);
  });

  test("queryIssues（API と View）でも絞り、件数も同じ範囲で数える", () => {
    const { db } = seed();
    const result = queryIssues(db, { priority: [1, 4] });
    expect(ids(result.issues)).toEqual(["API-1", "API-2", "API-5"]);
    expect(result.counts).toEqual({ ready: 2, needsClarification: 0 });
  });
});

describe("sortIssues", () => {
  test("id は Workspace と番号の順（数字として比べる）", () => {
    const { db, me, ws } = seed();
    for (let n = 0; n < 6; n++) createIssue(me, { workspaceId: ws.id, title: `x${n}` });
    const issues = listIssues(db);
    expect(ids(sortIssues([...issues].reverse(), "id"))).toEqual(ids(issues));
    expect(ids(sortIssues(issues, "id", "desc")).slice(0, 2)).toEqual(["API-11", "API-10"]);
  });

  test("default は状態（spec の表の順）→ 優先度（なしは最後）→ ID", () => {
    const { db } = seed();
    expect(ids(sortIssues(listIssues(db), "default"))).toEqual(["API-2", "API-5", "API-1", "API-3", "API-4"]);
  });

  test("priority は Urgent が先でなしが最後。同順位は向きによらず ID の昇順", () => {
    const { db } = seed();
    expect(ids(sortIssues(listIssues(db), "priority"))).toEqual(["API-2", "API-5", "API-4", "API-1", "API-3"]);
    expect(ids(sortIssues(listIssues(db), "priority", "desc"))).toEqual(["API-3", "API-1", "API-4", "API-2", "API-5"]);
  });

  test("estimate と due の未設定は、どちらの向きでも末尾に置く", () => {
    const { db } = seed();
    expect(ids(sortIssues(listIssues(db), "estimate"))).toEqual(["API-2", "API-1", "API-5", "API-3", "API-4"]);
    expect(ids(sortIssues(listIssues(db), "estimate", "desc"))).toEqual(["API-5", "API-1", "API-2", "API-3", "API-4"]);
    expect(ids(sortIssues(listIssues(db), "due"))).toEqual(["API-3", "API-5", "API-1", "API-2", "API-4"]);
    expect(ids(sortIssues(listIssues(db), "due", "desc"))).toEqual(["API-1", "API-5", "API-3", "API-2", "API-4"]);
  });

  test("title・created・updated で並べられ、元の配列は変えない", () => {
    const { db, me } = seed();
    const issues = listIssues(db);
    const before = ids(issues);
    expect(ids(sortIssues(issues, "title"))).toEqual(["API-5", "API-4", "API-3", "API-2", "API-1"]);
    expect(ids(sortIssues(issues, "created", "desc"))).toHaveLength(5);
    // seed の更新と同じミリ秒になると順が揺れるので、ほかの Issue の更新日時を過去に寄せる
    db.query("UPDATE issues SET updated_at = '2000-01-01T00:00:00.000Z'").run();
    updateIssue(me, "API-3", { title: "c2" });
    expect(ids(sortIssues(listIssues(db), "updated", "desc"))[0]).toBe("API-3");
    expect(ids(issues)).toEqual(before);
    expect(ISSUE_SORT_KEYS).toEqual(["id", "default", "priority", "created", "updated", "title", "estimate", "due"]);
  });
});
