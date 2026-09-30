import { beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

// nod の承認と GitHub PR の関係（#56/#57）。nod の承認は GitHub へ何も書き込まず、gh も実行しない

// 引数を記録し、決めた出力を返す偽の gh（GitHub には触れない）。
// env は偽 gh のディレクトリを PATH の先頭に置き NOD_GH にも渡すので、NOD_GH 経由でも既定の「gh」（PATH 上）経由でも起動は log に残る
function fakeGh(body: string): { path: string; log: string; env: Record<string, string> } {
  const dir = tempDir("nod-fake-gh-");
  const path = join(dir, "gh");
  const log = join(dir, "args.log");
  writeFileSync(path, `#!/bin/sh\necho "$@" >> "${log}"\n${body}\n`);
  chmodSync(path, 0o755);
  return { path, log, env: { NOD_GH: path, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` } };
}

const PR_URL = "https://github.com/example/api-server/pull/128";
const ghJson = (state: string, reviewDecision: string | null) =>
  JSON.stringify({
    number: 128,
    title: "検索 API",
    url: PR_URL,
    state,
    isDraft: false,
    reviewDecision,
    mergedAt: state === "MERGED" ? "2026-09-29T01:00:00Z" : null,
    statusCheckRollup: [],
  });

const NOTE = "nod の承認は GitHub の承認・マージではありません。GitHub には何も書き込みません";
let db: string;
let repo: string;
beforeAll(() => {
  db = tempDb();
  repo = makeRepo();
  registerRepo(db, repo);
});

async function inReview(prUrl: string | null = PR_URL): Promise<string> {
  const created = (await runNod(["issue", "create", "--json", "PR つき"], { cwd: repo, db })).json;
  const llm = { cwd: repo, db, actor: "claude-code" };
  await runNod(["issue", "start", created.id], llm);
  await runNod(["issue", "done", created.id, "--summary", "直した", ...(prUrl ? ["--pr", prUrl] : [])], llm);
  return created.id;
}

const lines = (log: string) => readFileSync(log, "utf8").trim().split("\n");

describe("nod review approve と GitHub PR", () => {
  test("偽 gh は PATH の先頭にあり、NOD_GH なしの既定の gh でも起動が記録される（下のテストの前提）", async () => {
    const id = await inReview();
    const gh = fakeGh(`echo '${ghJson("OPEN", null)}'`);
    const r = await runNod(["issue", "pr-status", id, "--refresh"], { cwd: repo, db, env: { PATH: gh.env.PATH } });
    expect(r.exitCode).toBe(0);
    expect(lines(gh.log)).toHaveLength(1);
  });

  test("未取得なら取得方法を案内し、注記を出し、gh を実行しない", async () => {
    const id = await inReview();
    const gh = fakeGh(`echo '${ghJson("OPEN", null)}'`);
    const r = await runNod(["review", "approve", id], { cwd: repo, db, env: gh.env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("承認しました");
    expect(r.stdout).toContain(`GitHub の状態は未取得（nod issue pr-status ${id} --refresh で取得）`);
    expect(r.stdout).toContain(NOTE);
    expect(r.stdout).not.toContain("注意:");
    expect(() => readFileSync(gh.log)).toThrow();
  });

  test("GitHub が未マージ・変更要求なら注意を出すが、承認は止めない", async () => {
    const id = await inReview();
    const gh = fakeGh(`echo '${ghJson("OPEN", "CHANGES_REQUESTED")}'`);
    await runNod(["issue", "pr-status", id, "--refresh"], { cwd: repo, db, env: gh.env });
    const r = await runNod(["review", "approve", id], { cwd: repo, db, env: gh.env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("GitHub: #128 Open · レビュー: 変更要求");
    expect(r.stdout).toContain("注意: 取得時点で GitHub の PR はまだマージされていません（Open）");
    expect(r.stdout).toContain("注意: 取得時点で GitHub に変更要求が出ています");
    expect(r.stdout).toContain(NOTE);
    // gh は pr-status --refresh の1回だけで、承認では実行しない
    expect(lines(gh.log)).toHaveLength(1);
    expect((await runNod(["issue", "show", id, "--json"], { cwd: repo, db })).json.status).toBe("done");
  });

  test("マージ済み・承認済みなら注意は出さない", async () => {
    const id = await inReview();
    const gh = fakeGh(`echo '${ghJson("MERGED", "APPROVED")}'`);
    await runNod(["issue", "pr-status", id, "--refresh"], { cwd: repo, db, env: gh.env });
    const r = await runNod(["review", "approve", id], { cwd: repo, db, env: gh.env });
    expect(r.stdout).toContain("GitHub: #128 Merged · レビュー: 承認済み");
    expect(r.stdout).not.toContain("注意:");
    expect(lines(gh.log)).toHaveLength(1);
  });

  test("Closed なら、マージされずに閉じられていると注意する", async () => {
    const id = await inReview();
    const gh = fakeGh(`echo '${ghJson("CLOSED", null)}'`);
    await runNod(["issue", "pr-status", id, "--refresh"], { cwd: repo, db, env: gh.env });
    const r = await runNod(["review", "approve", id], { cwd: repo, db, env: gh.env });
    expect(r.stdout).toContain("注意: 取得時点で GitHub の PR はマージされずに閉じられています（Closed）");
    expect(r.stdout).not.toContain("まだマージされていません");
    expect(lines(gh.log)).toHaveLength(1);
  });

  test("PR の無い Issue は注記だけを出す", async () => {
    const id = await inReview(null);
    const r = await runNod(["review", "approve", id], { cwd: repo, db });
    expect(r.stdout).toContain(NOTE);
    expect(r.stdout).not.toContain("GitHub の状態");
  });

  test("--json は Issue の形のまま", async () => {
    const id = await inReview();
    const r = await runNod(["review", "approve", id, "--json"], { cwd: repo, db });
    expect(r.json).toMatchObject({ id, status: "done" });
    expect(r.json.github).toBeUndefined();
  });
});
