import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cancelSprint, configureScrumWorkspace, createSprint, initWorkspace, listSprintRecords, openDb, type AddSprintRecordInput } from "@nod/core";
import { makeRepo, runNod, tempDb, tempDir } from "./helpers";

function fixture() {
  const cwd = makeRepo(), db = tempDb(), inputDir = tempDir();
  const d = openDb(db);
  try {
    const workspace = initWorkspace(d, { path: cwd }).workspace;
    const ctx = { db: d, actor: "me" };
    configureScrumWorkspace(ctx, workspace.key, {
      enabled: true, problem: "感想が未記録", productGoal: "感想を集める", priorityRationale: "書き手を保持する",
      expectedVersion: 0, requestKey: "設定",
    });
    const draft = createSprint(ctx, {
      workspaceKey: workspace.key, startDate: "2026-03-08", endDate: "2026-03-08", timezone: "Asia/Tokyo",
      expectedVersion: 0, requestKey: "作成",
    });
    const sprint = cancelSprint(ctx, draft.id, { expectedVersion: draft.version, requestKey: "中止", reason: "感想を集める" });
    return { cwd, db, inputDir, sprint };
  } finally { d.close(); }
}

function records(db: string, sprint: string) {
  const d = openDb(db);
  try { return listSprintRecords(d, sprint); }
  finally { d.close(); }
}

for (const actor of ["codex", "me", "claude-code", "omp"]) {
  for (const source of ["file", "stdin"] as const) {
    test(`CLIは${source}から感想を追加し、実際の書き手${actor}と内容を保存・再取得できる`, async () => {
      const f = fixture();
      const input: AddSprintRecordInput = {
        kind: "feedback", requestKey: "感想", content: { helpful: "判断を早く確認できた", difficulties: "入口が分かりづらい", requests: "説明を増やす" },
      };
      let result: { exitCode: number; json: unknown };
      if (source === "file") {
        const file = join(f.inputDir, "feedback.json");
        writeFileSync(file, JSON.stringify(input));
        result = await runNod(["sprint", "record", "add", String(f.sprint.number), "--input", file, "--json"], { ...f, actor });
      } else {
        const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/main.ts"), "sprint", "record", "add", f.sprint.id, "--input", "-", "--json"], {
          cwd: f.cwd, env: { ...process.env, NOD_DB: f.db, NOD_ACTOR: actor, NOD_ORCA: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
        });
        proc.stdin.write(JSON.stringify(input));
        proc.stdin.end();
        const [stdout, , exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        result = { exitCode, json: JSON.parse(stdout) };
      }
      expect(result).toMatchObject({ exitCode: 0, json: { sprintId: f.sprint.id, kind: "feedback", recordedBy: actor, content: input.content, correctsRecordId: null } });
      expect([result.json]).toEqual(records(f.db, f.sprint.id));
    });
  }
}

test("CLIは記録の再送・衝突・訂正と不正入力の既存契約を維持する", async () => {
  const f = fixture(), file = join(f.inputDir, "record.json");
  const run = async (input: unknown) => {
    writeFileSync(file, JSON.stringify(input));
    return runNod(["sprint", "record", "add", f.sprint.id, "--input", file, "--json"], { ...f, actor: "codex" });
  };
  const input: AddSprintRecordInput = { kind: "feedback", requestKey: "感想", content: { helpful: "助かった" } };
  const first = await run(input);
  expect(first.exitCode).toBe(0);
  expect(await run(input)).toMatchObject({ exitCode: 0, json: first.json });
  expect(await run({ ...input, content: { helpful: "違う内容" } })).toMatchObject({ exitCode: 1, json: { error: { code: "IDEMPOTENCY_CONFLICT" } } });
  for (const invalid of [
    { ...input, requestKey: "空の感想", content: {} },
    { ...input, requestKey: "不正な項目", content: { helpful: "感想", recordedBy: "me" } },
    { ...input, requestKey: "書き手の偽装", recordedBy: "me" },
    { ...input, requestKey: "訂正元なし", correctsRecordId: "missing" },
    { ...input, requestKey: "不正な種類", kind: "unknown" },
    { kind: "feedback", content: { helpful: "要求キーなし" } },
  ]) {
    expect(await run(invalid)).toMatchObject({ exitCode: 1, json: { error: { code: "INVALID_ARGS" } } });
  }
  writeFileSync(file, "{");
  expect(await runNod(["sprint", "record", "add", f.sprint.id, "--input", file, "--json"], { ...f, actor: "codex" })).toMatchObject({ exitCode: 1, json: { error: { code: "INVALID_ARGS" } } });
  expect(records(f.db, f.sprint.id)).toEqual([first.json]);
  const corrected = await run({ ...input, requestKey: "訂正", correctsRecordId: first.json.id, content: { requests: "次も続けたい" } });
  expect(corrected).toMatchObject({ exitCode: 0, json: { recordedBy: "codex", correctsRecordId: first.json.id, content: { helpful: "", difficulties: "", requests: "次も続けたい" } } });
  expect(records(f.db, f.sprint.id)).toEqual([first.json, corrected.json]);
});

test("CLIのrecord addは感想専用にせず、成果と振り返りも既存モデルで記録する", async () => {
  const f = fixture(), file = join(f.inputDir, "record.json");
  const saved = [];
  for (const input of [
    { kind: "outcome", requestKey: "成果", content: { summary: "入力経路を追加" } },
    { kind: "retrospective", requestKey: "振り返り", content: { nextActions: "入口を案内する" } },
  ]) {
    writeFileSync(file, JSON.stringify(input));
    const result = await runNod(["sprint", "record", "add", f.sprint.id, "--input", file, "--json"], { ...f, actor: "omp" });
    expect(result).toMatchObject({ exitCode: 0, json: { kind: input.kind, recordedBy: "omp", content: input.content } });
    saved.push(result.json);
  }
  expect(records(f.db, f.sprint.id)).toEqual(saved);
});
