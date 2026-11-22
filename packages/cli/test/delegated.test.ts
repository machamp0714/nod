import { expect, test } from "bun:test";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

test("廃止した委任中の条件は無視せず、担当の廃止を伝えるエラーを返す", async () => {
  const db = tempDb(), cwd = makeRepo();
  registerRepo(db, cwd);
  await runNod(["issue", "create", "対象"], { cwd, db });
  const result = await runNod(["issue", "list", "--delegated", "--json"], { cwd, db });
  expect(result.exitCode).toBe(1);
  expect(result.json.error).toMatchObject({ code: "INVALID_ARGS" });
  expect(result.json.error.message).toContain("担当は廃止");
});
