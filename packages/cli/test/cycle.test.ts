import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tempDb } from "./helpers";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

function cli(db: string, cwd: string, args: string[], actor = "codex", env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(["bun", join(import.meta.dir, "../src/main.ts"), ...args], {
    cwd, env: { ...process.env, NOD_DB: db, NOD_ORCA: "0", NOD_ACTOR: actor, ...env }, stdout: "pipe", stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  return { code: proc.exitCode, stdout, stderr: proc.stderr.toString(), json: args.includes("--json") ? JSON.parse(stdout) : undefined };
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "nod-cycle-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  return dir;
}

describe("Cycle CLI", () => {
  test("LLM も Cycle を作り、Issue を入れられるが、削除は人だけ。別 repo の Issue も同じ Cycle に入る", () => {
    const db = tempDb();
    const cwd = repo();
    expect(cli(db, cwd, ["init", "--key", "CYC"], "me").code).toBe(0);
    expect(cli(db, cwd, ["cycle", "create", "S1", "--start", "2000-01-01", "--end", "2000-01-14", "--json"]).json).toMatchObject({
      name: "S1",
      state: "completed",
      createdBy: "codex",
    });
    cli(db, cwd, ["cycle", "create", "S2", "--start", "2999-01-01", "--end", "2999-01-14"]);
    const created = cli(db, cwd, ["issue", "create", "作業", "--cycle", "S1", "--json"], "me").json;
    expect(created.cycle.name).toBe("S1");
    expect(cli(db, cwd, ["issue", "show", created.id]).stdout).toContain("Cycle: S1");
    expect(cli(db, cwd, ["issue", "list", "--cycle", "S1", "--json"]).json.map((i: { id: string }) => i.id)).toEqual([created.id]);
    const outside = cli(db, cwd, ["issue", "create", "Cycle の外", "--json"], "me").json;
    expect(cli(db, cwd, ["issue", "list", "--cycle", "none", "--json"]).json.map((i: { id: string }) => i.id)).toEqual([outside.id]);
    expect(cli(db, cwd, ["cycle", "list"]).stdout).toContain("S1（終了）  2000-01-01〜2000-01-14  0/1  持ち越し候補 1");
    expect(cli(db, cwd, ["cycle", "show", "S1"]).stdout).not.toContain("move-open");
    // 手動でまとめて移すコマンドは廃止した
    expect(cli(db, cwd, ["cycle", "move-open", "S1", "--to", "S2"]).code).not.toBe(0);

    // 別の repo（Workspace）の Issue も同じ Cycle に入れ、名前で両方を絞れる
    const webCwd = repo();
    expect(cli(db, webCwd, ["init", "--key", "WEB"], "me").code).toBe(0);
    const web = cli(db, webCwd, ["issue", "create", "Web の作業", "--cycle", "S1", "--json"], "me").json;
    expect(web.cycle.name).toBe("S1");
    expect(cli(db, cwd, ["issue", "list", "--all-workspaces", "--cycle", "S1", "--json"]).json.map((i: { id: string }) => i.id)).toEqual([created.id, web.id]);
    expect(cli(db, cwd, ["issue", "update", created.id, "--cycle", "", "--json"]).json.cycle).toBeNull();
    expect(cli(db, cwd, ["summary", "--cycle", "S2", "--json"]).code).toBe(0);
    expect(cli(db, cwd, ["stats", "--cycle", "S2", "--json"]).code).toBe(0);
    expect(cli(db, cwd, ["stats", "--cycle", "none", "--json"]).code).toBe(0);
    expect(cli(db, cwd, ["stats", "--milestone", "none", "--cycle", "none", "--json"]).code).toBe(0);
    // 要約も none で Cycle のない Issue だけにする（Issue 一覧と同じ。大文字小文字は問わない）
    const summaryTitles = (cycle: string) => [
      ...new Set(cli(db, cwd, ["summary", "--cycle", cycle, "--json"]).json.sections.flatMap((sec: { items: { title: string }[] }) => sec.items.map((i) => i.title))),
    ];
    expect(summaryTitles("none")).toEqual(["Cycle の外", "作業"]);
    expect(summaryTitles("None")).toEqual(["Cycle の外", "作業"]);
    expect(summaryTitles("S2")).toEqual([]);
    expect(cli(db, cwd, ["cycle", "update", "S2", "--name", "次", "--json"]).json.name).toBe("次");
    // 削除は人だけ（LLM は FORBIDDEN_FOR_LLM）
    const forbidden = cli(db, cwd, ["cycle", "delete", "次", "--json"]);
    expect([forbidden.code, forbidden.json.error.code]).toEqual([1, "FORBIDDEN_FOR_LLM"]);
    expect(cli(db, cwd, ["cycle", "delete", "次", "--json"], "me").json).toMatchObject({ name: "次" });
  });

  test("周期の設定は人だけ。設定するとコマンドの実行時に Cycle が作られ、show に分析が出る", () => {
    const db = tempDb();
    const cwd = repo();
    expect(cli(db, cwd, ["init", "--key", "CAD"], "me").code).toBe(0);
    const llm = cli(db, cwd, ["cycle", "cadence", "set", "--weeks", "2"]);
    expect(llm.code).not.toBe(0);
    expect(llm.stderr).toContain("FORBIDDEN_FOR_LLM");
    expect(cli(db, cwd, ["cycle", "cadence", "set", "--weeks", "2", "--no-carry-over", "--json"], "me").json).toMatchObject({ weeks: 2, autoCarryOver: false });
    expect(cli(db, cwd, ["cycle", "cadence", "show"]).stdout).toContain("2週間ごと");
    const list = cli(db, cwd, ["cycle", "list", "--json"]).json;
    expect(list.map((c: { name: string }) => c.name)).toEqual(["Cycle 1", "Cycle 2"]);
    // 週数だけ変えても、指定しなかった自動持ち越しの設定は保たれる
    expect(cli(db, cwd, ["cycle", "cadence", "set", "--weeks", "3", "--json"], "me").json).toMatchObject({ weeks: 3, autoCarryOver: false });
    cli(db, cwd, ["issue", "create", "作業", "--cycle", "current"], "me");
    const show = cli(db, cwd, ["cycle", "show", "current"]).stdout;
    expect(show).toContain("Completed 0（0%）");
    expect(show).toContain("todo 1");
    expect(cli(db, cwd, ["cycle", "show", "current", "--json"]).json.analytics).toMatchObject({ scope: 1 });
    expect(cli(db, cwd, ["cycle", "cadence", "clear"], "me").code).toBe(0);
    expect(cli(db, cwd, ["cycle", "cadence", "show"]).stdout).toContain("周期は未設定です");
  });

  test("コマンドの --tz の今日で Cycle を作る", () => {
    const db = tempDb();
    const cwd = repo();
    // このマシンのローカルを UTC-12 にし、UTC+14 の今日（ローカルより1日以上先）から始まる1週の Cycle を1つ作っておく
    const local = { TZ: "Etc/GMT+12" };
    const kiritimati = new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Kiritimati" }).format(new Date());
    cli(db, cwd, ["init", "--key", "CTZ"], "me", local);
    cli(db, cwd, ["cycle", "cadence", "set", "--weeks", "1", "--start", kiritimati], "me", local);
    expect(cli(db, cwd, ["cycle", "list", "--json"], "codex", local).json.map((c: { state: string }) => c.state)).toEqual(["upcoming"]);
    // UTC+14 では最初の Cycle が今日を含むので、次の Cycle も作る
    const list = cli(db, cwd, ["cycle", "list", "--tz", "Pacific/Kiritimati", "--json"], "codex", local).json;
    expect(list.map((c: { name: string; state: string }) => `${c.name} ${c.state}`)).toEqual(["Cycle 1 current", "Cycle 2 upcoming"]);
  });

  test("重なり・不正値・不存在はエラーになる", () => {
    const db = tempDb();
    const cwd = repo();
    cli(db, cwd, ["init", "--key", "CYC"], "me");
    cli(db, cwd, ["cycle", "create", "S1", "--start", "2000-01-01", "--end", "2000-01-14"]);
    for (const [args, code] of [
      [["cycle", "create", "S2", "--start", "2000-01-14", "--end", "2000-01-20"], "CYCLE_OVERLAP"],
      [["cycle", "create", "current", "--start", "2001-01-01", "--end", "2001-01-02"], "INVALID_ARGS"],
      [["cycle", "create", "none", "--start", "2001-01-01", "--end", "2001-01-02"], "INVALID_ARGS"],
      [["cycle", "update", "S1"], "INVALID_ARGS"],
      [["cycle", "show", "ない"], "NOT_FOUND"],
      [["cycle", "list", "--tz", "+09:00"], "INVALID_ARGS"],
    ] as const) {
      const result = cli(db, cwd, [...args, "--json"]);
      expect([args.join(" "), result.code, result.json.error.code]).toEqual([args.join(" "), 1, code]);
    }
  });
});
