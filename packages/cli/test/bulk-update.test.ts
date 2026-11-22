import { beforeAll, describe, expect, test } from "bun:test";
import { createIssue, listWorkspaces, openDb } from "@nod/core";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

let db: string;
let repo: string;
beforeAll(() => {
  db = tempDb();
  repo = makeRepo();
  registerRepo(db, repo);
});

test("保存済みの担当があっても詳細と一覧のテキストに表示しない", async () => {
  const legacyDb = tempDb();
  const legacyRepo = makeRepo();
  registerRepo(legacyDb, legacyRepo);
  const legacy = openDb(legacyDb);
  const workspace = listWorkspaces(legacy)[0]!;
  const issue = createIssue({ db: legacy, actor: "me" }, {
    workspaceId: workspace.id, title: "旧データの表示",
  });
  legacy.query("UPDATE issues SET assignee = ? WHERE workspace_id = ? AND number = ?").run("legacy-agent", workspace.id, issue.number);
  legacy.close();
  for (const args of [["show", issue.id], ["list"]]) {
    const r = await runNod(["issue", ...args], { cwd: legacyRepo, db: legacyDb });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(issue.title);
    expect(r.stdout).not.toContain("legacy-agent");
  }
});

const llm = (args: string[]) => runNod(args, { cwd: repo, db, actor: "claude-code" });
const me = (args: string[]) => runNod(args, { cwd: repo, db });
const create = async (title: string, run = me) => (await run(["issue", "create", "--json", title])).json.id as string;

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
