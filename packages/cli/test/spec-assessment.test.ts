import { expect, test } from "bun:test";
import { makeRepo, runNod, tempDb } from "./helpers";

test("CLIで設定して起票し、キー不足でも作成IDと安全な失敗を確認できる", async () => {
  const db = tempDb();
  const repo = makeRepo();
  const opts = { cwd: repo, db, env: { TYPESAFE_API_KEY: "" } };
  await runNod(["init"], opts);
  expect((await runNod(["workspace", "spec-assessment", "show", "--json"], opts)).json.enabled).toBe(false);
  expect((await runNod(["workspace", "spec-assessment", "set", "on", "--json"], opts)).json.enabled).toBe(true);
  const created = await runNod(["issue", "create", "保存", "-d", "本文", "--json"], opts);
  expect(created.exitCode).toBe(0);
  expect(created.json).toMatchObject({ id: "API-1", specAssessment: { status: "failed", failureKind: "missing_key" } });
  const shown = await runNod(["issue", "show", "API-1"], opts);
  expect(shown.stdout).toContain("missing_key");
  expect((await runNod(["issue", "start", "API-1"], opts)).exitCode).not.toBe(0);
  expect((await runNod(["workspace", "spec-assessment", "set", "off"], { ...opts, actor: "codex" })).exitCode).not.toBe(0);
});
