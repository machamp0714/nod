import { describe, expect, test } from "bun:test";
import { createIssue, findWorkspace, initWorkspace, logWork, openDb, rejectReview, completeIssue, startIssue } from "@nod/core";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

// 現在の Workspace で LLM が着手・レビュー提出・ブロッカー記録をし、人が差し戻す。別の Workspace に1件起票する
function seed() {
  const db = tempDb();
  const repo = makeRepo();
  registerRepo(db, repo);
  const d = openDb(db);
  const me = { db: d, actor: "me" };
  const llm = { db: d, actor: "claude-code" };
  const ws = findWorkspace(d, repo)!;
  const other = initWorkspace(d, { path: "/tmp/repos/web-app" }).workspace;
  const a = createIssue(me, { workspaceId: ws.id, title: "検索を速くする" });
  createIssue(me, { workspaceId: ws.id, title: "b" });
  createIssue(me, { workspaceId: ws.id, title: "c" });
  createIssue(me, { workspaceId: other.id, title: "他所" });
  startIssue(llm, a.id);
  logWork(llm, a.id, "ベンチ用のデータが無い", { kind: "blocker" });
  completeIssue(llm, a.id, { summary: "索引を足した" });
  rejectReview(me, a.id, "計測結果を添えて");
  d.close();
  return { db, repo, a };
}

describe("nod summary", () => {
  test("--json は現在の Workspace の直近24時間の要約を返す", async () => {
    const { db, repo, a } = seed();
    const r = await runNod(["summary", "--json"], { cwd: repo, db });
    expect(r.exitCode).toBe(0);
    const count = (kind: string) => r.json.sections.find((x: any) => x.kind === kind);
    expect(count("created").total).toBe(3);
    expect([count("started").llm, count("submitted").llm, count("rejected").human, count("blocker").llm]).toEqual([1, 1, 1, 1]);
    expect(count("rejected").items[0]).toMatchObject({ issueId: a.id, actor: "me", actorKind: "human", detail: "計測結果を添えて" });
  });

  test("文字の出力は種類ごとの件数と項目、他N件を出し、0件の種類は出さない", async () => {
    const { db, repo, a } = seed();
    const r = await runNod(["summary", "--limit", "1", "--all-workspaces"], { cwd: repo, db });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("合計 8（人 5 / LLM 3）");
    expect(r.stdout).toContain("新規起票 4（人 4 / LLM 0）");
    expect(r.stdout).toContain("  他3件");
    expect(r.stdout).toContain(`${a.id}  検索を速くする`);
    expect(r.stdout).toContain("    計測結果を添えて");
    expect(r.stdout).not.toContain("完了 ");
  });

  test("期間に動きがなければその旨を出し、ない Project は NOT_FOUND", async () => {
    const { db, repo } = seed();
    const missing = await runNod(["summary", "--project", "無い", "--json"], { cwd: repo, db });
    expect([missing.exitCode, missing.json.error.code]).toEqual([1, "NOT_FOUND"]);
    const d = openDb(db);
    d.query("UPDATE events SET created_at = '2026-01-01T00:00:00.000Z'").run();
    d.query("UPDATE comments SET created_at = '2026-01-01T00:00:00.000Z'").run();
    d.close();
    const empty = await runNod(["summary"], { cwd: repo, db });
    expect(empty.stdout).toContain("この期間の動きはありません");
  });

  test("不正な期間・件数は INVALID_ARGS", async () => {
    const { db, repo } = seed();
    for (const args of [["--since", "1y"], ["--since", "91d"], ["--limit", "0"], ["--limit", "x"]]) {
      const r = await runNod(["summary", ...args, "--json"], { cwd: repo, db });
      expect([args.join(" "), r.exitCode, r.json.error.code]).toEqual([args.join(" "), 1, "INVALID_ARGS"]);
    }
  });
});
