import { describe, expect, test } from "bun:test";
import { makeRepo, runNod, tempDb } from "./helpers";

async function setupRepo() {
  const db = tempDb();
  const repo = makeRepo("api-server");
  await runNod(["init"], { cwd: repo, db });
  return { db, repo };
}

describe("nod workspace transitions（#73）", () => {
  test("show・set・reset ができ、set は全体を置き換える", async () => {
    const { db, repo } = await setupRepo();
    expect((await runNod(["workspace", "transitions", "show", "--json"], { cwd: repo, db })).json).toEqual({
      workspaceKey: "API",
      forbidden: [],
      presets: [],
    });
    expect((await runNod(["workspace", "transitions", "show"], { cwd: repo, db })).stdout).toContain("遷移ルールはありません");
    const set = await runNod(
      ["workspace", "transitions", "set", "--forbid", "backlog:done", "--forbid", "todo:in_review", "--preset", "review_before_done", "--json"],
      { cwd: repo, db },
    );
    expect(set.exitCode).toBe(0);
    expect(set.json).toEqual({
      workspaceKey: "API",
      forbidden: [
        { from: "backlog", to: "done" },
        { from: "todo", to: "in_review" },
      ],
      presets: ["review_before_done"],
    });
    const shown = (await runNod(["workspace", "transitions", "show"], { cwd: repo, db })).stdout;
    expect(shown).toContain("done の前に in_review 必須");
    expect(shown).toContain("禁止 backlog → done");
    await runNod(["workspace", "transitions", "set", "--forbid", "todo:done"], { cwd: repo, db });
    expect((await runNod(["workspace", "transitions", "show", "--json"], { cwd: repo, db })).json.forbidden).toEqual([{ from: "todo", to: "done" }]);
    await runNod(["workspace", "transitions", "reset"], { cwd: repo, db });
    expect((await runNod(["workspace", "transitions", "show", "--json"], { cwd: repo, db })).json.forbidden).toEqual([]);
  });

  test("指定の誤りは INVALID_ARGS", async () => {
    const { db, repo } = await setupRepo();
    for (const args of [[], ["--forbid", "backlog-done"], ["--forbid", "in_review:done"], ["--preset", "nope"]]) {
      const r = await runNod(["workspace", "transitions", "set", ...args, "--json"], { cwd: repo, db });
      expect(r.exitCode).not.toBe(0);
      expect(r.json.error.code).toBe("INVALID_ARGS");
    }
  });

  test("LLM は set・reset できず FORBIDDEN_FOR_LLM、show はできる", async () => {
    const { db, repo } = await setupRepo();
    await runNod(["workspace", "transitions", "set", "--forbid", "backlog:done"], { cwd: repo, db });
    const set = await runNod(["workspace", "transitions", "set", "--forbid", "todo:done", "--json"], { cwd: repo, db, actor: "claude-code" });
    expect(set.json.error.code).toBe("FORBIDDEN_FOR_LLM");
    const reset = await runNod(["workspace", "transitions", "reset", "--json"], { cwd: repo, db, actor: "codex" });
    expect(reset.json.error.code).toBe("FORBIDDEN_FOR_LLM");
    const shown = await runNod(["workspace", "transitions", "show", "--json"], { cwd: repo, db, actor: "claude-code" });
    expect(shown.json.forbidden).toEqual([{ from: "backlog", to: "done" }]);
  });

  test("違反する状態変更は TRANSITION_NOT_ALLOWED で、どのルールかを示す", async () => {
    const { db, repo } = await setupRepo();
    await runNod(["issue", "create", "a"], { cwd: repo, db });
    await runNod(["workspace", "transitions", "set", "--preset", "review_before_done"], { cwd: repo, db });
    const json = await runNod(["issue", "update", "API-1", "--status", "done", "--json"], { cwd: repo, db });
    expect(json.exitCode).not.toBe(0);
    expect(json.json.error.code).toBe("TRANSITION_NOT_ALLOWED");
    const text = await runNod(["issue", "update", "API-1", "--status", "done"], { cwd: repo, db });
    expect(text.stderr).toContain("Todo → Done は許可されていません（ルール: done の前に in_review 必須）");
  });
});

describe("LLM 向けの出力に遷移ルールを添える（#73）", () => {
  test("設定済みなら skills get・issue show に節と JSON を添え、未設定なら従来どおり", async () => {
    const { db, repo } = await setupRepo();
    await runNod(["issue", "create", "a"], { cwd: repo, db });
    const plain = await runNod(["issue", "show", "API-1", "--json"], { cwd: repo, db, actor: "claude-code" });
    expect(plain.json).not.toHaveProperty("transitionRules");
    expect((await runNod(["skills", "get", "nod"], { cwd: repo, db })).stdout).not.toContain("## この Workspace のステータス遷移ルール");

    await runNod(["workspace", "transitions", "set", "--preset", "review_before_done", "--forbid", "backlog:todo"], { cwd: repo, db });
    const show = await runNod(["issue", "show", "API-1"], { cwd: repo, db, actor: "claude-code" });
    expect(show.stdout).toContain("## この Workspace のステータス遷移ルール（API）");
    expect(show.stdout).toContain("- done の前に in_review 必須");
    expect(show.stdout).toContain("- backlog → todo は禁止");
    const json = await runNod(["issue", "show", "API-1", "--json"], { cwd: repo, db, actor: "claude-code" });
    expect(json.json.transitionRules).toEqual({ forbidden: [{ from: "backlog", to: "todo" }], presets: ["review_before_done"] });
    const skills = await runNod(["skills", "get", "nod", "--json"], { cwd: repo, db });
    expect(skills.json.guide).toContain("## この Workspace のステータス遷移ルール（API）");
    expect(skills.json.transitionRules.presets).toEqual(["review_before_done"]);
  });
});
