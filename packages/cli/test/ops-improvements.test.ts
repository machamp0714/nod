import { describe, expect, test } from "bun:test";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

function setup() {
  const db = tempDb();
  const cwd = makeRepo("api-server");
  registerRepo(db, cwd, "API");
  const me = (args: string[]) => runNod(args, { cwd, db });
  const llm = (args: string[]) => runNod(args, { cwd, db, actor: "claude-code" });
  return { db, cwd, me, llm };
}

describe("優先度を名前でも指定する（#177）", () => {
  test("create・update・bulk-update の -p は名前・P0〜P4・数字を受け付ける", async () => {
    const { me } = setup();
    expect((await me(["issue", "create", "a", "-p", "high", "--json"])).json.priority).toBe(2);
    expect((await me(["issue", "create", "b", "-p", "P1", "--json"])).json.priority).toBe(1);
    expect((await me(["issue", "create", "c", "-p", "3", "--json"])).json.priority).toBe(3);
    expect((await me(["issue", "update", "API-1", "-p", "Urgent", "--json"])).json.priority).toBe(1);
    expect((await me(["issue", "update", "API-1", "-p", "none", "--json"])).json.priority).toBe(0);
    expect((await me(["issue", "bulk-update", "API-2", "API-3", "-p", "low"])).exitCode).toBe(0);
    expect((await me(["issue", "list", "--priority", "low", "--json"])).json.map((i: { id: string }) => i.id)).toEqual(["API-2", "API-3"]);
  });

  test("triage propose と recurring の優先度も名前で指定できる", async () => {
    const { me, llm } = setup();
    await llm(["issue", "create", "t"]);
    expect((await llm(["triage", "propose", "API-1", "--accept", "-p", "medium", "--json"])).json.priority).toBe(3);
    const r = await me(["recurring", "add", "毎週の確認", "--every", "weekly", "--weekday", "mon", "--start", "2026-10-05", "--priority", "high", "--json"]);
    expect(r.exitCode).toBe(0);
    expect(r.json.priority).toBe(2);
  });

  test("知らない名前とカンマ区切りは INVALID_ARGS で、使える値を示す", async () => {
    const { me } = setup();
    for (const value of ["highest", "1,2", "5"]) {
      const r = await me(["issue", "create", "x", "-p", value]);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain("INVALID_ARGS");
      expect(r.stderr).toContain("urgent, high, medium, low, none");
    }
    expect((await me(["issue", "list", "--json"])).json).toEqual([]);
  });
});

describe("nod inbox の Triage の件数と triage list（#177）", () => {
  async function seed() {
    const s = setup();
    await s.llm(["issue", "create", "llm-1"]); // API-1 triage
    await s.llm(["issue", "create", "llm-2"]); // API-2 triage（スヌーズ中）
    await s.me(["issue", "create", "mine"]); // API-3 todo
    await s.llm(["issue", "start", "API-3"]);
    await s.llm(["issue", "done", "API-3", "--summary", "終えた"]);
    await s.me(["triage", "snooze", "API-2", "2099-01-01"]);
    return s;
  }

  test("inbox は Triage の件数（スヌーズ中を除く）と一覧のコマンドを出す", async () => {
    const { me } = await seed();
    const r = await me(["inbox"]);
    expect(r.stdout).toContain("Triage（1）  nod triage list で一覧");
    const json = (await me(["inbox", "--json"])).json;
    expect(json.triageCount).toBe(1);
  });

  test("Triage が0件なら一覧の案内を付けない", async () => {
    const { me } = setup();
    const lines = (await me(["inbox"])).stdout.trimEnd().split("\n");
    expect(lines).toContain("Triage（0）");
  });

  test("triage list はスヌーズ中を除く Triage の Issue を出し、LLM も実行できる", async () => {
    const { me, llm } = await seed();
    const r = await me(["triage", "list"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trimEnd().split("\n")).toEqual(["API-1  Triage       llm-1"]);
    const asLlm = await llm(["triage", "list", "--json"]);
    expect(asLlm.exitCode).toBe(0);
    expect(asLlm.json.map((i: { id: string }) => i.id)).toEqual(["API-1"]);
    await me(["triage", "accept", "API-1"]);
    expect((await me(["triage", "list"])).stdout.trim()).toBe("Triage の Issue はありません");
  });



  test("LLM も Triage の判断をできる", async () => {
    const { llm } = await seed();
    const r = await llm(["triage", "accept", "API-1"]);
    expect(r.exitCode).toBe(0);
  });
});

describe("nod project list の LLM の状況（#177）", () => {
  test("正の件数だけを 入力待ち・エラー・作業中 の順に出し、すべて0なら — を出す", async () => {
    const { me, llm } = setup();
    await me(["project", "create", "空"]);
    await me(["project", "create", "動く"]);
    for (const title of ["w", "ask", "review", "fail"]) await me(["issue", "create", title, "--project", "動く"]);
    await llm(["issue", "start", "API-1"]);
    await llm(["issue", "start", "API-2"]);
    await llm(["issue", "ask", "API-2", "進めてよいか"]);
    await llm(["issue", "start", "API-3"]);
    await llm(["issue", "done", "API-3", "--summary", "終えた"]);
    const lines = () => me(["project", "list"]).then((r) => r.stdout.trimEnd().split("\n"));
    expect((await lines()).sort()).toEqual([
      "1  空  0/0  健全性 未設定  —",
      "2  動く  1/4  健全性 未設定  入力待ち 1、作業中 1",
    ]);
    await llm(["issue", "start", "API-4"]);
    await llm(["issue", "fail", "API-4", "環境が壊れている"]);
    expect((await lines()).sort()[1]).toBe("2  動く  1/4  健全性 未設定  入力待ち 1、エラー 1、作業中 1");
    const json = (await me(["project", "list", "--json"])).json;
    expect(json.find((p: { name: string }) => p.name === "空").agents).toEqual({ working: 0, awaitingInput: 0, error: 0 });
  });
});
