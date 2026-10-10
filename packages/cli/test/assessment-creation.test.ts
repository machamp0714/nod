import { expect, test } from "bun:test";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

test("CLIの複製・定期・自動化は判定失敗でも作成済みIDと状態を確認できる", async () => {
  const db = tempDb(), cwd = makeRepo();
  registerRepo(db, cwd, "API");
  const run = (args: string[]) => runNod([...args, "--json"], { cwd, db, env: { TYPESAFE_API_KEY: "" } });
  const source = await run(["issue", "create", "元"]);
  expect((await run(["workspace", "spec-assessment", "set", "on"])).exitCode).toBe(0);
  const copied = await run(["issue", "copy", source.json.id]);
  expect(copied.exitCode).toBe(0);
  expect(copied.json.specAssessment).toMatchObject({ status: "failed", failureKind: "missing_key" });
  for (const command of ["recurring", "automation"]) {
    expect((await run(["recurring", "add", command, "--every", "daily", "--start", "2026-01-01", "--tz", "UTC"])).exitCode).toBe(0);
    const result = await run([command, "run"]);
    expect(result.exitCode).toBe(0);
    const id = command === "recurring" ? result.json.items[0].issueId : result.json.recurring.items[0].issueId;
    const shown = await run(["issue", "show", id]);
    expect(shown.json.specAssessment).toMatchObject({ status: "failed", failureKind: "missing_key" });
  }
});
