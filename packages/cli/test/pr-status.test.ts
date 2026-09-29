import { beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

// 実際の gh の代わりに NOD_GH で起動する偽のコマンド。引数を記録し、決めた出力を返す（GitHub には触れない）
function fakeGh(body: string): { path: string; log: string } {
  const dir = tempDir("nod-fake-gh-");
  const path = join(dir, "gh");
  const log = join(dir, "args.log");
  writeFileSync(path, `#!/bin/sh\necho "$@" >> "${log}"\n${body}\n`);
  chmodSync(path, 0o755);
  return { path, log };
}

const PR_URL = "https://github.com/example/api-server/pull/128";
const GH_OK = JSON.stringify({
  number: 128,
  title: "検索 API",
  url: PR_URL,
  state: "MERGED",
  isDraft: false,
  reviewDecision: "APPROVED",
  mergedAt: "2026-09-29T01:00:00Z",
  statusCheckRollup: [
    { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
  ],
});

let db: string;
let repo: string;
beforeAll(() => {
  db = tempDb();
  repo = makeRepo();
  registerRepo(db, repo);
});

async function issueWithPr(prUrl = PR_URL): Promise<string> {
  const created = (await runNod(["issue", "create", "--json", "PR つき"], { cwd: repo, db })).json;
  const llm = { cwd: repo, db, actor: "claude-code" };
  await runNod(["issue", "start", created.id], llm);
  await runNod(["issue", "done", created.id, "--summary", "直した", "--pr", prUrl], llm);
  return created.id;
}

describe("nod issue pr-status", () => {
  test("--refresh なしは保存済みを表示し、gh を実行しない", async () => {
    const id = await issueWithPr();
    const gh = fakeGh(`echo '${GH_OK}'`);
    const r = await runNod(["issue", "pr-status", id], { cwd: repo, db, env: { NOD_GH: gh.path } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("未取得");
    expect(r.stdout).toContain(`nod issue pr-status ${id} --refresh`);
    expect(() => readFileSync(gh.log)).toThrow();
  });

  test("--refresh で gh pr view を実行して保存し、LLM も実行できる", async () => {
    const id = await issueWithPr();
    const gh = fakeGh(`echo '${GH_OK}'`);
    const r = await runNod(["issue", "pr-status", id, "--refresh", "--json"], {
      cwd: repo,
      db,
      actor: "claude-code",
      env: { NOD_GH: gh.path },
    });
    expect(r.exitCode).toBe(0);
    expect(r.json.status).toMatchObject({ state: "MERGED", reviewDecision: "APPROVED", fetchedBy: "claude-code" });
    expect(readFileSync(gh.log, "utf8").trim()).toBe(
      `pr view ${PR_URL} --json number,title,url,state,isDraft,reviewDecision,statusCheckRollup,mergedAt`,
    );
    const text = await runNod(["issue", "pr-status", id], { cwd: repo, db });
    expect(text.stdout).toContain("状態: Merged");
    expect(text.stdout).toContain("レビュー: 承認済み");
    expect(text.stdout).toContain("CI: 成功 1 / 失敗 1 / 実行中 0 / スキップ 0");
    expect(text.stdout).toContain("失敗: lint");
    const show = await runNod(["issue", "show", id], { cwd: repo, db });
    expect(show.stdout).toContain("PR 状態: Merged · レビュー: 承認済み · CI: 成功 1 / 失敗 1");
  });

  test("gh の失敗は終了コード 0 でエラーを表示し、前回の結果を残す", async () => {
    const id = await issueWithPr();
    await runNod(["issue", "pr-status", id, "--refresh"], { cwd: repo, db, env: { NOD_GH: fakeGh(`echo '${GH_OK}'`).path } });
    const r = await runNod(["issue", "pr-status", id, "--refresh"], {
      cwd: repo,
      db,
      env: { NOD_GH: fakeGh("echo 'gh auth login' >&2; exit 4").path },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("取得に失敗（GH_AUTH）: gh が未認証です。gh auth login を実行してください");
    expect(r.stdout).toContain("前回取得");
    expect(r.stdout).toContain("状態: Merged");
  });

  test("gh が無ければ GH_NOT_INSTALLED", async () => {
    const id = await issueWithPr();
    const r = await runNod(["issue", "pr-status", id, "--refresh", "--json"], {
      cwd: repo,
      db,
      env: { NOD_GH: join(tempDir(), "no-such-gh") },
    });
    expect(r.json.fetchError.code).toBe("GH_NOT_INSTALLED");
  });

  test("PR の無い Issue は INVALID_ARGS", async () => {
    const created = (await runNod(["issue", "create", "--json", "PR なし"], { cwd: repo, db })).json;
    const r = await runNod(["issue", "pr-status", created.id, "--refresh", "--json"], { cwd: repo, db });
    expect(r.exitCode).toBe(1);
    expect(r.json.error.code).toBe("INVALID_ARGS");
    const shown = await runNod(["issue", "pr-status", created.id], { cwd: repo, db });
    expect(shown.stdout).toContain("PR がありません");
  });
});
