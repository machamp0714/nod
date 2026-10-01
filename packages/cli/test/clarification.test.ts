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

  test("手引きに NEEDS_CLARIFICATION への対処がある", async () => {
    expect((await runNod(["skills", "get", "nod"], { cwd: repo, db })).stdout).toContain("NEEDS_CLARIFICATION");
  });
});

test("安全な整数を超える --question を INVALID_ARGS にする", async () => {
  const created = (await me(["issue", "create", "質問 ID の検証"])).json;
  const result = await me(["answer", created.id, "回答", "--question", "9007199254740993"]);
  expect(result.json.error.code).toBe("INVALID_ARGS");
});
