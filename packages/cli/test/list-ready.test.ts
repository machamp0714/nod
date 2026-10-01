import { describe, expect, test } from "bun:test";
import { openDb, queryIssues } from "@nod/core";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

// 着手できる（Ready）: API-1 Low、API-3 回答済みの未決事項あり、API-5 Urgent（API-4 のブロック元）、API-10 High・担当 claude-code、API-11 スヌーズの期限が過去、WEB-1
// 着手できない: API-2 未回答ありを手で todo に出した、API-4 ブロックされている、API-6 backlog、API-7 in_progress、API-8 スヌーズ中、API-9 アーカイブ済み
async function seed() {
  const db = tempDb();
  const api = makeRepo("api-server");
  const web = makeRepo("web");
  registerRepo(db, api, "API");
  registerRepo(db, web, "WEB");
  const me = (args: string[], cwd = api) => runNod(args, { cwd, db });
  await me(["issue", "create", "plain", "--priority", "4"]);
  await me(["issue", "create", "asked"]);
  await me(["issue", "create", "answered"]);
  await me(["issue", "create", "blocked"]);
  await me(["issue", "create", "blocker", "--priority", "1"]);
  await me(["issue", "create", "backlog"]);
  await me(["issue", "create", "working"]);
  await me(["issue", "create", "snoozed"]);
  await me(["issue", "create", "archived"]);
  await me(["issue", "create", "delegated", "--priority", "2"]);
  await me(["issue", "create", "snooze-past"]);
  await me(["issue", "create", "w"], web);
  await me(["issue", "ask", "API-2", "色はどうするか"]);
  await me(["issue", "update", "API-2", "--status", "todo"]);
  await me(["issue", "ask", "API-3", "期限はいつか"]);
  await me(["answer", "API-3", "来週", "--question", "2"]);
  await me(["issue", "update", "API-3", "--status", "todo"]);
  await me(["issue", "relate", "API-5", "--blocks", "API-4"]);
  await me(["issue", "update", "API-6", "--status", "backlog"]);
  await runNod(["issue", "start", "API-7"], { cwd: api, db, actor: "claude-code" });
  const d = openDb(db);
  d.run("UPDATE issues SET snoozed_until = '2099-01-01T00:00:00.000Z' WHERE title = 'snoozed'");
  d.run("UPDATE issues SET snoozed_until = '2000-01-01T00:00:00.000Z' WHERE title = 'snooze-past'");
  d.close();
  await me(["issue", "archive", "API-9"]);
  await me(["issue", "update", "API-10", "--assignee", "claude-code"]);
  return { db, api, web, me };
}

const idsOf = (r: { json: { id: string }[] }) => r.json.map((i) => i.id);
const READY = ["API-1", "API-3", "API-5", "API-10", "API-11"];

