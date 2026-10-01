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

describe("未決事項と Needs Clarification", () => {
  test("私が足した未決事項で Needs Clarification になり、Inbox には出ず、LLM は着手できない", async () => {
    const created = (await me(["issue", "create", "検索を速くする"])).json;
    const asked = await me(["issue", "ask", created.id, "対象の画面はどれか"]);
    expect(asked.exitCode).toBe(0);
    expect(asked.json.issue).toMatchObject({ status: "needs_clarification", agentState: null });
    expect((await me(["inbox"])).json.questions).toEqual([]);
    expect((await llm(["issue", "next"])).json).toBeNull();
    expect((await llm(["issue", "start", created.id])).json.error.code).toBe("NEEDS_CLARIFICATION");
    const listed = (await me(["issue", "list", "--status", "needs_clarification"])).json;
    expect(listed.map((i: { id: string }) => i.id)).toContain(created.id);
    const text = (await runNod(["issue", "show", created.id], { cwd: repo, db })).stdout;
    expect(text).toContain("Needs Clarification");
    expect(text).toContain("未決事項（0 / 1）");
    expect(text).toContain(`#${asked.json.question.id} [ ] 対象の画面はどれか（me）`);
  });

  test("answer は既定で LLM の質問だけに答え、--question で未決事項を1つずつ決める", async () => {
    const created = (await me(["issue", "create", "一覧を直す"])).json;
    const mine = (await me(["issue", "ask", created.id, "列の順は"])).json.question;
    const noLlm = await me(["answer", created.id, "ステータスを先に"]);
    expect(noLlm.exitCode).toBe(1);
    expect(noLlm.json.error.code).toBe("NO_OPEN_QUESTION");
    expect(noLlm.json.error.message).toContain("--question");
    expect((await me(["answer", created.id, "x", "--question", "abc"])).json.error.code).toBe("INVALID_ARGS");
    const r = (await me(["answer", created.id, "ステータスを先に", "--question", String(mine.id)])).json;
    expect(r.answered).toEqual([expect.objectContaining({ id: mine.id, answer: "ステータスを先に" })]);
    expect(r.issue.status).toBe("todo");
    const text = (await runNod(["issue", "show", created.id], { cwd: repo, db })).stdout;
    expect(text).toContain("未決事項（1 / 1）");
    expect(text).toContain("→ me: ステータスを先に");
  });

  test("LLM は me が付けた未決事項に回答できず、Needs Clarification のまま next に出ない（#172）", async () => {
    const created = (await me(["issue", "create", "絞り込みを足す"])).json;
    const mine = (await me(["issue", "ask", created.id, "対象の列は"])).json.question;
    const denied = await llm(["answer", created.id, "全部", "--question", String(mine.id)]);
    expect(denied.exitCode).toBe(1);
    expect(denied.json.error).toEqual({
      code: "FORBIDDEN_FOR_LLM",
      message: `LLM は me が付けた未決事項（質問 ${mine.id}）に回答できません。回答は me に依頼してください`,
    });
    const bulk = await llm(["answer", created.id, "全部"]);
    expect(bulk.json.error.code).toBe("NO_OPEN_QUESTION");
    expect(bulk.json.error.message).not.toContain("--question");
    const detail = (await me(["issue", "show", created.id])).json;
    expect(detail.status).toBe("needs_clarification");
    expect(detail.openQuestions).toEqual([expect.objectContaining({ id: mine.id, answer: null, answeredBy: null })]);
    expect((await llm(["issue", "suggest"])).json?.id).not.toBe(created.id);
    expect((await llm(["issue", "start", created.id])).json.error.code).toBe("NEEDS_CLARIFICATION");
    const r = (await me(["answer", created.id, "全部", "--question", String(mine.id)])).json;
    expect(r.issue.status).toBe("todo");
  });

  test("手引きに、人が付けた未決事項へ LLM が回答できないことがある", async () => {
    const guide = (await runNod(["skills", "get", "nod"], { cwd: repo, db })).stdout;
    expect(guide).toContain("人が付けた未決事項（`nod issue show` で書き手が me の質問）には LLM は回答できない（FORBIDDEN_FOR_LLM）");
  });

  test("手で needs_clarification に変えようとすると INVALID_ARGS", async () => {
    const created = (await me(["issue", "create", "t"])).json;
    expect((await me(["issue", "update", created.id, "--status", "needs_clarification"])).json.error.code).toBe(
      "INVALID_ARGS",
    );
  });

  test("人が needs_clarification から todo に移すと、そのまま todo になる（#170）", async () => {
    const created = (await me(["issue", "create", "t"])).json;
    await me(["issue", "ask", created.id, "対象はどれか"]);
    const updated = await me(["issue", "update", created.id, "--status", "todo"]);
    expect(updated.exitCode).toBe(0);
    expect(updated.json.status).toBe("todo");
    const shown = (await me(["issue", "show", created.id])).json;
    expect(shown).toMatchObject({ status: "todo", openQuestions: [{ question: "対象はどれか" }] });
    const changes = shown.activity.filter((a: { type?: string }) => a.type === "status_changed").map((a: { data: unknown }) => a.data);
    expect(changes).toEqual([
      { from: "todo", to: "needs_clarification" },
      { from: "needs_clarification", to: "todo" },
    ]);
  });

  test("update は、結果が todo・backlog で未回答が残るときだけ、次の行に注記を添える（#170）", async () => {
    const text = (args: string[]) => runNod(args, { cwd: repo, db });
    const note = (n: number) => `未回答の確認依頼が ${n} 件残っています（すべて回答されるまで着手できません）`;
    const created = (await me(["issue", "create", "注記を確かめる"])).json;
    const first = (await me(["issue", "ask", created.id, "対象はどれか"])).json.question;
    const second = (await me(["issue", "ask", created.id, "期限はいつか"])).json.question;
    for (const status of ["todo", "backlog"]) {
      const lines = (await text(["issue", "update", created.id, "--status", status])).stdout.trimEnd().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toStartWith(`更新しました: ${created.id}`);
      expect(lines[1]).toBe(note(2));
    }
    // --json は変えない
    const json = await me(["issue", "update", created.id, "--status", "todo"]);
    expect(json.stdout).not.toContain("残っています");
    expect(json.json.questionCount).toEqual({ answered: 0, total: 2 });
    await me(["answer", created.id, "一覧", "--question", String(first.id)]);
    expect((await text(["issue", "update", created.id, "--status", "backlog"])).stdout).toContain(note(1));
    // 着手の状態と、未回答がない Issue には添えない
    expect((await text(["issue", "update", created.id, "--status", "in_progress"])).stdout).not.toContain("残っています");
    await me(["issue", "update", created.id, "--status", "todo"]);
    await me(["answer", created.id, "来週", "--question", String(second.id)]);
    expect((await text(["issue", "update", created.id, "--status", "backlog"])).stdout).not.toContain("残っています");
  });

  test("bulk-update は、未回答が残る todo・backlog の件数を1行で添える（#170）", async () => {
    const text = (args: string[]) => runNod(args, { cwd: repo, db });
    const a = (await me(["issue", "create", "a"])).json;
    const b = (await me(["issue", "create", "b"])).json;
    const c = (await me(["issue", "create", "c"])).json;
    await me(["issue", "ask", a.id, "対象はどれか"]);
    await me(["issue", "ask", a.id, "期限はいつか"]);
    await me(["issue", "ask", b.id, "対象はどれか"]);
    const out = (await text(["issue", "bulk-update", a.id, b.id, c.id, "--status", "todo"])).stdout.trimEnd().split("\n");
    expect(out[0]).toBe("3 件を更新しました");
    expect(out.at(-1)).toBe("うち 2 件に未回答の確認依頼が残っています");
    expect(out).toHaveLength(5);
    const json = await me(["issue", "bulk-update", a.id, b.id, c.id, "--status", "backlog"]);
    expect(json.stdout).not.toContain("残っています");
    expect(json.json).toHaveLength(3);
    expect((await text(["issue", "bulk-update", a.id, b.id, "--status", "in_progress"])).stdout).not.toContain("残っています");
    expect((await text(["issue", "bulk-update", c.id, "--status", "todo"])).stdout).not.toContain("残っています");
  });

  test("LLM は canceled を経由しても、me の未決事項が残る Issue を着手の状態にできない（#170）", async () => {
    const created = (await me(["issue", "create", "t"])).json;
    await me(["issue", "ask", created.id, "対象はどれか"]);
    expect((await llm(["issue", "update", created.id, "--status", "triage"])).json.error.code).toBe("FORBIDDEN_FOR_LLM");
    expect((await llm(["issue", "update", created.id, "--status", "canceled"])).json.status).toBe("canceled");
    for (const status of ["in_progress", "in_review"]) {
      expect((await llm(["issue", "update", created.id, "--status", status])).json.error.code).toBe("FORBIDDEN_FOR_LLM");
    }
    expect((await me(["issue", "show", created.id])).json.status).toBe("canceled");
  });

  test("同じ文面の ask の再実行は、人が todo に出した Issue を needs_clarification に戻さない（#170）", async () => {
    const created = (await me(["issue", "create", "t"])).json;
    await llm(["issue", "ask", created.id, "どちらの方式にするか"]);
    await me(["issue", "update", created.id, "--status", "todo"]);
    const again = (await llm(["issue", "ask", created.id, "どちらの方式にするか"])).json;
    expect(again).toMatchObject({ created: false, issue: { status: "todo" } });
    expect((await llm(["issue", "ask", created.id, "期限はいつか"])).json.issue.status).toBe("needs_clarification");
  });

  test("LLM は me の未決事項が未回答の間、update でも bulk-update でも needs_clarification から出せない（#170）", async () => {
    const created = (await me(["issue", "create", "t"])).json;
    await me(["issue", "ask", created.id, "対象はどれか"]);
    for (const status of ["todo", "backlog", "triage", "in_progress", "in_review"]) {
      const r = await llm(["issue", "update", created.id, "--status", status]);
      expect(r.exitCode).toBe(1);
      expect(r.json.error.code).toBe("FORBIDDEN_FOR_LLM");
    }
    const bulk = await llm(["issue", "bulk-update", created.id, "--status", "in_progress"]);
    expect(bulk.exitCode).toBe(1);
    expect(bulk.json.error).toMatchObject({
      code: "BULK_UPDATE_FAILED",
      details: { failures: [{ id: created.id, code: "FORBIDDEN_FOR_LLM" }] },
    });
    expect((await me(["issue", "show", created.id])).json.status).toBe("needs_clarification");
  });

  test("手引きに NEEDS_CLARIFICATION への対処がある", async () => {
    expect((await runNod(["skills", "get", "nod"], { cwd: repo, db })).stdout).toContain("NEEDS_CLARIFICATION");
  });
});

test("安全な整数を超える --question を INVALID_ARGS にする", async () => {
  const created = (await me(["issue", "create", "質問 ID の検証"])).json;
  const result = await me(["answer", created.id, "回答", "--question", "9007199254740993"]);
  expect(result.json.error.code).toBe("INVALID_ARGS");
});
