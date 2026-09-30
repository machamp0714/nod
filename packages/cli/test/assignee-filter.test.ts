import { describe, expect, test } from "bun:test";
import { makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

// API: API-1 を claude-code が着手、API-2 を codex に割り当て、API-3 は私の担当、API-4 は担当なし、API-5 は私の担当で done
// WEB: WEB-1 は私の担当、WEB-2 は claude-code に割り当て
async function seed() {
  const db = tempDb();
  const api = makeRepo("api-server");
  const web = makeRepo("web");
  registerRepo(db, api, "API");
  registerRepo(db, web, "WEB");
  const me = (args: string[], cwd = api) => runNod(args, { cwd, db });
  const claude = (args: string[], cwd = api) => runNod(args, { cwd, db, actor: "claude-code" });
  for (const title of ["着手済み", "割り当てだけ", "私の担当", "担当なし", "完了"]) await me(["issue", "create", title]);
  for (const title of ["別 Workspace の私の担当", "別 Workspace の委任"]) await me(["issue", "create", title], web);
  await claude(["issue", "start", "API-1"]);
  await me(["issue", "update", "API-2", "--assignee", "codex"]);
  await me(["issue", "update", "API-3", "--assignee", "me"]);
  await me(["issue", "update", "API-5", "--assignee", "me", "--status", "done"]);
  await me(["issue", "update", "WEB-1", "--assignee", "me"], web);
  await me(["issue", "update", "WEB-2", "--assignee", "claude-code"], web);
  return { db, api, web, me, claude };
}

const idsOf = (r: { json: { id: string }[] }) => r.json.map((i) => i.id);

describe("nod issue list --assignee", () => {
  test("今の Workspace の Issue を担当で絞り、繰り返しとカンマ区切りはどれかに合うものを返す", async () => {
    const { me } = await seed();
    expect(idsOf(await me(["issue", "list", "--assignee", "me", "--json"]))).toEqual(["API-3"]);
    expect(idsOf(await me(["issue", "list", "--assignee", "codex", "--assignee", "claude-code", "--json"]))).toEqual(["API-1", "API-2"]);
    expect(idsOf(await me(["issue", "list", "--assignee", "codex,me", "--json"]))).toEqual(["API-2", "API-3"]);
    expect(idsOf(await me(["issue", "list", "--assignee", "me", "--all-workspaces", "--json"]))).toEqual(["API-3", "WEB-1"]);
  });

  test("none は未割り当てを指し、ほかの条件と組み合わせられる", async () => {
    const { me } = await seed();
    expect(idsOf(await me(["issue", "list", "--assignee", "none", "--json"]))).toEqual(["API-4"]);
    expect(idsOf(await me(["issue", "list", "--assignee", "me", "--status", "done,todo", "--json"]))).toEqual(["API-3", "API-5"]);
    const none = await me(["issue", "list", "--assignee", "nobody"]);
    expect(none.exitCode).toBe(0);
    expect(none.stdout.trim()).toBe("Issue はありません");
  });

  test("空の --assignee は INVALID_ARGS", async () => {
    const { me } = await seed();
    const r = await me(["issue", "list", "--assignee", " , ", "--json"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.json.error.code).toBe("INVALID_ARGS");
  });
});

describe("nod issue list --mine", () => {
  test("人は既定で全 Workspace の自分（me）の担当を返し、-w で絞れる", async () => {
    const { db, me } = await seed();
    expect(idsOf(await me(["issue", "list", "--mine", "--json"], tempDir()))).toEqual(["API-3", "WEB-1"]);
    const scoped = await runNod(["-w", "WEB", "issue", "list", "--mine", "--json"], { cwd: tempDir(), db });
    expect(idsOf(scoped)).toEqual(["WEB-1"]);
    expect(idsOf(await me(["issue", "list", "--mine", "--status", "done", "--json"]))).toEqual(["API-5"]);
  });

  test("LLM は自分の名前の担当を返す", async () => {
    const { claude } = await seed();
    const r = await claude(["issue", "list", "--mine", "--json"]);
    expect(r.exitCode).toBe(0);
    expect(r.json.map((i: { id: string; assignee: string }) => [i.id, i.assignee])).toEqual([
      ["API-1", "claude-code"],
      ["WEB-2", "claude-code"],
    ]);
  });

  test("--assignee と併せると、どちらかに合うものを返す", async () => {
    const { me } = await seed();
    expect(idsOf(await me(["issue", "list", "--mine", "--assignee", "codex", "--json"]))).toEqual(["API-2", "API-3", "WEB-1"]);
  });
});
