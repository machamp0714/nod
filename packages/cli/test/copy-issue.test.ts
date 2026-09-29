import { expect, test } from "bun:test";
import { openDb } from "@nod/core";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

test("nod issue copy は新しい ID の Issue を作り、元の Issue を変えない", async () => {
  const db = tempDb();
  const cwd = makeRepo();
  registerRepo(db, cwd, "API");
  const me = (args: string[]) => runNod(args, { cwd, db });
  const src = (await me(["issue", "create", "元の Issue", "-d", "説明", "-p", "2", "-l", "a", "-l", "b", "--json"])).json;
  await me(["issue", "update", src.id, "--assignee", "codex"]);
  const before = (await me(["issue", "show", src.id, "--json"])).json;

  const human = await me(["issue", "copy", src.id]);
  expect(human.exitCode).toBe(0);
  expect(human.stdout).toContain(`${src.id} から複製しました: API-2`);

  const json = await me(["issue", "copy", src.id.toLowerCase(), "--title", "別名", "--json"]);
  expect(json.exitCode).toBe(0);
  expect(json.json).toMatchObject({ id: "API-3", title: "別名", description: "説明", priority: 2, labels: ["a", "b"], status: "todo", assignee: null });

  const byLlm = await runNod(["issue", "copy", src.id, "--json"], { cwd, db, actor: "claude-code" });
  expect(byLlm.json).toMatchObject({ id: "API-4", status: "triage", createdBy: "claude-code" });

  expect((await me(["issue", "show", src.id, "--json"])).json).toEqual(before);
});

test("存在しない ID や空のタイトルでは失敗し、何も作らない", async () => {
  const db = tempDb();
  const cwd = makeRepo();
  registerRepo(db, cwd, "API");
  const src = (await runNod(["issue", "create", "元", "--json"], { cwd, db })).json;
  const connection = openDb(db);
  const before = connection.serialize();
  for (const [args, code] of [
    [["issue", "copy", "API-999", "--json"], "NOT_FOUND"],
    [["issue", "copy", "bad", "--json"], "INVALID_ARGS"],
    [["issue", "copy", src.id, "--title", "", "--json"], "INVALID_ARGS"],
  ] as const) {
    const r = await runNod([...args], { cwd, db });
    expect(r.exitCode).toBe(1);
    expect(r.json.error.code).toBe(code);
  }
  expect(connection.serialize()).toEqual(before);
  connection.close();
  const help = await runNod(["issue", "copy", "--help"], { cwd, db });
  expect(help.stdout).toContain("タイトル・説明・Project・ラベル・優先度");
});
