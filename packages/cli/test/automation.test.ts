import { expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "@nod/core";
import { makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

// 正午にして、どの TZ で流しても暦日が 2020-01-01 になるようにする
const old = "2020-01-01T12:00:00Z";

function fixture() {
  const db = tempDb(), cwd = makeRepo();
  registerRepo(db, cwd);
  return { db, cwd, opts: { cwd, db } };
}

// status と時刻を古くして、自動化の対象にする
function age(db: string, id: string, status: string): void {
  const c = openDb(db);
  const number = Number(id.split("-")[1]);
  const closedAt = status === "done" || status === "canceled" ? old : null;
  c.query("UPDATE issues SET status=?, created_at=?, updated_at=?, closed_at=? WHERE number=?").run(status, old, old, closedAt, number);
  c.exec(`UPDATE events SET created_at='${old}'`);
  c.close();
}

test("show・set で設定し、off で無効にし、JSON でも返す", async () => {
  const { opts } = fixture();
  expect((await runNod(["automation", "show"], opts)).stdout).toContain("自動クローズ: 無効");
  const set = await runNod(["automation", "set", "--close-after-days", "90", "--archive-after-days", "14", "--json"], opts);
  expect(set.exitCode).toBe(0);
  expect(set.json).toMatchObject({ closeAfterDays: 90, archiveAfterDays: 14, updatedBy: "me" });
  await runNod(["automation", "set", "--archive-after-days", "off"], opts);
  const shown = await runNod(["automation", "show"], opts);
  expect(shown.stdout).toContain("90日間更新のない");
  expect(shown.stdout).toContain("自動アーカイブ: 無効");
});

test("set は日数の不正・未指定を拒み、LLM からの変更を拒む", async () => {
  const { opts } = fixture();
  for (const args of [[], ["--close-after-days", "0"], ["--close-after-days", "abc"], ["--archive-after-days", "3651"], ["--close-after-days", "1.5"]]) {
    const r = await runNod(["automation", "set", ...args, "--json"], opts);
    expect(r.exitCode).toBe(1);
    expect(r.json.error.code).toBe("INVALID_ARGS");
  }
  const llm = await runNod(["automation", "set", "--close-after-days", "30", "--json"], { ...opts, actor: "codex" });
  expect(llm.json.error.code).toBe("FORBIDDEN_FOR_LLM");
});

test("run --dry-run は対象を表示するだけ、run で canceled・アーカイブし、2回目は0件", async () => {
  const { db, opts } = fixture();
  await runNod(["automation", "set", "--close-after-days", "30", "--archive-after-days", "30"], opts);
  const open = (await runNod(["issue", "create", "放置", "--json"], opts)).json.id;
  const done = (await runNod(["issue", "create", "完了済み", "--json"], opts)).json.id;
  age(db, open, "todo");
  age(db, done, "done");
  const dry = await runNod(["automation", "run", "--dry-run"], opts);
  expect(dry.exitCode).toBe(0);
  expect(dry.stdout).toContain(`${open}  todo  最終活動 2020-01-01`);
  expect(dry.stdout).toContain(`${done}  done  完了 2020-01-01`);
  expect(dry.stdout).toContain("dry-run のため変更していません");
  const dryJson = await runNod(["automation", "run", "--dry-run", "--json"], { ...opts, actor: "codex" });
  expect(dryJson.json).toMatchObject({ dryRun: true, rules: [{ kind: "auto_close", total: 1 }, { kind: "auto_archive", total: 1 }, { kind: "pr_review", enabled: false }] });
  expect((await runNod(["issue", "show", open, "--json"], opts)).json.status).toBe("todo");

  const llm = await runNod(["automation", "run", "--json"], { ...opts, actor: "codex" });
  expect(llm.json.error.code).toBe("FORBIDDEN_FOR_LLM");

  const run = await runNod(["automation", "run"], opts);
  expect(run.exitCode).toBe(0);
  expect(run.stdout).toContain(`canceled にしました: 1 件（${open}）`);
  expect(run.stdout).toContain(`アーカイブしました: 1 件（${done}）`);
  const closed = (await runNod(["issue", "show", open, "--json"], opts)).json;
  expect(closed).toMatchObject({ status: "canceled", closeReason: "自動クローズ（30日間更新なし）" });
  const again = await runNod(["automation", "run", "--json"], opts);
  expect(again.json.rules.map((r: { total: number }) => r.total)).toEqual([0, 0, 0]);
});

test("run は定期Issue（#32）の起票を同じ回に行い、--dry-run では予定だけを出す。定期Issueが無ければ節を出さない", async () => {
  const { opts } = fixture();
  expect((await runNod(["automation", "run", "--dry-run"], opts)).stdout).not.toContain("起票する（定期Issue）");
  const today = new Date().toISOString().slice(0, 10);
  const added = await runNod(["recurring", "add", "日次チェック", "--every", "daily", "--start", today, "--tz", "UTC", "--json"], opts);
  expect(added.exitCode).toBe(0);
  const dry = await runNod(["automation", "run", "--dry-run"], { ...opts, actor: "codex" });
  expect(dry.stdout).toContain(`起票する（定期Issue）: 1 件\n  -  ${today} 分  #${added.json.id} 日次チェック`);
  const run = await runNod(["automation", "run", "--json"], opts);
  expect(run.json.recurring).toMatchObject({ enabled: 1, items: [{ recurringId: added.json.id, occurrence: today }], notRun: [], failed: [] });
  const issueId = run.json.recurring.items[0].issueId;
  expect((await runNod(["issue", "show", issueId, "--json"], opts)).json.title).toBe("日次チェック");
  const again = await runNod(["automation", "run"], opts);
  expect(again.stdout).toContain("起票する（定期Issue）: 0 件\n  起票しました: 0 件");
});

test("run は --limit の不正を拒む", async () => {
  const { opts } = fixture();
  for (const limit of ["0", "501", "x"]) {
    const r = await runNod(["automation", "run", "--dry-run", "--limit", limit, "--json"], opts);
    expect(r.json.error.code).toBe("INVALID_ARGS");
  }
});

const PR_URL = "https://github.com/example/api-server/pull/128";

// 実際の gh の代わりに NOD_GH で起動する偽のコマンド（GitHub には触れない）
function fakeGh(state: string, isDraft = false): string {
  const path = join(tempDir("nod-fake-gh-"), "gh");
  const out = JSON.stringify({ number: 128, title: "検索 API", url: PR_URL, state, isDraft, reviewDecision: null, mergedAt: null, statusCheckRollup: [] });
  writeFileSync(path, `#!/bin/sh\necho '${out}'\n`);
  chmodSync(path, 0o755);
  return path;
}

// in_progress で PR URL の付いた Issue（nod issue done は通さない）
async function inProgressWithPr(db: string, opts: { cwd: string; db: string }): Promise<string> {
  const id = (await runNod(["issue", "create", "PR つき", "--json"], opts)).json.id;
  await runNod(["issue", "start", id], { ...opts, actor: "claude-code" });
  const c = openDb(db);
  c.query("UPDATE issues SET pr_url = ? WHERE number = ?").run(PR_URL, Number(id.split("-")[1]));
  c.close();
  return id;
}

test("PR 連動: set --pr-review で有効にし、pr-status --refresh で in_review にし、undo で戻す（#66）", async () => {
  const { db, opts } = fixture();
  expect((await runNod(["automation", "show"], opts)).stdout).toContain("PR 連動: 無効");
  const bad = await runNod(["automation", "set", "--pr-review", "yes", "--json"], opts);
  expect(bad.json.error.code).toBe("INVALID_ARGS");
  expect((await runNod(["automation", "set", "--pr-review", "on", "--json"], { ...opts, actor: "codex" })).json.error.code).toBe(
    "FORBIDDEN_FOR_LLM",
  );
  expect((await runNod(["automation", "set", "--pr-review", "on", "--json"], opts)).json.prReview).toBe(true);
  expect((await runNod(["automation", "show"], opts)).stdout).toContain("PR 連動: PR が open");

  const id = await inProgressWithPr(db, opts);
  const refreshed = await runNod(["issue", "pr-status", id, "--refresh"], { ...opts, actor: "claude-code", env: { NOD_GH: fakeGh("MERGED") } });
  expect(refreshed.exitCode).toBe(0);
  expect(refreshed.stdout).toContain("PR 連動: in_progress → in_review にしました（マージ済み: 完了候補");
  expect(refreshed.stdout).toContain(`nod automation undo ${id}`);
  expect((await runNod(["issue", "show", id, "--json"], opts)).json.status).toBe("in_review");

  expect((await runNod(["automation", "undo", id, "--json"], { ...opts, actor: "codex" })).json.error.code).toBe("FORBIDDEN_FOR_LLM");
  const undo = await runNod(["automation", "undo", id], opts);
  expect(undo.exitCode).toBe(0);
  expect(undo.stdout).toContain(`${id} を in_review から in_progress に戻しました`);
  expect((await runNod(["issue", "show", id, "--json"], opts)).json.status).toBe("in_progress");
  const again = await runNod(["automation", "undo", id, "--json"], opts);
  expect(again.json.error.code).toBe("NOT_FOUND");
  // 同じ PR ではもう進めない
  await runNod(["issue", "pr-status", id, "--refresh"], { ...opts, env: { NOD_GH: fakeGh("MERGED") } });
  expect((await runNod(["issue", "show", id, "--json"], opts)).json.status).toBe("in_progress");
});

test("issue link-pr で作業中の Issue に PR を紐付け（LLM も可）、不正な URL を拒む", async () => {
  const { opts } = fixture();
  const id = (await runNod(["issue", "create", "draft PR", "--json"], opts)).json.id;
  const llm = { ...opts, actor: "claude-code" };
  await runNod(["issue", "start", id], llm);
  const linked = await runNod(["issue", "link-pr", id, PR_URL], llm);
  expect(linked.exitCode).toBe(0);
  expect(linked.stdout).toContain(`${id} に PR ${PR_URL} を紐付けました（ステータス: in_progress）`);
  const bad = await runNod(["issue", "link-pr", id, "https://example.com/pull/1", "--json"], llm);
  expect(bad.json.error.code).toBe("INVALID_ARGS");
  await runNod(["automation", "set", "--pr-review", "on"], opts);
  await runNod(["issue", "pr-status", id, "--refresh"], { ...llm, env: { NOD_GH: fakeGh("OPEN") } });
  expect((await runNod(["issue", "show", id, "--json"], opts)).json.status).toBe("in_review");
});

test("PR 連動: automation run は保存済みの PR 状態で候補を出し、実行で in_review にする", async () => {
  const { db, opts } = fixture();
  const id = await inProgressWithPr(db, opts);
  await runNod(["issue", "pr-status", id, "--refresh"], { ...opts, env: { NOD_GH: fakeGh("OPEN") } });
  expect((await runNod(["issue", "show", id, "--json"], opts)).json.status).toBe("in_progress");
  await runNod(["automation", "set", "--pr-review", "on"], opts);
  const dry = await runNod(["automation", "run", "--dry-run"], { ...opts, actor: "codex" });
  expect(dry.stdout).toContain("PR 連動（PR が open かマージ済み → in_review）: 対象 1 件");
  expect(dry.stdout).toContain(`${id}  in_progress  PR open  ${PR_URL}`);
  const run = await runNod(["automation", "run"], opts);
  expect(run.stdout).toContain(`in_review にしました: 1 件（${id}）`);
  expect((await runNod(["issue", "show", id, "--json"], opts)).json.status).toBe("in_review");
});
