import { describe, expect, test } from "bun:test";
import { makeRepo, runNod, tempDb } from "./helpers";

async function setupRepo() {
  const db = tempDb();
  const repo = makeRepo("api-server");
  await runNod(["init"], { cwd: repo, db });
  return { db, repo };
}

describe("nod workspace labels", () => {
  test("未定義なら list は空と表示する", async () => {
    const { db, repo } = await setupRepo();
    expect((await runNod(["workspace", "labels", "list", "--json"], { cwd: repo, db })).json).toEqual([]);
    expect((await runNod(["workspace", "labels", "list"], { cwd: repo, db })).stdout).toContain("ラベルの定義はありません");
  });

  test("add・update（改名）・remove ができ、改名は Issue のラベルにも反映する", async () => {
    const { db, repo } = await setupRepo();
    await runNod(["issue", "create", "a", "-l", "bug"], { cwd: repo, db });
    const added = await runNod(["workspace", "labels", "add", "bug", "--color", "#db2777", "-d", "不具合", "--json"], { cwd: repo, db });
    expect(added.exitCode).toBe(0);
    expect(added.json).toMatchObject({ workspaceKey: "API", name: "bug", color: "#DB2777", description: "不具合", issueCount: 1 });
    const listed = await runNod(["workspace", "labels", "list"], { cwd: repo, db });
    expect(listed.stdout).toContain("bug");
    expect(listed.stdout).toContain("#DB2777");
    expect(listed.stdout).toContain("不具合");

    const renamed = await runNod(["workspace", "labels", "update", "bug", "--name", "defect", "--color", "#2563EB"], { cwd: repo, db });
    expect(renamed.exitCode).toBe(0);
    expect(renamed.stdout).toContain("defect");
    expect((await runNod(["issue", "show", "API-1", "--json"], { cwd: repo, db })).json.labels).toEqual(["defect"]);

    const removed = await runNod(["workspace", "labels", "remove", "defect", "--json"], { cwd: repo, db });
    expect(removed.json).toEqual({ workspaceKey: "API", name: "defect", removed: true });
    expect((await runNod(["issue", "show", "API-1", "--json"], { cwd: repo, db })).json.labels).toEqual(["defect"]);
  });

  test("update に変更点がなければ INVALID_ARGS", async () => {
    const { db, repo } = await setupRepo();
    await runNod(["workspace", "labels", "add", "bug", "--color", "#DB2777"], { cwd: repo, db });
    const r = await runNod(["workspace", "labels", "update", "bug", "--json"], { cwd: repo, db });
    expect(r.exitCode).not.toBe(0);
    expect(r.json.error.code).toBe("INVALID_ARGS");
  });

  test("LLM は add・update・remove できず FORBIDDEN_FOR_LLM、list はできる", async () => {
    const { db, repo } = await setupRepo();
    const add = await runNod(["workspace", "labels", "add", "bug", "--color", "#DB2777", "--json"], { cwd: repo, db, actor: "claude-code" });
    expect(add.json.error.code).toBe("FORBIDDEN_FOR_LLM");
    await runNod(["workspace", "labels", "add", "bug", "--color", "#DB2777"], { cwd: repo, db });
    for (const args of [["update", "bug", "--color", "#2563EB"], ["remove", "bug"]]) {
      const r = await runNod(["workspace", "labels", ...args, "--json"], { cwd: repo, db, actor: "claude-code" });
      expect(r.json.error.code).toBe("FORBIDDEN_FOR_LLM");
    }
    const list = await runNod(["workspace", "labels", "list", "--json"], { cwd: repo, db, actor: "claude-code" });
    expect(list.json.map((l: { color: string }) => l.color)).toEqual(["#DB2777"]);
  });
});

describe("nod workspace status-names", () => {
  test("show は全ステータスの内部値と表示名を出し、set・reset で変えられる", async () => {
    const { db, repo } = await setupRepo();
    expect((await runNod(["workspace", "status-names", "show", "--json"], { cwd: repo, db })).json).toEqual({ workspaceKey: "API", names: {} });
    const set = await runNod(["workspace", "status-names", "set", "todo", "着手可", "--json"], { cwd: repo, db });
    expect(set.json).toEqual({ workspaceKey: "API", names: { todo: "着手可" } });
    await runNod(["workspace", "status-names", "set", "in_review", "確認待ち"], { cwd: repo, db });
    const shown = await runNod(["workspace", "status-names", "show"], { cwd: repo, db });
    expect(shown.stdout).toContain("todo");
    expect(shown.stdout).toContain("着手可");
    expect(shown.stdout).toContain("確認待ち");
    expect(shown.stdout).toContain("Backlog");

    await runNod(["workspace", "status-names", "reset", "todo"], { cwd: repo, db });
    expect((await runNod(["workspace", "status-names", "show", "--json"], { cwd: repo, db })).json.names).toEqual({ in_review: "確認待ち" });
    await runNod(["workspace", "status-names", "reset"], { cwd: repo, db });
    expect((await runNod(["workspace", "status-names", "show", "--json"], { cwd: repo, db })).json.names).toEqual({});
  });

  test("テキスト出力は「表示名 (内部値)」、--json と --status は内部値のまま", async () => {
    const { db, repo } = await setupRepo();
    await runNod(["workspace", "status-names", "set", "todo", "着手可"], { cwd: repo, db });
    const created = await runNod(["issue", "create", "a"], { cwd: repo, db });
    expect(created.stdout).toContain("着手可 (todo)");
    expect((await runNod(["issue", "show", "API-1"], { cwd: repo, db })).stdout).toContain("ステータス: 着手可 (todo)");
    expect((await runNod(["issue", "show", "API-1", "--json"], { cwd: repo, db })).json.status).toBe("todo");
    const list = await runNod(["issue", "list", "--status", "todo"], { cwd: repo, db });
    expect(list.stdout).toContain("着手可 (todo)");
    const updated = await runNod(["issue", "update", "API-1", "--status", "backlog"], { cwd: repo, db });
    expect(updated.exitCode).toBe(0);
    expect(updated.stdout).toContain("Backlog");
  });

  test("未知のステータスは INVALID_ARGS、LLM は set・reset できず FORBIDDEN_FOR_LLM", async () => {
    const { db, repo } = await setupRepo();
    expect((await runNod(["workspace", "status-names", "set", "ready", "x", "--json"], { cwd: repo, db })).json.error.code).toBe("INVALID_ARGS");
    for (const args of [["set", "todo", "x"], ["reset"]]) {
      const r = await runNod(["workspace", "status-names", ...args, "--json"], { cwd: repo, db, actor: "claude-code" });
      expect(r.json.error.code).toBe("FORBIDDEN_FOR_LLM");
    }
    expect((await runNod(["workspace", "status-names", "show", "--json"], { cwd: repo, db, actor: "claude-code" })).exitCode).toBe(0);
  });
});
