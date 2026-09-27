import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, runNod, tempDb } from "./helpers";

async function workspace() {
  const db = tempDb();
  const repo = makeRepo("api-server");
  await runNod(["init"], { cwd: repo, db });
  const llm = (args: string[]) => runNod([...args, "--json"], { cwd: repo, db, actor: "claude-code" });
  const me = (args: string[]) => runNod([...args, "--json"], { cwd: repo, db });
  return { repo, llm, me };
}

test("起票から承認までを LLM と私で分担して進められる", async () => {
  const { llm, me } = await workspace();
  const created = (await llm(["issue", "create", "検索の N+1 を解消"])).json;
  expect(created.status).toBe("triage");
  expect((await llm(["issue", "next"])).json).toBeNull();

  expect((await me(["triage", "accept", created.id])).json.status).toBe("todo");
  expect((await llm(["issue", "next"])).json).toMatchObject({ id: created.id, agentState: "working" });

  await llm(["issue", "ask", created.id, "インデックスを足してよいか"]);
  const inbox = (await me(["inbox"])).json;
  expect(inbox.questions.map((q: { question: string }) => q.question)).toEqual(["インデックスを足してよいか"]);

  expect((await me(["answer", created.id, "足してよい"])).json.issue.agentState).toBe("working");
  expect((await me(["inbox"])).json.questions).toEqual([]);
  expect((await me(["answer", created.id, "もう一度"])).json.error.code).toBe("NO_OPEN_QUESTION");

  await llm(["issue", "done", created.id, "--summary", "インデックスを足した", "--pr", "https://example.com/pull/1"]);
  expect((await me(["inbox"])).json.reviews.map((i: { id: string }) => i.id)).toEqual([created.id]);
  expect((await me(["review", "approve", created.id])).json.status).toBe("done");
});

test("Triage の却下、重複、後回しと、レビューの差し戻し", async () => {
  const { llm, me } = await workspace();
  const a = (await llm(["issue", "create", "a"])).json;
  const b = (await llm(["issue", "create", "b"])).json;
  const c = (await llm(["issue", "create", "c"])).json;
  expect((await me(["triage", "decline", a.id, "--reason", "不要"])).json).toMatchObject({ status: "canceled", closeReason: "不要" });
  expect((await me(["triage", "duplicate", b.id, c.id])).json.status).toBe("canceled");
  expect((await me(["triage", "snooze", c.id, "2099-01-01"])).json.status).toBe("triage");
  expect((await me(["triage", "snooze", c.id, "来週"])).json.error.code).toBe("INVALID_ARGS");

  const d = (await me(["issue", "create", "d"])).json;
  await llm(["issue", "start", d.id]);
  await llm(["issue", "done", d.id, "--summary", "やった"]);
  expect((await me(["review", "reject", d.id, "テストが足りない"])).json).toMatchObject({ status: "in_progress", agentState: null });
});

test("Project を作って Issue を束ね、Document を添付する", async () => {
  const { repo, llm, me } = await workspace();
  expect((await me(["project", "create", "検索", "-d", "検索を速くする"])).json.name).toBe("検索");
  await me(["issue", "create", "a", "--project", "検索"]);
  await llm(["issue", "create", "b", "--project", "検索"]);
  writeFileSync(join(repo, "spec.md"), "# 検索の設計\n");
  await me(["project", "doc", "add", "検索", "spec.md"]);
  const list = (await me(["project", "list"])).json;
  expect(list).toEqual([expect.objectContaining({ name: "検索", total: 2, done: 0 })]);
  const shown = (await me(["project", "show", "検索"])).json;
  expect(shown.issues).toHaveLength(2);
  expect(shown.documents).toEqual([expect.objectContaining({ title: "検索の設計" })]);
});

// controller の裁定で追加したテスト
test("LLM は review approve できず FORBIDDEN_FOR_LLM になり、Issue は In Review のまま", async () => {
  const { llm, me } = await workspace();
  const d = (await me(["issue", "create", "d"])).json;
  await llm(["issue", "start", d.id]);
  await llm(["issue", "done", d.id, "--summary", "やった"]);
  const r = await llm(["review", "approve", d.id]);
  expect(r.exitCode).toBe(1);
  expect(r.json.error.code).toBe("FORBIDDEN_FOR_LLM");
  expect((await me(["issue", "show", d.id])).json.status).toBe("in_review");
});
