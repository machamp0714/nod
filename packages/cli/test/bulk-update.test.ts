import { beforeAll, describe, expect, test } from "bun:test";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

let db: string;
let repo: string;
beforeAll(() => {
  db = tempDb();
  repo = makeRepo();
  registerRepo(db, repo);
});

const llm = (args: string[]) => runNod(args, { cwd: repo, db, actor: "claude-code" });
const me = (args: string[]) => runNod(args, { cwd: repo, db });
const create = async (title: string, run = me) => (await run(["issue", "create", "--json", title])).json.id as string;

describe("nod issue bulk-update", () => {
  test("複数 Issue の状態・優先度・担当・ラベル・見積もり・期限をまとめて変える", async () => {
    const a = await create("一括A");
    const b = await create("一括B");
    const r = await me(["issue", "bulk-update", a, b, "--json", "-s", "in_progress", "-p", "2", "--assignee", "codex", "--estimate", "3", "--due", "2026-10-01", "--add-label", "bulk"]);
    expect(r.exitCode).toBe(0);
    expect(r.json).toHaveLength(2);
    for (const issue of r.json) {
      expect(issue).toMatchObject({ status: "in_progress", priority: 2, assignee: "codex", estimate: 3, dueDate: "2026-10-01", labels: ["bulk"] });
    }
    const text = await me(["issue", "bulk-update", a, b, "--assignee", "", "--estimate", ""]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("2 件を更新しました");
    expect((await me(["issue", "show", a, "--json"])).json).toMatchObject({ assignee: null, estimate: null });
  });

  test("LLM は done にできず、1件も変えずに終了コード 1 と失敗一覧を返す", async () => {
    const a = await create("LLM一括A");
    const b = await create("LLM一括B");
    const r = await llm(["issue", "bulk-update", a, b, "--json", "-s", "done", "-p", "1"]);
    expect(r.exitCode).toBe(1);
    expect(r.json.error.code).toBe("BULK_UPDATE_FAILED");
    expect(r.json.error.details.failures.map((f: { id: string; code: string }) => [f.id, f.code])).toEqual([
      [a, "FORBIDDEN_FOR_LLM"],
      [b, "FORBIDDEN_FOR_LLM"],
    ]);
    expect((await me(["issue", "show", a, "--json"])).json.priority).toBe(0);
  });

  test("Triage の Issue の状態は変えられず、理由をテキストでも示す", async () => {
    const t = await create("Triage一括", llm);
    const r = await me(["issue", "bulk-update", t, "-s", "todo"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("BULK_UPDATE_FAILED");
    expect(r.stderr).toContain(`${t}:`);
    expect((await me(["issue", "show", t, "--json"])).json.status).toBe("triage");
  });

  test("変更項目がなければ INVALID_ARGS", async () => {
    const a = await create("変更なし");
    const r = await me(["issue", "bulk-update", a, "--json"]);
    expect(r.exitCode).toBe(1);
    expect(r.json.error.code).toBe("INVALID_ARGS");
  });
});
