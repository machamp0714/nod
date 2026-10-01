import { describe, expect, test } from "bun:test";
import { makeRepo, runNod, tempDb } from "./helpers";

async function setupRepo() {
  const db = tempDb();
  const repo = makeRepo("api-server");
  await runNod(["init"], { cwd: repo, db });
  return { db, repo };
}

describe("nod workspace agent（#210）", () => {
  test("show は既定のエージェントを出し、set で claude・codex に変えられる", async () => {
    const { db, repo } = await setupRepo();
    expect((await runNod(["workspace", "agent", "show", "--json"], { cwd: repo, db })).json).toEqual({ workspaceKey: "API", defaultAgent: "claude" });
    expect((await runNod(["workspace", "agent", "show"], { cwd: repo, db })).stdout).toContain("Claude Code（claude）");
    const set = await runNod(["workspace", "agent", "set", "codex", "--json"], { cwd: repo, db });
    expect(set.json).toEqual({ workspaceKey: "API", defaultAgent: "codex" });
    expect((await runNod(["workspace", "agent", "show"], { cwd: repo, db })).stdout).toContain("Codex（codex）");
  });

  test("不明なエージェントと LLM からの変更は拒む", async () => {
    const { db, repo } = await setupRepo();
    const bad = await runNod(["workspace", "agent", "set", "gemini"], { cwd: repo, db });
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain("claude、codex");
    const llm = await runNod(["workspace", "agent", "set", "codex"], { cwd: repo, db, actor: "claude-code" });
    expect(llm.exitCode).not.toBe(0);
    expect((await runNod(["workspace", "agent", "show", "--json"], { cwd: repo, db })).json.defaultAgent).toBe("claude");
  });
});
