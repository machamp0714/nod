import { expect, test } from "bun:test";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

test("一覧の --assignee と --mine は値に関係なく担当の廃止を伝える", async () => {
  const db = tempDb(), cwd = makeRepo();
  registerRepo(db, cwd);
  await runNod(["issue", "create", "対象"], { cwd, db });
  for (const flag of ["--assignee", "--mine"]) {
    for (const option of [[flag], [flag, ""], [flag, "none"], [flag, "false"], [`${flag}=false`], [`${flag}=`]]) {
      const result = await runNod(["issue", "list", ...option, "--json"], { cwd, db });
      expect(result.exitCode).toBe(1);
      expect(result.json.error).toMatchObject({ code: "INVALID_ARGS" });
      expect(result.json.error.message).toContain("担当は廃止");
    }
  }
});
