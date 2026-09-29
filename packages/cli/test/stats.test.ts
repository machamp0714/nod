import { describe, expect, test } from "bun:test";
import { completionStats, createIssue, findIssueRow, findWorkspace, initWorkspace, openDb, updateIssue } from "@nod/core";
import { makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

// 現在の Workspace に2件、別の Workspace に1件の done を 2026-09-01 に作る
function seed() {
  const db = tempDb();
  const repo = makeRepo();
  registerRepo(db, repo);
  const d = openDb(db);
  const me = { db: d, actor: "me" };
  const ws = findWorkspace(d, repo)!;
  const other = initWorkspace(d, { path: "/tmp/repos/web-app" }).workspace;
  const issues = [
    createIssue(me, { workspaceId: ws.id, title: "a" }),
    createIssue(me, { workspaceId: ws.id, title: "b" }),
    createIssue(me, { workspaceId: other.id, title: "c" }),
  ];
  for (const [n, i] of issues.entries()) {
    updateIssue(me, i.id, { status: "done" });
    d.query("UPDATE issues SET started_at = ?, closed_at = ? WHERE id = ?")
      .run("2026-09-01T00:00:00.000Z", `2026-09-01T0${n + 1}:30:00.000Z`, findIssueRow(d, i.id).id);
  }
  d.close();
  return { db, repo };
}

const RANGE = ["--by", "day", "--from", "2026-09-01", "--to", "2026-09-02", "--tz", "UTC"];

describe("nod stats", () => {
  test("既定は現在の Workspace を集計し、--json は core と同じ数値を返す", async () => {
    const { db, repo } = seed();
    const r = await runNod(["stats", ...RANGE, "--json"], { cwd: repo, db });
    expect(r.exitCode).toBe(0);
    const d = openDb(db);
    expect(r.json).toEqual(completionStats(d, { by: "day", from: "2026-09-01", to: "2026-09-02", tz: "UTC", workspace: [findWorkspace(d, repo)!.key] }));
    expect(r.json.totals).toMatchObject({ completed: 2, work: { medianMinutes: 120, totalMinutes: 240 } });
  });

  test("--all-workspaces で全体を集計し、文字の出力は期間ごとの行と合計を出す", async () => {
    const { db, repo } = seed();
    const r = await runNod(["stats", ...RANGE, "--all-workspaces"], { cwd: repo, db });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe([
      "2026-09-01〜2026-09-02（日ごと、UTC）",
      "2026-09-01  完了 3  canceled 0  作業時間 中央値 2時間30分  合計 7時間30分  記録なし 0",
      "2026-09-02  完了 0  canceled 0  作業時間 中央値 -  合計 -  記録なし 0",
      "合計  完了 3  canceled 0  作業時間 中央値 2時間30分  合計 7時間30分  記録なし 0",
      "",
    ].join("\n"));
  });

  test("Workspace の外でも --all-workspaces なら集計でき、不正な指定は INVALID_ARGS", async () => {
    const { db } = seed();
    const cwd = tempDir();
    expect((await runNod(["stats", ...RANGE, "--all-workspaces", "--json"], { cwd, db })).json.totals.completed).toBe(3);
    for (const args of [["--by", "month"], ["--from", "2026-02-30"], ["--tz", "Nowhere/City"]]) {
      const r = await runNod(["stats", "--all-workspaces", ...args, "--json"], { cwd, db });
      expect([args, r.exitCode, r.json.error.code]).toEqual([args, 1, "INVALID_ARGS"]);
    }
    const missing = await runNod(["stats", "--all-workspaces", "--project", "ない", "--json"], { cwd, db });
    expect(missing.json.error.code).toBe("NOT_FOUND");
  });
});
