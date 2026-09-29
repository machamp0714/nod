import { expect, test } from "bun:test";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

test("子がすべて完了した親を完了候補として show・list で示し、人だけが既存の経路で完了できる", async () => {
  const db = tempDb();
  const cwd = makeRepo();
  registerRepo(db, cwd, "API");
  const me = (args: string[]) => runNod(args, { cwd, db });
  const llm = (args: string[]) => runNod(args, { cwd, db, actor: "claude-code" });
  const parent = (await me(["issue", "create", "親", "--json"])).json;
  const a = (await me(["issue", "create", "子A", "--parent", parent.id, "--json"])).json;
  const b = (await me(["issue", "create", "子B", "--parent", parent.id, "--json"])).json;
  await me(["issue", "create", "無関係", "--json"]);
  await me(["issue", "update", a.id, "--status", "done"]);

  expect((await me(["issue", "show", parent.id, "--json"])).json.completionCandidate).toBe(false);
  expect((await me(["issue", "show", parent.id])).stdout).not.toContain("完了候補");
  expect((await me(["issue", "list", "--completion-candidates", "--json"])).json).toEqual([]);

  await me(["issue", "update", b.id, "--status", "canceled"]);
  expect((await me(["issue", "show", parent.id, "--json"])).json.completionCandidate).toBe(true);
  const shown = (await me(["issue", "show", parent.id])).stdout;
  expect(shown).toContain("完了候補: Sub-issue がすべて完了しています（完了 1・キャンセル 1）");
  expect(shown).toContain(`nod issue update ${parent.id} --status done`);
  expect((await me(["issue", "list", "--completion-candidates", "--json"])).json.map((i: { id: string }) => i.id)).toEqual([parent.id]);
  expect((await me(["issue", "list", "--completion-candidates"])).stdout).toContain(`${parent.id}  `);
  expect((await me(["issue", "list"])).stdout).toContain("[完了候補]");

  const denied = await llm(["issue", "update", parent.id, "--status", "done", "--json"]);
  expect(denied.exitCode).toBe(1);
  expect(denied.json.error.code).toBe("FORBIDDEN_FOR_LLM");
  expect((await llm(["issue", "list", "--completion-candidates", "--json"])).json.map((i: { id: string }) => i.id)).toEqual([parent.id]);

  await me(["issue", "update", parent.id, "--status", "in_review"]);
  expect((await me(["issue", "show", parent.id])).stdout).toContain(`nod review approve ${parent.id}`);
  const approved = await me(["review", "approve", parent.id, "--json"]);
  expect(approved.json).toMatchObject({ status: "done", completionCandidate: false });
  expect((await me(["issue", "list", "--completion-candidates", "--json"])).json).toEqual([]);
});
