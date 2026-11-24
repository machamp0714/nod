import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

let db: string;
let repo: string;

beforeAll(() => {
  db = tempDb();
  repo = makeRepo();
  registerRepo(db, repo);
});

const me = (args: string[]) => runNod([...args, "--json"], { cwd: repo, db });
const llm = (args: string[]) => runNod([...args, "--json"], { cwd: repo, db, actor: "claude-code" });

describe("nod recurring", () => {
  test("登録・一覧・表示・変更・実行・削除ができ、同じ発生日は二度作らない", async () => {
    const add = await me(["recurring", "add", "日次チェック", "--every", "daily", "--start", "2026-01-01", "--tz", "UTC", "-l", "ops", "--priority", "3"]);
    expect(add.exitCode).toBe(0);
    expect(add.json).toMatchObject({ title: "日次チェック", cadence: "daily", timeZone: "UTC", labels: ["ops"], priority: 3, enabled: true });
    const id = String(add.json.id);
    expect((await me(["recurring", "list"])).json.map((r: { id: number }) => r.id)).toEqual([add.json.id]);
    const shown = await runNod(["recurring", "show", id], { cwd: repo, db });
    expect(shown.stdout).toContain("周期: 毎日（2026-01-01 から、UTC）");
    expect(shown.stdout).not.toContain("担当");
    expect((await me(["recurring", "show", id])).json).not.toHaveProperty("assignee");
    for (const args of [
      ["add", "x", "--every", "daily", "--start", "2026-01-01", "--assignee", "null"],
      ["update", id, "--assignee", ""],
      ["update", id, "--assignee"],
    ]) {
      expect((await me(["recurring", ...args])).json.error).toMatchObject({
        code: "INVALID_ARGS", message: expect.stringContaining("担当は廃止されました"),
      });
    }

    const dry = await llm(["recurring", "run", "--dry-run"]);
    expect(dry.json).toMatchObject({ dryRun: true, items: [{ recurringId: add.json.id, issueId: null }] });
    expect(dry.json.items[0].skipped).toBeGreaterThan(0);

    const run = await me(["recurring", "run"]);
    expect(run.json.items).toHaveLength(1);
    const issueId = run.json.items[0].issueId as string;
    const generated = (await me(["issue", "show", issueId])).json;
    expect(generated).toMatchObject({ title: "日次チェック", status: "todo", labels: ["ops"] });
    expect(generated).not.toHaveProperty("assignee");
    expect((await me(["recurring", "run"])).json.items).toEqual([]);
    expect((await me(["recurring", "show", id])).json).toMatchObject({ lastIssueId: issueId });

    const updated = await me(["recurring", "update", id, "--every", "weekly", "--weekday", "月", "--disable"]);
    expect(updated.json).toMatchObject({ cadence: "weekly", weekday: 1, enabled: false, nextOccurrence: null });
    expect((await me(["recurring", "remove", id, "--yes"])).exitCode).toBe(0);
    expect((await me(["recurring", "list"])).json).toEqual([]);
    expect((await me(["issue", "show", issueId])).exitCode).toBe(0);
  });

  test("LLM も登録・変更・実行でき、dry-run は変更しない", async () => {
    const ownDb = tempDb();
    const cwd = makeRepo();
    registerRepo(ownDb, cwd);
    const opts = { cwd, db: ownDb, actor: "codex" };
    const run = (args: string[]) => runNod([...args, "--json"], opts);
    const added = await run(["recurring", "add", "初版", "--every", "daily", "--start", "2020-01-01", "--tz", "UTC"]);
    expect(added.exitCode).toBe(0);
    const id = String(added.json.id);
    expect((await run(["recurring", "update", id, "--title", "更新版"])).json).toMatchObject({ title: "更新版", updatedBy: "codex" });
    expect((await run(["recurring", "run", "--dry-run"])).json.items).toMatchObject([{ recurringId: added.json.id, issueId: null }]);
    expect((await run(["issue", "list"])).json).toEqual([]);
    expect((await run(["recurring", "show", id])).json.lastOccurrence).toBeNull();
    const applied = await run(["recurring", "run"]);
    expect(applied.exitCode).toBe(0);
    expect((await run(["issue", "show", applied.json.items[0].issueId])).json.title).toBe("更新版");
    expect((await run(["recurring", "run"])).json.items).toEqual([]);
  });

  test("引数の誤りは INVALID_ARGS", async () => {
    const code = async (args: string[]) => (await me(args)).json.error.code;
    expect(await code(["recurring", "add", "x", "--start", "2026-01-01"])).toBe("INVALID_ARGS");
    expect(await code(["recurring", "add", "x", "--every", "daily"])).toBe("INVALID_ARGS");
    expect(await code(["recurring", "add", "x", "--every", "yearly", "--start", "2026-01-01"])).toBe("INVALID_ARGS");
    expect(await code(["recurring", "add", "x", "--every", "weekly", "--weekday", "xyz", "--start", "2026-01-01"])).toBe("INVALID_ARGS");
    expect(await code(["recurring", "add", "x", "--every", "monthly", "--day", "32", "--start", "2026-01-01"])).toBe("INVALID_ARGS");
    expect(await code(["recurring", "update", "1"])).toBe("INVALID_ARGS");
    expect(await code(["recurring", "show", "999"])).toBe("NOT_FOUND");
  });

  test("dry-run のテキスト出力は予定と飛ばした回数を出す", async () => {
    await me(["recurring", "add", "週次", "--every", "weekly", "--weekday", "mon", "--start", "2026-01-01", "--tz", "UTC"]);
    const out = (await runNod(["recurring", "run", "--dry-run"], { cwd: repo, db })).stdout;
    expect(out).toContain("起票する予定: 1 件");
    expect(out).toContain("回分は起票せずに飛ばします");
    expect(out).toContain("dry-run のため起票していません");
  });
});

describe("LLM に定型作業を定期実行させる（#64）", () => {
  test("README の定型作業テンプレートを登録し、定期Issueを人が実行すると、LLM の next で拾われる", async () => {
    const ownDb = tempDb();
    const ownRepo = makeRepo();
    registerRepo(ownDb, ownRepo);
    const as = (actor: string | undefined, args: string[]) => runNod([...args, "--json"], { cwd: ownRepo, db: ownDb, actor });
    const templates = join(import.meta.dir, "../../../docs/templates");
    for (const [name, file] of [["依存更新チェック", "dependency-update-check.md"], ["週次レポート", "weekly-report.md"]] as const) {
      expect((await as(undefined, ["template", "add", name, "--from", join(templates, file)])).exitCode).toBe(0);
    }
    const add = await as(undefined, ["recurring", "add", "依存更新チェック", "--template", "依存更新チェック", "--every", "daily", "--start", "2026-01-01", "--tz", "UTC"]);
    expect(add.exitCode).toBe(0);
    // 実行前は起票されていないので拾えない
    expect((await as("claude-code", ["issue", "next"])).json).toBeNull();

    const run = await as(undefined, ["recurring", "run"]);
    const issueId = run.json.items[0].issueId as string;
    const next = await as("claude-code", ["issue", "next"]);
    expect(next.json).toMatchObject({
      id: issueId,
      status: "in_progress",
      description: readFileSync(join(templates, "dependency-update-check.md"), "utf8"),
    });
  });
});
