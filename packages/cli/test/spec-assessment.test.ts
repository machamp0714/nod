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

test("CLIで失敗表示から人間・LLMの明示再試行と着手へ進める", async () => {
  const db = tempDb();
  const repo = makeRepo();
  const opts = { cwd: repo, db, env: { TYPESAFE_API_KEY: "" } };
  await runNod(["init"], opts);
  await runNod(["workspace", "spec-assessment", "set", "on"], opts);
  await runNod(["issue", "create", "再試行", "--json"], opts);
  const failed = await runNod(["issue", "assess", "API-1", "--json"], { ...opts, actor: "codex" });
  expect(failed.json.specAssessment).toMatchObject({ status: "failed", failureKind: "missing_key", generation: 2 });
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const preload = join(repo, "fake-jev.ts");
  writeFileSync(preload, 'globalThis.fetch = async () => Response.json({model:"jev-1.13.0", answers:{needs_spec:{type:"noul",noul:0}},usage:{input_tokens:2}});');
  const fake = { cwd: repo, db, env: { TYPESAFE_API_KEY: "test-key", BUN_OPTIONS: "--preload=" + preload } };
  const recovered = await runNod(["issue", "assess", "API-1", "--json"], fake);
  expect(recovered.stderr).toBe("");
  expect(recovered.json.specAssessment).toMatchObject({ status: "completed", probability: 0, generation: 3 });
  expect((await runNod(["issue", "start", "API-1", "--json"], { ...fake, actor: "codex" })).exitCode).toBe(0);
});
