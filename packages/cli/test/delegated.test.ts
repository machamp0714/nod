import { describe, expect, test } from "bun:test";
import { makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

// API: API-1 を claude-code が着手、API-2 を codex に割り当て、API-3 は私の担当、API-4 は codex で done
// WEB: WEB-1 を codex に割り当てて In Review
async function seed() {
  const db = tempDb();
  const api = makeRepo("api-server");
  const web = makeRepo("web");
  registerRepo(db, api, "API");
  registerRepo(db, web, "WEB");
  const me = (args: string[], cwd = api) => runNod(args, { cwd, db });
  const claude = (args: string[], cwd = api) => runNod(args, { cwd, db, actor: "claude-code" });
  for (const title of ["着手済み", "割り当てだけ", "私の担当", "完了"]) await me(["issue", "create", title]);
  await me(["issue", "create", "レビュー待ち"], web);
  await claude(["issue", "start", "API-1"]);
  await me(["issue", "update", "API-2", "--assignee", "codex"]);
  await me(["issue", "update", "API-3", "--assignee", "me"]);
  await me(["issue", "update", "API-4", "--assignee", "codex", "--status", "done"]);
  await me(["issue", "update", "WEB-1", "--assignee", "codex", "--status", "in_review"]);
  return { db, api, me };
}

describe("nod issue list --delegated", () => {
  test("既定で全 Workspace の委任中 Issue を担当の LLM 順に JSON で返す", async () => {
    const { db, me } = await seed();
    const r = await me(["issue", "list", "--delegated", "--json"], tempDir());
    expect(r.exitCode).toBe(0);
    expect(r.json.map((i: { id: string; assignee: string }) => [i.assignee, i.id])).toEqual([
      ["claude-code", "API-1"],
      ["codex", "API-2"],
      ["codex", "WEB-1"],
    ]);
    const scoped = await runNod(["-w", "WEB", "issue", "list", "--delegated", "--json"], { cwd: tempDir(), db });
    expect(scoped.json.map((i: { id: string }) => i.id)).toEqual(["WEB-1"]);
  });

  test("テキストでは LLM ごとの見出しに件数と作業状況の内訳を付けて束ねる", async () => {
    const { me } = await seed();
    const r = await me(["issue", "list", "--delegated"]);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("claude-code（1件: 作業中 1）");
    expect(lines[1]).toMatch(/^ {2}API-1 {2}In Progress.*\[working\] {2}着手済み$/);
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("codex（2件: 未着手 2）");
    expect(lines[4]).toMatch(/^ {2}API-2 {2}Todo.* {2}割り当てだけ$/);
    expect(lines[5]).toMatch(/^ {2}WEB-1 {2}In Review.* {2}レビュー待ち$/);
    expect(lines).toHaveLength(6);
  });

  test("ほかの条件と組み合わせられ、該当がなければその旨を出す", async () => {
    const { me } = await seed();
    const review = await me(["issue", "list", "--delegated", "--status", "in_review", "--json"]);
    expect(review.json.map((i: { id: string }) => i.id)).toEqual(["WEB-1"]);
    const none = await me(["issue", "list", "--delegated", "--query", "該当なし"]);
    expect(none.stdout.trim()).toBe("LLM に委任中の Issue はありません");
  });
});