describe("nod issue list --ready（#169）", () => {
  test("前提：手で todo に出した未回答ありの Issue も、回答済みの Issue も todo にある", async () => {
    const { me } = await seed();
    expect(idsOf(await me(["issue", "list", "--status", "todo", "--json"]))).toEqual(["API-1", "API-2", "API-3", "API-4", "API-5", "API-8", "API-10", "API-11"]);
  });

  test("着手できる Issue だけを、担当を問わず ID の順に出す", async () => {
    const { me } = await seed();
    expect(idsOf(await me(["issue", "list", "--ready", "--json"]))).toEqual(READY);
    const r = await me(["issue", "list", "--ready"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trimEnd().split("\n")).toEqual([
      "API-1   Todo         Low     -  plain",
      "API-3   Todo         -       -  answered  [未決 1/1]",
      "API-5   Todo         Urgent  -  blocker",
      "API-10  Todo         High    -  delegated",
      "API-11  Todo         -       -  snooze-past",
    ]);
  });

  test("API の ready（Web の Ready タブ）と同じ Issue を返す", async () => {
    const { db, me } = await seed();
    const d = openDb(db);
    const api = queryIssues(d, { ready: true }).issues.map((i) => i.id);
    d.close();
    expect(api).toEqual([...READY, "WEB-1"]);
    expect(idsOf(await me(["issue", "list", "--ready", "--all-workspaces", "--json"]))).toEqual(api);
  });

  test("ブロック元が完了すると出て、未回答に回答すると出る", async () => {
    const { me } = await seed();
    await me(["issue", "update", "API-5", "--status", "done"]);
    await me(["answer", "API-2", "青", "--question", "1"]);
    expect(idsOf(await me(["issue", "list", "--ready", "--json"]))).toEqual(["API-1", "API-2", "API-3", "API-4", "API-10", "API-11"]);
  });

  test("--status は AND で効き、todo 以外と組み合わせると0件（エラーにしない）", async () => {
    const { me } = await seed();
    expect(idsOf(await me(["issue", "list", "--ready", "--status", "todo", "--json"]))).toEqual(READY);
    expect(idsOf(await me(["issue", "list", "--ready", "--status", "todo,backlog", "--json"]))).toEqual(READY);
    const none = await me(["issue", "list", "--ready", "--status", "backlog,in_progress"]);
    expect(none.exitCode).toBe(0);
    expect(none.stdout.trimEnd()).toBe("Issue はありません");
    expect((await me(["issue", "list", "--ready", "--status", "backlog", "--json"])).json).toEqual([]);
    expect((await me(["issue", "list", "--ready", "--archived", "--json"])).json).toEqual([]);
  });

  test("--priority・--sort・--desc と併用できる", async () => {
    const { me } = await seed();
    expect(idsOf(await me(["issue", "list", "--ready", "--priority", "urgent,high", "--json"]))).toEqual(["API-5", "API-10"]);
    expect(idsOf(await me(["issue", "list", "--ready", "--sort", "priority", "--json"]))).toEqual(["API-5", "API-10", "API-1", "API-3", "API-11"]);
    expect(idsOf(await me(["issue", "list", "--ready", "--sort", "priority", "--desc", "--json"]))).toEqual(["API-3", "API-11", "API-1", "API-10", "API-5"]);
  });

  test("--mine・--assignee・--delegated は担当でさらに絞り、-w がなければすべての Workspace を見る", async () => {
    const { db, api, me } = await seed();
    expect(idsOf(await me(["issue", "list", "--ready", "--assignee", "none", "--json"]))).toEqual(["API-1", "API-3", "API-5", "API-11"]);
    expect((await me(["issue", "list", "--ready", "--mine", "--json"])).json).toEqual([]);
    await me(["issue", "update", "WEB-1", "--assignee", "claude-code"]);
    const llm = (args: string[]) => runNod(args, { cwd: api, db, actor: "claude-code" });
    // 着手中の API-7 は自分の担当でも出ない
    expect(idsOf(await llm(["issue", "list", "--ready", "--mine", "--json"]))).toEqual(["API-10", "WEB-1"]);
    expect(idsOf(await llm(["issue", "list", "--ready", "--mine", "-w", "API", "--json"]))).toEqual(["API-10"]);
    expect(idsOf(await me(["issue", "list", "--ready", "--delegated", "--json"]))).toEqual(["API-10", "WEB-1"]);
    const text = await me(["issue", "list", "--ready", "--delegated"]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("API-10");
    expect(text.stdout).toContain("WEB-1");
    expect(text.stdout).not.toContain("API-7");
  });

  test("-w でほかの Workspace の着手できる Issue を出す", async () => {
    const { me } = await seed();
    expect(idsOf(await me(["issue", "list", "--ready", "-w", "WEB", "--json"]))).toEqual(["WEB-1"]);
  });

  test("LLM も読める（読み取りのみで、Issue を変えない）", async () => {
    const { db, api, me } = await seed();
    const before = (await me(["issue", "list", "--all-workspaces", "--json"])).json;
    expect(idsOf(await runNod(["issue", "list", "--ready", "--json"], { cwd: api, db, actor: "claude-code" }))).toEqual(READY);
    expect((await me(["issue", "list", "--all-workspaces", "--json"])).json).toEqual(before);
  });
});
