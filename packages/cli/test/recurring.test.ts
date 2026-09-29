import { beforeAll, describe, expect, test } from "bun:test";
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
    const add = await me(["recurring", "add", "日次チェック", "--every", "daily", "--start", "2026-01-01", "--tz", "UTC", "-l", "ops", "--priority", "3", "--assignee", "claude-code"]);
    expect(add.exitCode).toBe(0);
    expect(add.json).toMatchObject({ title: "日次チェック", cadence: "daily", timeZone: "UTC", labels: ["ops"], priority: 3, enabled: true });
    const id = String(add.json.id);
    expect((await me(["recurring", "list"])).json.map((r: { id: number }) => r.id)).toEqual([add.json.id]);
    expect((await runNod(["recurring", "show", id], { cwd: repo, db })).stdout).toContain("周期: 毎日（2026-01-01 から、UTC）");

    const dry = await llm(["recurring", "run", "--dry-run"]);
    expect(dry.json).toMatchObject({ dryRun: true, items: [{ recurringId: add.json.id, issueId: null }] });
    expect(dry.json.items[0].skipped).toBeGreaterThan(0);

    const run = await me(["recurring", "run"]);
    expect(run.json.items).toHaveLength(1);
    const issueId = run.json.items[0].issueId as string;
    expect((await me(["issue", "show", issueId])).json).toMatchObject({ title: "日次チェック", status: "todo", assignee: "claude-code", labels: ["ops"] });
    expect((await me(["recurring", "run"])).json.items).toEqual([]);
    expect((await me(["recurring", "show", id])).json).toMatchObject({ lastIssueId: issueId });

    const updated = await me(["recurring", "update", id, "--every", "weekly", "--weekday", "月", "--disable"]);
    expect(updated.json).toMatchObject({ cadence: "weekly", weekday: 1, enabled: false, nextOccurrence: null });
    expect((await me(["recurring", "remove", id])).exitCode).toBe(0);
    expect((await me(["recurring", "list"])).json).toEqual([]);
    expect((await me(["issue", "show", issueId])).exitCode).toBe(0);
  });

  test("LLM は登録・実行できず、dry-run はできる", async () => {
    expect((await llm(["recurring", "add", "x", "--every", "daily", "--start", "2026-01-01"])).json.error.code).toBe("FORBIDDEN_FOR_LLM");
    expect((await llm(["recurring", "run"])).json.error.code).toBe("FORBIDDEN_FOR_LLM");
    expect((await llm(["recurring", "run", "--dry-run"])).exitCode).toBe(0);
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
