import { expect, test } from "bun:test";
import { makeRepo, runNod, tempDb } from "./helpers";

test("init/list/removeのJSONが保存色を維持し、通常一覧は既存形式を保つ", async () => {
  const db = tempDb();
  const repo = makeRepo("api-server");
  const opts = { db, cwd: repo, actor: "codex" };
  const first = await runNod(["init", "--json"], opts);
  expect(first.exitCode).toBe(0);
  const workspace = first.json.workspace;
  expect(workspace.color).toMatch(/^#[0-9A-F]{6}$/);
  const again = await runNod(["init", "--json"], opts);
  expect(again.json).toEqual({ created: false, workspace });
  expect((await runNod(["workspace", "list", "--json"], opts)).json).toEqual([workspace]);
  expect((await runNod(["workspace", "list"], opts)).stdout.trim()).toBe(`API  api-server  ${repo}`);
  const removed = await runNod(["workspace", "remove", "API", "--yes", "--json"], opts);
  expect(removed.json.workspace).toEqual(workspace);
  expect((await runNod(["init", "--json"], opts)).json.workspace.color).toBe(workspace.color);
});
