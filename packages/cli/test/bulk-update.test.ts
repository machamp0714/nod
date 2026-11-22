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

test("Issue の詳細と一覧に担当フィールドを表示しない", async () => {
  const title = "詳細と一覧で確認する Issue";
  const id = await create(title);
  for (const args of [["show", id], ["list"]]) {
    const result = await me(["issue", ...args]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(title);
    expect(result.stdout).not.toContain("担当");
  }
  expect((await me(["issue", "show", id, "--json"])).json).not.toHaveProperty("assignee");
});

describe("nod issue bulk-update", () => {
  test("単体と一括の更新で廃止済みの --assignee を拒否し、他の項目も変えない", async () => {
    const id = await create("担当の指定を拒否");
    for (const command of ["update", "bulk-update"]) {
      for (const option of [["--assignee", "codex"], ["--assignee="], ["--assignee"]]) {
        const r = await me(["issue", command, id, "--json", "-p", "1", ...option]);
        expect(r.exitCode).toBe(1);
        expect(r.json.error).toMatchObject({ code: "INVALID_ARGS", message: "担当は廃止されました。--assignee は使えません" });
      }
    }
    expect((await me(["issue", "show", id, "--json"])).json.priority).toBe(0);
  });

  test("複数 Issue の状態・優先度・ラベル・見積もり・期限をまとめて変える", async () => {
    const a = await create("一括A");
    const b = await create("一括B");
    const r = await me(["issue", "bulk-update", a, b, "--json", "-s", "in_progress", "-p", "2", "--estimate", "3", "--due", "2026-10-01", "--add-label", "bulk"]);
    expect(r.exitCode).toBe(0);
    expect(r.json).toHaveLength(2);
    for (const issue of r.json) {
      expect(issue).toMatchObject({ status: "in_progress", priority: 2, estimate: 3, dueDate: "2026-10-01", labels: ["bulk"] });
    }
    const text = await me(["issue", "bulk-update", a, b, "--estimate", ""]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("2 件を更新しました");
    expect((await me(["issue", "show", a, "--json"])).json.estimate).toBeNull();
  });

  test("LLM も一括で done にできる", async () => {
    const a = await create("LLM一括A");
    const b = await create("LLM一括B");
    const r = await llm(["issue", "bulk-update", a, b, "--json", "-s", "done", "-p", "1"]);
    expect(r.exitCode).toBe(0);
    expect((await me(["issue", "show", a, "--json"])).json).toMatchObject({ status: "done", priority: 1 });
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
