import { describe, expect, test } from "bun:test";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

describe("CLI の書き手の記録", () => {
  const cases: { name: string; env: Record<string, string>; actor: string }[] = [
    {
      name: "NOD_ACTOR をすべての自動判定より優先する",
      env: { NOD_ACTOR: "custom-agent", OMPCODE: "1", CLAUDECODE: "1", CODEX_THREAD_ID: "test-thread" },
      actor: "custom-agent",
    },
    {
      name: "omp を Claude Code と Codex より優先する",
      env: { OMPCODE: "1", CLAUDECODE: "1", CODEX_THREAD_ID: "test-thread" },
      actor: "omp",
    },
    {
      name: "Claude Code を Codex より優先する",
      env: { CLAUDECODE: "1", CODEX_THREAD_ID: "test-thread" },
      actor: "claude-code",
    },
    {
      name: "Codex のスレッドがあれば codex と記録する",
      env: { CODEX_THREAD_ID: "test-thread" },
      actor: "codex",
    },
    {
      name: "識別変数が未設定でも起票でき me と記録する",
      env: {},
      actor: "me",
    },
    {
      name: "空の明示値や 1 以外のフラグでは自動判定しない",
      env: { NOD_ACTOR: "", OMPCODE: "0", CLAUDECODE: "true", CODEX_THREAD_ID: "" },
      actor: "me",
    },
  ];

  for (const { name, env, actor } of cases) {
    test(name, async () => {
      const db = tempDb();
      const repo = makeRepo();
      registerRepo(db, repo, "API");
      const opts = { cwd: repo, db, env };
      const created = await runNod(["issue", "create", name, "--json"], opts);
      expect(created.exitCode).toBe(0);

      const shown = await runNod(["issue", "show", created.json.id, "--json"], opts);
      expect(shown.exitCode).toBe(0);
      expect(shown.json.createdBy).toBe(actor);
      expect(shown.json.activity).toContainEqual(expect.objectContaining({ type: "created", actor }));
    });
  }
});
