import { expect, test } from "bun:test";
import { git, makeRepo, registerRepo, runNod, tempDb } from "./helpers";

// 一時リポジトリの git log を読む（実リポジトリ・ネットワークには触れない）
function fixture() {
  const db = tempDb(), cwd = makeRepo();
  registerRepo(db, cwd);
  return { db, cwd, opts: { cwd, db } };
}

test("nod git sync: --dry-run は候補を示し（LLM も可）、実行は me だけ・有効なときだけ in_review にし、undo で戻せる（#68）", async () => {
  const { cwd, opts } = fixture();
  const id = (await runNod(["issue", "create", "検索を直す", "--json"], opts)).json.id;
  await runNod(["issue", "update", id, "--status", "todo"], opts);
  git(cwd, "commit", "-q", "--allow-empty", "-m", `検索の N+1 を解消\n\nFixes ${id}`);

  const dry = await runNod(["git", "sync", "--dry-run"], { ...opts, actor: "claude-code" });
  expect(dry.exitCode).toBe(0);
  expect(dry.stdout).toContain("コミット連動（HEAD・直近30日・2 コミットを読みました）: 対象 1 件");
  expect(dry.stdout).toContain("コミット連動は無効です");
  expect(dry.stdout).toMatch(new RegExp(`${id}  todo  [0-9a-f]{12} Fixes 「検索の N\\+1 を解消」`));
  expect(dry.stdout).toContain("dry-run のため変更していません");

  expect((await runNod(["git", "sync", "--json"], opts)).json.error.code).toBe("AUTOMATION_DISABLED");
  expect((await runNod(["automation", "set", "--commit-review", "on", "--json"], opts)).json.commitReview).toBe(true);
  expect((await runNod(["automation", "show"], opts)).stdout).toContain("コミット連動: nod git sync");
  expect((await runNod(["git", "sync", "--json"], { ...opts, actor: "claude-code" })).json.error.code).toBe("FORBIDDEN_FOR_LLM");

  const run = await runNod(["git", "sync"], opts);
  expect(run.exitCode).toBe(0);
  expect(run.stdout).toContain(`in_review にしました: 1 件（${id}）`);
  expect((await runNod(["issue", "show", id, "--json"], opts)).json.status).toBe("in_review");
  expect((await runNod(["git", "sync", "--json"], opts)).json.total).toBe(0);

  const undo = await runNod(["automation", "undo", id], opts);
  expect(undo.stdout).toContain(`${id} を in_review から todo に戻しました（コミット `);
  expect((await runNod(["issue", "show", id, "--json"], opts)).json.status).toBe("todo");
});

test("nod git sync: 引数の誤りと読めない ref を拒む", async () => {
  const { opts } = fixture();
  for (const args of [["--since", "0"], ["--since", "x"], ["--limit", "501"], ["--ref", "-p"]]) {
    expect((await runNod(["git", "sync", "--dry-run", ...args, "--json"], opts)).json.error.code).toBe("INVALID_ARGS");
  }
  expect((await runNod(["git", "sync", "--dry-run", "--ref", "no-such", "--json"], opts)).json.error.code).toBe("GIT_FAILED");
});
