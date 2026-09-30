import { describe, expect, test } from "bun:test";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

// 追加指示（#51）の CLI。orca は使わない（記録と一覧だけで、送信は web の確認画面から行う）
describe("nod issue instruct / instructions", () => {
  test("人が記録し、LLM は start で受け取って確認済みになり、show で読める", async () => {
    const db = tempDb();
    const repo = makeRepo();
    registerRepo(db, repo);
    const created = (await runNod(["issue", "create", "検索", "--json"], { cwd: repo, db })).json;
    await runNod(["issue", "start", created.id], { cwd: repo, db, actor: "claude-code" });

    const recorded = await runNod(["issue", "instruct", created.id, "テストも追加して", "--json"], { cwd: repo, db });
    expect(recorded.exitCode).toBe(0);
    expect(recorded.json).toMatchObject({ kind: "instruction", body: "テストも追加して", createdBy: "me", sendState: "unsent" });

    const shown = await runNod(["issue", "show", created.id], { cwd: repo, db, actor: "claude-code" });
    expect(shown.stdout).toContain("未確認の追加指示:");
    expect(shown.stdout).toContain("[追加指示・未送信]");
    expect(shown.stdout).toContain("[追加指示・未確認]: テストも追加して");

    const started = await runNod(["issue", "start", created.id, "--json"], { cwd: repo, db, actor: "claude-code" });
    expect(started.json.pendingInstructions).toMatchObject([{ id: recorded.json.id, body: "テストも追加して" }]);
    const again = await runNod(["issue", "start", created.id, "--json"], { cwd: repo, db, actor: "claude-code" });
    expect(again.json.pendingInstructions).toEqual([]);

    const list = await runNod(["issue", "instructions", created.id], { cwd: repo, db, actor: "claude-code" });
    expect(list.stdout).toContain("claude-code が確認済み");
  });

  test("start のテキスト出力に追加指示を出す", async () => {
    const db = tempDb();
    const repo = makeRepo();
    registerRepo(db, repo);
    const created = (await runNod(["issue", "create", "検索", "--json"], { cwd: repo, db })).json;
    await runNod(["issue", "instruct", created.id, "1行目\n2行目"], { cwd: repo, db });
    const started = await runNod(["issue", "start", created.id], { cwd: repo, db, actor: "claude-code" });
    expect(started.stdout).toContain("追加指示（先に読んで対応する）:");
    expect(started.stdout).toContain("    1行目\n    2行目");
  });

  test("LLM は追加指示を記録できない", async () => {
    const db = tempDb();
    const repo = makeRepo();
    registerRepo(db, repo);
    const created = (await runNod(["issue", "create", "検索", "--json"], { cwd: repo, db })).json;
    const res = await runNod(["issue", "instruct", created.id, "x", "--json"], { cwd: repo, db, actor: "claude-code" });
    expect(res.exitCode).toBe(1);
    expect(res.json.error.code).toBe("FORBIDDEN_FOR_LLM");
  });
});

test("guide に追加指示の受け取り方と、記録・送信は人だけであることを書く", async () => {
  const { GUIDE } = await import("../src/guide");
  expect(GUIDE).toContain("## 追加指示を受け取る");
  expect(GUIDE).toContain("pendingInstructions");
  expect(GUIDE).toContain("nod issue instructions <id>");
  expect(GUIDE).toContain("LLM は FORBIDDEN_FOR_LLM");
});

test("nod review reject --delegate は対応依頼を記録し、LLM は start で受け取る（#58）", async () => {
  const db = tempDb();
  const repo = makeRepo();
  registerRepo(db, repo);
  const created = (await runNod(["issue", "create", "検索", "--json"], { cwd: repo, db })).json;
  await runNod(["issue", "start", created.id], { cwd: repo, db, actor: "claude-code" });
  await runNod(["issue", "done", created.id, "--summary", "直した"], { cwd: repo, db, actor: "claude-code" });
  const bad = await runNod(["review", "reject", created.id, "x", "--delegate", "other", "--json"], { cwd: repo, db });
  expect(bad.json.error.code).toBe("INVALID_ARGS");
  const rejected = await runNod(["review", "reject", created.id, "main に追従して", "--delegate", "rebase"], { cwd: repo, db });
  expect(rejected.exitCode).toBe(0);
  expect(rejected.stdout).toContain("対応依頼を記録しました");
  const started = await runNod(["issue", "start", created.id], { cwd: repo, db, actor: "claude-code" });
  expect(started.stdout).toContain("[対応依頼（rebase）・未送信]");
  expect(started.stdout).toContain("理由: main に追従して");
  const { GUIDE } = await import("../src/guide");
  expect(GUIDE).toContain("rebase：ベースブランチの最新に rebase");
});
