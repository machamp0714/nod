import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createIssue, createProject, openDb, updateIssue } from "@nod/core";
import { tempDb, tempDir } from "./helpers";

function cli(db: string, cwd: string, args: string[], actor = "codex") {
  const proc = Bun.spawnSync(["bun", join(import.meta.dir, "../src/main.ts"), ...args], {
    cwd, env: { ...process.env, NOD_DB: db, NOD_ORCA: "0", NOD_ACTOR: actor }, stdout: "pipe", stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  return { code: proc.exitCode, stdout, stderr: proc.stderr.toString(), json: args.includes("--json") ? JSON.parse(stdout) : undefined };
}

describe("Project CLI", () => {
  test("Workspace未登録の場所から日本語名とIDで完了・再開できる", () => {
    const db = tempDb();
    const cwd = tempDir();
    const created = cli(db, cwd, ["project", "create", "認証 基盤 v1.0", "--json"]);
    expect(created.code).toBe(0);
    const id = String(created.json.id);
    const completed = cli(db, cwd, ["project", "update", "認証 基盤 v1.0", "--status", "completed", "--json"]);
    expect(completed.code).toBe(0);
    expect(completed.json).toMatchObject({ id: Number(id), name: "認証 基盤 v1.0", status: "completed" });
    expect(cli(db, cwd, ["project", "list", "--json"]).json).toEqual([]);
    expect(cli(db, cwd, ["project", "list", "--all", "--json"]).json).toHaveLength(1);
    expect(cli(db, cwd, ["project", "update", id, "--status", "completed", "--json"]).json.updatedAt).toBe(completed.json.updatedAt);
    const reopened = cli(db, cwd, ["project", "update", id, "--status", "started"]);
    expect(reopened.code).toBe(0);
    expect(reopened.stdout).toContain("認証 基盤 v1.0（started）");
    expect(cli(db, cwd, ["project", "show", id, "--json"]).json.status).toBe("started");
    expect(cli(db, cwd, ["project", "list", "--json"]).json).toHaveLength(1);
  });

  test("不正値・欠落・不存在はCLIエラーになり状態を保持する", () => {
    const db = tempDb();
    const cwd = tempDir();
    cli(db, cwd, ["project", "create", "保持"]);
    for (const [args, code] of [
      [["project", "update", "保持", "--status", "done"], "INVALID_ARGS"],
      [["project", "update", "保持"], "INVALID_ARGS"],
      [["project", "update", "不存在", "--status", "completed"], "NOT_FOUND"],
    ] as const) {
      const result = cli(db, cwd, [...args, "--json"]);
      expect(result.code).toBe(1);
      expect(result.json.error.code).toBe(code);
      expect(cli(db, cwd, ["project", "show", "保持", "--json"]).json.status).toBe("planned");
    }
  });

  test("一覧のJSONとテキストにレビュー待ちを出す", () => {
    const path = tempDb();
    const db = openDb(path);
    const me = { db, actor: "me" };
    createProject(me, { name: "レビュー" });
    // WorkspaceはCLI登録を要求せず、テスト用DBだけに用意する。
    db.query("INSERT INTO workspaces (key, name, path, created_at, color) VALUES ('API', 'api', '/tmp/review-api', '2000', '#7C5CFF')").run();
    const issue = createIssue(me, { workspaceId: 1, title: "確認", projectRef: "レビュー" });
    updateIssue(me, issue.id, { status: "in_review" });
    db.close();
    const cwd = tempDir();
    expect(cli(path, cwd, ["project", "list", "--json"]).json[0].agents.awaitingReview).toBe(1);
    expect(cli(path, cwd, ["project", "list"]).stdout).toContain("レビュー待ち 1");
  });
});

describe("Project の進捗報告 CLI", () => {
  test("me と LLM が書き、書き手・日時つきで新しい順に読める", () => {
    const db = tempDb();
    const cwd = tempDir();
    cli(db, cwd, ["project", "create", "検索"]);
    cli(db, cwd, ["project", "create", "認証"]);
    const byMe = cli(db, cwd, ["project", "report", "add", "検索", "索引を作り直した\n次は計測", "--json"], "me");
    expect(byMe.code).toBe(0);
    expect(byMe.json).toMatchObject({ author: "me", body: "索引を作り直した\n次は計測" });
    const byCodex = cli(db, cwd, ["project", "report", "add", String(byMe.json.projectId), "計測を終えた"]);
    expect(byCodex.code).toBe(0);
    expect(byCodex.stdout).toContain("進捗報告を書きました");
    cli(db, cwd, ["project", "report", "add", "認証", "別 Project"]);
    // 箇条書きのように - で始まる本文は -- の後ろに置けば書ける
    const bullets = cli(db, cwd, ["project", "report", "add", "--json", "認証", "--", "- 完了\n- 次"]);
    expect(bullets.code).toBe(0);
    expect(bullets.json.body).toBe("- 完了\n- 次");

    const list = cli(db, cwd, ["project", "report", "list", "検索", "--json"]).json;
    expect(list.map((u: { author: string; body: string }) => [u.author, u.body])).toEqual([
      ["codex", "計測を終えた"],
      ["me", "索引を作り直した\n次は計測"],
    ]);
    expect(list.every((u: { createdAt: string }) => !Number.isNaN(Date.parse(u.createdAt)))).toBe(true);
    const text = cli(db, cwd, ["project", "report", "list", "検索"]).stdout;
    expect(text.indexOf("codex:")).toBeLessThan(text.indexOf("me:"));
    expect(text).not.toContain("別 Project");
    const show = cli(db, cwd, ["project", "show", "検索"]);
    expect(show.stdout).toContain("最新の進捗報告（全 2 件");
    expect(show.stdout).toContain("計測を終えた");
    expect(cli(db, cwd, ["project", "show", "検索", "--json"]).json.updates).toHaveLength(2);
    expect(cli(db, cwd, ["project", "report", "list", "認証"]).stdout).not.toContain("計測");
  });

  test("空・上限超過・不存在はエラーで、報告も Project も変えない", () => {
    const db = tempDb();
    const cwd = tempDir();
    cli(db, cwd, ["project", "create", "保持"]);
    const before = cli(db, cwd, ["project", "show", "保持", "--json"]).json;
    for (const [args, code] of [
      [["project", "report", "add", "保持", "  "], "INVALID_ARGS"],
      [["project", "report", "add", "保持", "あ".repeat(10001)], "INVALID_ARGS"],
      [["project", "report", "add", "不存在", "本文"], "NOT_FOUND"],
      [["project", "report", "list", "不存在"], "NOT_FOUND"],
    ] as const) {
      const result = cli(db, cwd, [...args, "--json"]);
      expect(result.code).toBe(1);
      expect(result.json.error.code).toBe(code);
    }
    expect(cli(db, cwd, ["project", "report", "list", "保持"]).stdout).toContain("進捗報告はありません");
    expect(cli(db, cwd, ["project", "show", "保持", "--json"]).json).toEqual(before);
  });
});
