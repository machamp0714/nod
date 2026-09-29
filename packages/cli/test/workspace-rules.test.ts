import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { GUIDE } from "../src/guide";
import { makeRepo, runNod, tempDb, tempDir } from "./helpers";

const HEADING = "## この Workspace の作業規約（API）";

async function setupRepo() {
  const db = tempDb();
  const repo = makeRepo("api-server");
  await runNod(["init"], { cwd: repo, db });
  return { db, repo };
}

describe("nod workspace rules", () => {
  test("未登録なら show は null / 未登録と表示する", async () => {
    const { db, repo } = await setupRepo();
    expect((await runNod(["workspace", "rules", "show", "--json"], { cwd: repo, db })).json).toBeNull();
    expect((await runNod(["workspace", "rules", "show"], { cwd: repo, db })).stdout).toContain("作業規約は登録されていません");
  });

  test("--text と --from で登録・更新でき、show で読める", async () => {
    const { db, repo } = await setupRepo();
    const set = await runNod(["workspace", "rules", "set", "--text", "- 日本語で書く", "--json"], { cwd: repo, db });
    expect(set.exitCode).toBe(0);
    expect(set.json).toMatchObject({ workspaceKey: "API", body: "- 日本語で書く", updatedBy: "me" });

    const file = join(tempDir(), "rules.md");
    writeFileSync(file, "# 規約\n\n- テストを先に書く\n");
    await runNod(["workspace", "rules", "set", "--from", file], { cwd: repo, db });
    const shown = await runNod(["workspace", "rules", "show"], { cwd: repo, db });
    expect(shown.stdout).toContain("- テストを先に書く");
    expect(shown.stdout).not.toContain("日本語で書く");
  });

  test("-w で別の Workspace を指定できる", async () => {
    const { db } = await setupRepo();
    await runNod(["workspace", "rules", "set", "-w", "API", "--text", "a"], { cwd: tempDir(), db });
    expect((await runNod(["workspace", "rules", "show", "-w", "API", "--json"], { cwd: tempDir(), db })).json.body).toBe("a");
  });

  test("clear で削除する", async () => {
    const { db, repo } = await setupRepo();
    await runNod(["workspace", "rules", "set", "--text", "a"], { cwd: repo, db });
    const cleared = await runNod(["workspace", "rules", "clear"], { cwd: repo, db });
    expect(cleared.exitCode).toBe(0);
    expect((await runNod(["workspace", "rules", "show", "--json"], { cwd: repo, db })).json).toBeNull();
  });

  test("--text と --from のどちらか一方が要る。10,000 文字を超えると INVALID_ARGS", async () => {
    const { db, repo } = await setupRepo();
    expect((await runNod(["workspace", "rules", "set", "--json"], { cwd: repo, db })).json.error.code).toBe("INVALID_ARGS");
    const both = await runNod(["workspace", "rules", "set", "--text", "a", "--from", "x.md", "--json"], { cwd: repo, db });
    expect(both.json.error.code).toBe("INVALID_ARGS");
    const long = await runNod(["workspace", "rules", "set", "--text", "a".repeat(10001), "--json"], { cwd: repo, db });
    expect(long.json.error.code).toBe("INVALID_ARGS");
  });

  test("LLM は set・clear できず FORBIDDEN_FOR_LLM、show はできる", async () => {
    const { db, repo } = await setupRepo();
    await runNod(["workspace", "rules", "set", "--text", "a"], { cwd: repo, db });
    const set = await runNod(["workspace", "rules", "set", "--text", "b", "--json"], { cwd: repo, db, actor: "claude-code" });
    expect(set.exitCode).toBe(1);
    expect(set.json.error.code).toBe("FORBIDDEN_FOR_LLM");
    const clear = await runNod(["workspace", "rules", "clear", "--json"], { cwd: repo, db, actor: "codex" });
    expect(clear.json.error.code).toBe("FORBIDDEN_FOR_LLM");
    expect((await runNod(["workspace", "rules", "show", "--json"], { cwd: repo, db, actor: "codex" })).json.body).toBe("a");
  });
});

