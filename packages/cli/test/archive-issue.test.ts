import { expect, test } from "bun:test";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

test("nod issue archive / unarchive で既定の一覧から外し、--archived で確認して戻せる", async () => {
  const db = tempDb();
  const cwd = makeRepo();
  registerRepo(db, cwd, "API");
  const me = (args: string[]) => runNod(args, { cwd, db });
  const keep = (await me(["issue", "create", "残す", "--json"])).json;
  const gone = (await me(["issue", "create", "消す", "--json"])).json;

  const archived = await me(["issue", "archive", gone.id, "--reason", "不要"]);
  expect(archived.exitCode).toBe(0);
  expect(archived.stdout).toContain(`${gone.id} をアーカイブしました`);
  expect((await me(["issue", "list", "--json"])).json.map((i: { id: string }) => i.id)).toEqual([keep.id]);
  const list = await me(["issue", "list", "--archived", "--json"]);
  expect(list.json.map((i: { id: string }) => i.id)).toEqual([gone.id]);
  expect(list.json[0].archivedAt).not.toBeNull();

  const blocked = await me(["issue", "comment", gone.id, "メモ", "--json"]);
  expect(blocked.exitCode).toBe(1);
  expect(blocked.json.error.code).toBe("ISSUE_ARCHIVED");

  const restored = await me(["issue", "unarchive", gone.id, "--json"]);
  expect(restored.json).toMatchObject({ id: gone.id, archivedAt: null, status: "todo" });
  expect((await me(["issue", "list", "--json"])).json.map((i: { id: string }) => i.id)).toEqual([keep.id, gone.id]);
});

test("LLM はアーカイブも復元もできない", async () => {
  const db = tempDb();
  const cwd = makeRepo();
  registerRepo(db, cwd, "API");
  const issue = (await runNod(["issue", "create", "x", "--json"], { cwd, db })).json;
  const r = await runNod(["issue", "archive", issue.id, "--json"], { cwd, db, actor: "claude-code" });
  expect(r.exitCode).toBe(1);
  expect(r.json.error.code).toBe("FORBIDDEN_FOR_LLM");
  await runNod(["issue", "archive", issue.id], { cwd, db });
  const u = await runNod(["issue", "unarchive", issue.id, "--json"], { cwd, db, actor: "claude-code" });
  expect(u.json.error.code).toBe("FORBIDDEN_FOR_LLM");
});
