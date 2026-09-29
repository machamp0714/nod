import { expect, test } from "bun:test";
import { openDb } from "@nod/core";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

const old = "2020-01-01T00:00:00Z";

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
  expect(dryJson.json).toMatchObject({ dryRun: true, rules: [{ kind: "auto_close", total: 1 }, { kind: "auto_archive", total: 1 }] });
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
  expect(again.json.rules.map((r: { total: number }) => r.total)).toEqual([0, 0]);
});

test("run は --limit の不正を拒む", async () => {
  const { opts } = fixture();
  for (const limit of ["0", "501", "x"]) {
    const r = await runNod(["automation", "run", "--dry-run", "--limit", limit, "--json"], opts);
    expect(r.json.error.code).toBe("INVALID_ARGS");
  }
});
