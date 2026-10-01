import { describe, expect, test } from "bun:test";
import { openDb } from "@nod/core";
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

describe("nod inbox の Triage の件数と triage list・review list（#177）", () => {
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

  test("review list は inbox のレビュー待ちと同じ Issue を出し、LLM も実行できる", async () => {
    const { me, llm } = await seed();
    const r = await me(["review", "list"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trimEnd().split("\n")).toEqual(["API-3  In Review   [done]  mine"]);
    const asLlm = await llm(["review", "list", "--json"]);
    expect(asLlm.json.map((i: { id: string }) => i.id)).toEqual(["API-3"]);
    expect(asLlm.json).toEqual((await me(["inbox", "--json"])).json.reviews);
    await me(["review", "approve", "API-3"]);
    expect((await me(["review", "list"])).stdout.trim()).toBe("レビュー待ちの Issue はありません");
  });

  test("LLM の Triage の判断は list を足しても拒否される", async () => {
    const { llm } = await seed();
    const r = await llm(["triage", "accept", "API-1"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("FORBIDDEN_FOR_LLM");
  });
});

describe("差し戻し後の nod issue start は差し戻しの理由を出す（#177）", () => {
  async function submitted() {
    const s = setup();
    await s.me(["issue", "create", "a"]);
    await s.llm(["issue", "start", "API-1"]);
    await s.llm(["issue", "done", "API-1", "--summary", "終えた"]);
    return s;
  }

  test("差し戻されていなければ理由を出さず、rejection は null", async () => {
    const { me, llm } = setup();
    await me(["issue", "create", "a"]);
    const r = await llm(["issue", "start", "API-1"]);
    expect(r.stdout).not.toContain("差し戻し");
    expect((await llm(["issue", "start", "API-1", "--json"])).json.rejection).toBeNull();
  });

  test("理由だけの差し戻しのあと、再提出するまで start のたびに理由を出す", async () => {
    const { me, llm } = await submitted();
    await me(["review", "reject", "API-1", "テストが足りない。\n境界値を足す"]);
    for (let n = 0; n < 2; n++) {
      const r = await llm(["issue", "start", "API-1"]);
      expect(r.stdout).toMatch(/差し戻しの理由（me、\d{4}-\d{2}-\d{2} \d{2}:\d{2}）:\n  テストが足りない。\n  境界値を足す/);
    }
    const json = (await llm(["issue", "start", "API-1", "--json"])).json;
    expect(json.rejection).toMatchObject({ reason: "テストが足りない。\n境界値を足す", actor: "me", delegate: null });
    expect(typeof json.rejection.at).toBe("string");
    await llm(["issue", "done", "API-1", "--summary", "直した"]);
    await me(["review", "reject", "API-1", "まだ足りない"]);
    const again = await llm(["issue", "start", "API-1"]);
    expect(again.stdout).toContain("  まだ足りない");
    expect(again.stdout).not.toContain("テストが足りない");
  });

  test("再提出のあとは出さない（人が手で in_progress に戻しても同じ）", async () => {
    const { db, me, llm } = await submitted();
    await me(["review", "reject", "API-1", "やり直し"]);
    await llm(["issue", "start", "API-1"]);
    await llm(["issue", "done", "API-1", "--summary", "直した"]);
    await me(["issue", "update", "API-1", "--status", "in_progress"]);
    const r = await llm(["issue", "start", "API-1", "--json"]);
    expect(r.json.rejection).toBeNull();
    const d = openDb(db);
    expect((d.query("SELECT COUNT(*) AS n FROM events WHERE type = 'review_rejected'").get() as { n: number }).n).toBe(1);
    d.close();
  });

  test("対応依頼つきの差し戻しは、対応依頼を渡す回は理由を重ねず、次からは理由を出す", async () => {
    const { me, llm } = await submitted();
    await me(["review", "reject", "API-1", "main に追従して", "--delegate", "rebase"]);
    const first = await llm(["issue", "start", "API-1"]);
    expect(first.stdout).toContain("追加指示（先に読んで対応する）:");
    expect(first.stdout).not.toContain("差し戻しの理由（");
    const second = await llm(["issue", "start", "API-1"]);
    expect(second.stdout).not.toContain("追加指示（先に読んで対応する）:");
    expect(second.stdout).toContain("差し戻しの理由（me、");
    expect(second.stdout).toContain("  main に追従して");
    expect((await llm(["issue", "start", "API-1", "--json"])).json.rejection).toMatchObject({ reason: "main に追従して", delegate: "rebase" });
  });
});

describe("nod project list の LLM の状況（#177）", () => {
  test("正の件数だけを 入力待ち・エラー・レビュー待ち・作業中 の順に出し、すべて0なら — を出す", async () => {
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
      "2  動く  0/4  健全性 未設定  入力待ち 1、レビュー待ち 1、作業中 1",
    ]);
    await llm(["issue", "start", "API-4"]);
    await llm(["issue", "fail", "API-4", "環境が壊れている"]);
    expect((await lines()).sort()[1]).toBe("2  動く  0/4  健全性 未設定  入力待ち 1、エラー 1、レビュー待ち 1、作業中 1");
    const json = (await me(["project", "list", "--json"])).json;
    expect(json.find((p: { name: string }) => p.name === "空").agents).toEqual({ working: 0, awaitingInput: 0, awaitingReview: 0, error: 0 });
  });
});
