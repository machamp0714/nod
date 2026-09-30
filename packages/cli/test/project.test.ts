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

describe("Project の健全性 CLI", () => {
  test("--health で報告に健全性を添え、一覧・詳細・報告一覧で現在値と履歴を確かめられる", () => {
    const db = tempDb();
    const cwd = tempDir();
    cli(db, cwd, ["project", "create", "検索"]);
    cli(db, cwd, ["project", "create", "認証"]);
    expect(cli(db, cwd, ["project", "list"]).stdout).toContain("健全性 未設定");
    const risky = cli(db, cwd, ["project", "report", "add", "検索", "遅れそう", "--health", "at_risk", "--json"]);
    expect(risky.code).toBe(0);
    expect(risky.json).toMatchObject({ author: "codex", health: "at_risk" });
    cli(db, cwd, ["project", "report", "add", "--health", "on_track", "検索", "--", "- 取り戻した"], "me");
    cli(db, cwd, ["project", "report", "add", "検索", "メモ"]);

    const list = cli(db, cwd, ["project", "list", "--json"]).json;
    expect(Object.fromEntries(list.map((p: { name: string; health: string | null }) => [p.name, p.health]))).toEqual({ 検索: "on_track", 認証: null });
    expect(cli(db, cwd, ["project", "list"]).stdout).toContain("健全性 on_track");
    expect(cli(db, cwd, ["project", "show", "検索", "--json"]).json.health).toBe("on_track");
    expect(cli(db, cwd, ["project", "show", "検索"]).stdout.split("\n")[0]).toContain("健全性 on_track");
    const history = cli(db, cwd, ["project", "report", "list", "検索", "--json"]).json;
    expect(history.map((u: { health: string | null }) => u.health)).toEqual([null, "on_track", "at_risk"]);
    const text = cli(db, cwd, ["project", "report", "list", "検索"]).stdout;
    expect(text).toContain("me（on_track）:");
    expect(text).toContain("codex（at_risk）:");
    expect(text).toMatch(/codex:\n    メモ/);
  });

  test("不正な --health は INVALID_ARGS で、報告を保存しない", () => {
    const db = tempDb();
    const cwd = tempDir();
    cli(db, cwd, ["project", "create", "保持"]);
    const result = cli(db, cwd, ["project", "report", "add", "保持", "本文", "--health", "good", "--json"]);
    expect(result.code).toBe(1);
    expect(result.json.error.code).toBe("INVALID_ARGS");
    expect(cli(db, cwd, ["project", "report", "list", "保持", "--json"]).json).toEqual([]);
  });
});

describe("Milestone CLI", () => {
  test("作成・一覧・編集・削除し、Issue を名前で紐付けて進捗を確かめられる", () => {
    const path = tempDb();
    const db = openDb(path);
    const me = { db, actor: "me" };
    createProject(me, { name: "検索" });
    db.query("INSERT INTO workspaces (key, name, path, created_at, color) VALUES ('API', 'api', '/tmp/ms-api', '2000', '#7C5CFF')").run();
    const a = createIssue(me, { workspaceId: 1, title: "a", projectRef: "検索" });
    const b = createIssue(me, { workspaceId: 1, title: "b", projectRef: "検索" });
    db.close();
    const cwd = tempDir();

    const created = cli(path, cwd, ["project", "milestone", "add", "検索", "β公開", "--target", "2026-11-30", "-d", "社内向け", "--json"]);
    expect(created.code).toBe(0);
    expect(created.json).toMatchObject({ name: "β公開", targetDate: "2026-11-30", description: "社内向け", createdBy: "codex" });
    expect(cli(path, cwd, ["project", "milestone", "add", "検索", "α"]).stdout).toContain("Milestone を作りました");
    expect(cli(path, cwd, ["issue", "update", a.id, "--milestone", "β公開", "--json"]).json.milestone).toMatchObject({ name: "β公開" });
    cli(path, cwd, ["issue", "update", b.id, "--milestone", String(created.json.id), "-s", "done"], "me");

    const list = cli(path, cwd, ["project", "milestone", "list", "検索", "--json"]).json;
    expect(list.map((m: { name: string; done: number; total: number }) => [m.name, m.done, m.total])).toEqual([["β公開", 1, 2], ["α", 0, 0]]);
    expect(cli(path, cwd, ["project", "milestone", "list", "検索"]).stdout).toContain("β公開  1/2  目標日 2026-11-30");
    expect(cli(path, cwd, ["project", "show", "検索"]).stdout).toContain("Milestones:");

    const updated = cli(path, cwd, ["project", "milestone", "update", "検索", "β公開", "--name", "β", "--target", "", "-d", "", "--json"]);
    expect(updated.json).toMatchObject({ name: "β", targetDate: null, description: null });
    expect(cli(path, cwd, ["issue", "update", a.id, "--milestone", "", "--json"]).json.milestone).toBeNull();
    cli(path, cwd, ["issue", "update", a.id, "--milestone", "β"]);
    expect(cli(path, cwd, ["issue", "show", a.id]).stdout).toContain("Milestone: β");
    // 削除は人だけ（LLM は FORBIDDEN_FOR_LLM）
    const forbidden = cli(path, cwd, ["project", "milestone", "remove", "検索", "β", "--json"]);
    expect([forbidden.code, forbidden.json.error.code]).toEqual([1, "FORBIDDEN_FOR_LLM"]);
    expect(cli(path, cwd, ["project", "milestone", "remove", "検索", "β", "--json"], "me").json).toEqual({ id: created.json.id });
    expect(cli(path, cwd, ["issue", "show", a.id]).stdout).not.toContain("Milestone:");
    expect(cli(path, cwd, ["project", "milestone", "list", "検索", "--json"]).json.map((m: { name: string }) => m.name)).toEqual(["α"]);
  });

  test("重複・不正な目標日・別 Project の Milestone・存在しないものはエラー", () => {
    const path = tempDb();
    const db = openDb(path);
    const me = { db, actor: "me" };
    createProject(me, { name: "検索" });
    createProject(me, { name: "認証" });
    db.query("INSERT INTO workspaces (key, name, path, created_at, color) VALUES ('API', 'api', '/tmp/ms-api2', '2000', '#7C5CFF')").run();
    const a = createIssue(me, { workspaceId: 1, title: "a", projectRef: "検索" });
    db.close();
    const cwd = tempDir();
    cli(path, cwd, ["project", "milestone", "add", "検索", "α"]);
    const foreign = cli(path, cwd, ["project", "milestone", "add", "認証", "別", "--json"]).json;
    for (const [args, code] of [
      [["project", "milestone", "add", "検索", "α"], "MILESTONE_EXISTS"],
      [["project", "milestone", "add", "検索", "β", "--target", "2026/11/30"], "INVALID_ARGS"],
      [["project", "milestone", "update", "検索", "ない", "--name", "x"], "NOT_FOUND"],
      [["issue", "update", a.id, "--milestone", String(foreign.id)], "INVALID_ARGS"],
      [["issue", "update", a.id, "--milestone", "別"], "NOT_FOUND"],
    ] as const) {
      const result = cli(path, cwd, [...args, "--json"]);
      expect(result.code).toBe(1);
      expect(result.json.error.code).toBe(code);
    }
    const notHere = cli(path, cwd, ["project", "milestone", "remove", "検索", String(foreign.id), "--json"], "me");
    expect([notHere.code, notHere.json.error.code]).toEqual([1, "NOT_FOUND"]);
    expect(cli(path, cwd, ["project", "milestone", "list", "認証", "--json"]).json).toHaveLength(1);
  });
});
