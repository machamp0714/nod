import { describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { addWorktree, makeRepo, runNod, tempDb, tempDir } from "./helpers";

describe("nod init と workspace", () => {
  test("init はリポジトリ名からキーを作って登録し、もう一度実行しても増やさない", async () => {
    const db = tempDb();
    const repo = makeRepo("api-server");
    const r = await runNod(["init", "--json"], { cwd: repo, db });
    expect(r.exitCode).toBe(0);
    expect(r.json).toMatchObject({ created: true, workspace: { key: "API", name: "api-server", path: repo } });
    expect((await runNod(["init", "--json"], { cwd: repo, db })).json.created).toBe(false);
  });

  test("worktree の中で init しても本体のリポジトリを登録する", async () => {
    const db = tempDb();
    const repo = makeRepo("web");
    const wt = addWorktree(repo, "feat-y");
    expect((await runNod(["init", "--json"], { cwd: wt, db })).json.workspace.path).toBe(repo);
  });

  test("キーが使われていれば KEY_TAKEN で --key を求め、git の外では NOT_A_GIT_REPO", async () => {
    const db = tempDb();
    await runNod(["init"], { cwd: makeRepo("api-server"), db });
    const gateway = makeRepo("api-gateway");
    const taken = await runNod(["init", "--json"], { cwd: gateway, db });
    expect(taken.json.error.code).toBe("KEY_TAKEN");
    expect((await runNod(["init", "--key", "gw", "--json"], { cwd: gateway, db })).json.workspace.key).toBe("GW");
    expect((await runNod(["init", "--json"], { cwd: tempDir(), db })).json.error.code).toBe("NOT_A_GIT_REPO");
  });

  test("workspace remove は --yes がなければ件数を示して止め、あれば Issue ごと消す", async () => {
    const db = tempDb();
    const repo = makeRepo("api-server");
    await runNod(["init"], { cwd: repo, db });
    await runNod(["issue", "create", "t"], { cwd: repo, db });
    const stopped = await runNod(["workspace", "remove", "API", "--json"], { cwd: repo, db });
    expect(stopped.exitCode).toBe(1);
    expect(stopped.json.error.code).toBe("CONFIRM_REQUIRED");
    expect(stopped.json.error.message).toContain("1 件");
    const removed = await runNod(["workspace", "remove", "API", "--yes", "--json"], { cwd: repo, db });
    expect(removed.json.deletedIssues).toBe(1);
    expect((await runNod(["workspace", "list", "--json"], { cwd: repo, db })).json).toEqual([]);
  });

  test("skills get nod は手引きを出力し、知らない名前は UNKNOWN_SKILL", async () => {
    const cwd = tempDir();
    const db = tempDb();
    const r = await runNod(["skills", "get", "nod"], { cwd, db });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("nod issue next");
    expect((await runNod(["skills", "get", "nope", "--json"], { cwd, db })).json.error.code).toBe("UNKNOWN_SKILL");
  });
});

// controller の裁定で追加したテスト
describe("init と workspace の追加の振る舞い", () => {
  test("シンボリックリンク経由で init しても実体のパスを登録し、リンク経由でも Workspace を特定できる", async () => {
    const db = tempDb();
    const repo = makeRepo("api-server");
    const link = join(tempDir("nod-link-"), "linked");
    symlinkSync(repo, link);
    const r = await runNod(["init", "--json"], { cwd: link, db });
    expect(r.exitCode).toBe(0);
    expect(r.json.workspace.path).toBe(repo);
    const created = await runNod(["issue", "create", "t", "--json"], { cwd: link, db });
    expect(created.json.id).toBe("API-1");
    // -w にリンクのパスを渡しても見つかる
    const listed = await runNod(["issue", "list", "-w", link, "--json"], { cwd: tempDir(), db });
    expect(listed.json.map((i: { id: string }) => i.id)).toEqual(["API-1"]);
  });

  test("workspace remove はパスでも指定でき、--yes がなければ LLM でも CONFIRM_REQUIRED", async () => {
    const db = tempDb();
    const repo = makeRepo("api-server");
    await runNod(["init"], { cwd: repo, db });
    const stopped = await runNod(["workspace", "remove", repo, "--json"], { cwd: repo, db, actor: "claude-code" });
    expect(stopped.exitCode).toBe(1);
    expect(stopped.json.error.code).toBe("CONFIRM_REQUIRED");
    expect(stopped.json.error.message).toContain("0 件");
    expect((await runNod(["workspace", "remove", "NOPE", "--json"], { cwd: repo, db })).json.error.code).toBe("NOT_FOUND");
    expect((await runNod(["workspace", "remove", repo, "--yes", "--json"], { cwd: repo, db })).json.deletedIssues).toBe(0);
  });

  test("skills get nod --json は name と guide を返す", async () => {
    const r = await runNod(["skills", "get", "nod", "--json"], { cwd: tempDir(), db: tempDb() });
    expect(r.exitCode).toBe(0);
    expect(r.json.name).toBe("nod");
    expect(r.json.guide.split("\n")[0]).toBe("# nod の使い方（LLM 向け）");
  });
});

describe("バージョンと --json の検出", () => {
  test("nod --version は package.json の version を出して 0 で終わる", async () => {
    const pkg = await Bun.file(join(import.meta.dir, "../package.json")).json();
    const r = await runNod(["--version"], { cwd: tempDir(), db: tempDb() });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  test("-- の後ろの --json はタイトルとして扱い、出力は JSON にしない", async () => {
    const db = tempDb();
    const repo = makeRepo("api-server");
    await runNod(["init"], { cwd: repo, db });
    const r = await runNod(["issue", "create", "--", "--json"], { cwd: repo, db });
    expect(r.exitCode).toBe(0);
    expect(r.json).toBeUndefined();
    expect((await runNod(["issue", "show", "API-1", "--json"], { cwd: repo, db })).json.title).toBe("--json");
  });

  test("-- の後ろに --json があっても、エラーは JSON にせず標準エラーに出す", async () => {
    const db = tempDb();
    const r = await runNod(["issue", "show", "NOPE-1", "--", "--json"], { cwd: tempDir(), db });
    expect(r.exitCode).toBe(1);
    expect(r.json).toBeUndefined();
    expect(r.stderr).toContain("エラー");
  });
});