describe("LLM 向け出力に作業規約を含める", () => {
  test("未登録なら skills get・issue show・next・start の出力は規約なしの従来どおり", async () => {
    const { db, repo } = await setupRepo();
    const guide = await runNod(["skills", "get", "nod"], { cwd: repo, db });
    expect(guide.stdout).toBe(`${GUIDE}\n`);
    expect((await runNod(["skills", "get", "nod", "--json"], { cwd: repo, db })).json).toEqual({ name: "nod", guide: GUIDE });

    await runNod(["issue", "create", "t1"], { cwd: repo, db });
    await runNod(["issue", "create", "t2"], { cwd: repo, db });
    const show = await runNod(["issue", "show", "API-1", "--json"], { cwd: repo, db });
    expect(show.json).not.toHaveProperty("workspaceRules");
    expect((await runNod(["issue", "show", "API-1"], { cwd: repo, db })).stdout).not.toContain("作業規約");
    const next = await runNod(["issue", "next", "--json"], { cwd: repo, db, actor: "claude-code" });
    expect(next.json).not.toHaveProperty("workspaceRules");
    const start = await runNod(["issue", "start", "API-2"], { cwd: repo, db, actor: "codex" });
    expect(start.stdout).toStartWith("着手しました: API-2");
    expect(start.stdout.trimEnd().split("\n")).toHaveLength(1);
  });

  test("Workspace の外で skills get しても従来どおり", async () => {
    const db = tempDb();
    expect((await runNod(["skills", "get", "nod"], { cwd: tempDir(), db })).stdout).toBe(`${GUIDE}\n`);
  });

  test("登録済みなら skills get の末尾に規約の節を足す", async () => {
    const { db, repo } = await setupRepo();
    await runNod(["workspace", "rules", "set", "--text", "- PR は draft で作る"], { cwd: repo, db });
    const text = (await runNod(["skills", "get", "nod"], { cwd: repo, db })).stdout;
    expect(text.startsWith(GUIDE)).toBe(true);
    expect(text).toContain(HEADING);
    expect(text.indexOf(HEADING)).toBeGreaterThan(text.indexOf("## 停滞候補"));
    expect(text).toContain("- PR は draft で作る");
    const json = (await runNod(["skills", "get", "nod", "--json"], { cwd: repo, db })).json;
    expect(json.guide).toContain(HEADING);
    expect(json.rules).toMatchObject({ workspaceKey: "API", body: "- PR は draft で作る" });
    expect((await runNod(["skills", "get", "nod", "-w", "API"], { cwd: tempDir(), db })).stdout).toContain(HEADING);
  });

  test("登録済みなら issue show に Issue の Workspace の規約を含める", async () => {
    const { db, repo } = await setupRepo();
    await runNod(["issue", "create", "t"], { cwd: repo, db });
    await runNod(["workspace", "rules", "set", "--text", "- PR は draft で作る"], { cwd: repo, db });
    const text = (await runNod(["issue", "show", "API-1"], { cwd: tempDir(), db })).stdout;
    expect(text).toContain(HEADING);
    expect(text).toContain("- PR は draft で作る");
    const json = (await runNod(["issue", "show", "API-1", "--json"], { cwd: repo, db })).json;
    expect(json.workspaceRules).toMatchObject({ body: "- PR は draft で作る", updatedBy: "me" });
    expect(json.workspaceRules.updatedAt).toBeString();
  });

  test("登録済みなら next・start の出力に規約を含め、候補がなければ null のまま", async () => {
    const { db, repo } = await setupRepo();
    await runNod(["workspace", "rules", "set", "--text", "- PR は draft で作る"], { cwd: repo, db });
    expect((await runNod(["issue", "next", "--json"], { cwd: repo, db, actor: "claude-code" })).json).toBeNull();

    await runNod(["issue", "create", "t1"], { cwd: repo, db });
    await runNod(["issue", "create", "t2"], { cwd: repo, db });
    const next = await runNod(["issue", "next", "--json"], { cwd: repo, db, actor: "claude-code" });
    expect(next.json.id).toBe("API-1");
    expect(next.json.workspaceRules.body).toBe("- PR は draft で作る");
    const start = await runNod(["issue", "start", "API-2"], { cwd: repo, db, actor: "codex" });
    expect(start.stdout).toStartWith("着手しました: API-2");
    expect(start.stdout).toContain(HEADING);
  });
});
