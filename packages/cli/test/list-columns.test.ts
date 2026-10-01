import { describe, expect, test } from "bun:test";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

// API-1 Low/todo/Project「検索」、API-2 Urgent/backlog、API-3 なし/todo、API-4 High/in_progress（claude-code が着手）/Project は長い名前、API-5 Urgent/todo
// WEB-1 Medium/todo
const LONG_PROJECT = "とても長い名前の Project を端末で切る";

async function seed() {
  const db = tempDb();
  const api = makeRepo("api-server");
  const web = makeRepo("web");
  registerRepo(db, api, "API");
  registerRepo(db, web, "WEB");
  const me = (args: string[], cwd = api) => runNod(args, { cwd, db });
  await me(["project", "create", "検索"]);
  await me(["project", "create", LONG_PROJECT]);
  await me(["issue", "create", "e", "--priority", "4", "--project", "検索", "--estimate", "5"]);
  await me(["issue", "create", "d", "--priority", "1"]);
  await me(["issue", "create", "c"]);
  await me(["issue", "create", "b", "--priority", "2", "--project", LONG_PROJECT]);
  await me(["issue", "create", "a", "--priority", "1", "--estimate", "2"]);
  await me(["issue", "create", "w", "--priority", "3"], web);
  await me(["issue", "update", "API-2", "--status", "backlog"]);
  await runNod(["issue", "start", "API-4"], { cwd: api, db, actor: "claude-code" });
  return { db, api, web, me };
}

const idsOf = (r: { json: { id: string }[] }) => r.json.map((i) => i.id);

describe("nod issue list の列（#174）", () => {
  test("ID・状態・優先度・Project・タイトルの順に出し、列をそろえる", async () => {
    const { me } = await seed();
    const r = await me(["issue", "list"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trimEnd().split("\n")).toEqual([
      "API-1  Todo                   Low     検索                  e",
      "API-2  Backlog                Urgent  -                     d",
      "API-3  Todo                   -       -                     c",
      "API-4  In Progress [working]  High    とても長い名前の Pr…  b",
      "API-5  Todo                   Urgent  -                     a",
    ]);
  });

  test("アーカイブ済みの [archived] も状態とひとまとまりで幅をそろえる", async () => {
    const { me } = await seed();
    await me(["issue", "update", "API-3", "--status", "done"]);
    await me(["issue", "archive", "API-3"]);
    expect((await me(["issue", "list", "--archived"])).stdout.trimEnd()).toBe("API-3  Done        [archived]  -       -  c");
  });

  test("未決事項のある行は、行末（[完了候補] の後ろ）に [未決 決定数/総数] を付ける（#173）", async () => {
    const { me } = await seed();
    await me(["issue", "ask", "API-5", "色はどうするか"]);
    await me(["issue", "ask", "API-5", "期限はいつか"]);
    const line = (await me(["issue", "list", "--json"])).json.find((i: { id: string }) => i.id === "API-5");
    expect(line.questionCount).toEqual({ answered: 0, total: 2 });
    const text = (await me(["issue", "list"])).stdout.trimEnd().split("\n");
    expect(text.find((l) => l.startsWith("API-5"))).toMatch(/  a  \[未決 0\/2\]$/);
    expect(text.find((l) => l.startsWith("API-1"))).toMatch(/  e$/);
  });

  test("Project のある Issue がなければ Project の列は - だけの幅にする", async () => {
    const { me, web } = await seed();
    expect((await me(["issue", "list"], web)).stdout.trimEnd()).toBe("WEB-1  Todo         Medium  -  w");
  });

  test("1行表示（起票など）と --json の形は変えない", async () => {
    const { me } = await seed();
    const created = await me(["issue", "create", "新規", "--priority", "2"]);
    expect(created.stdout.trimEnd()).toBe("起票しました: API-6  Todo         新規");
    const json = (await me(["issue", "list", "--json"])).json;
    expect(json[0]).toMatchObject({ id: "API-1", priority: 4, project: { name: "検索" } });
    expect(idsOf({ json })).toEqual(["API-1", "API-2", "API-3", "API-4", "API-5", "API-6"]);
  });

  test("--delegated の行にも優先度と Project を出す", async () => {
    const { me } = await seed();
    const lines = (await me(["issue", "list", "--delegated"])).stdout.trimEnd().split("\n");
    expect(lines).toEqual(["claude-code（1件: 作業中 1）", "  API-4  In Progress [working]  High    とても長い名前の Pr…  b"]);
  });

  test("--delegated の行にも [未決 決定数/総数] を付ける（#173）", async () => {
    const { me } = await seed();
    await me(["issue", "update", "API-1", "--assignee", "claude-code"]);
    await me(["issue", "ask", "API-1", "色はどうするか"]);
    const lines = (await me(["issue", "list", "--delegated"])).stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^claude-code（2件: /);
    expect(lines.find((l) => l.includes("API-1"))).toMatch(/^  API-1  .+  e  \[未決 0\/1\]$/);
    expect(lines.find((l) => l.includes("API-4"))).toMatch(/  b$/);
  });
});

describe("nod issue list --priority", () => {
  test("数値・P 付き・名前で絞り、繰り返しとカンマ区切りはどれかに合うものを返す", async () => {
    const { me } = await seed();
    expect(idsOf(await me(["issue", "list", "--priority", "1", "--json"]))).toEqual(["API-2", "API-5"]);
    expect(idsOf(await me(["issue", "list", "--priority", "urgent,High", "--json"]))).toEqual(["API-2", "API-4", "API-5"]);
    expect(idsOf(await me(["issue", "list", "--priority", "P4", "--priority", "none", "--json"]))).toEqual(["API-1", "API-3"]);
    expect(idsOf(await me(["issue", "list", "--priority", "0", "--json"]))).toEqual(["API-3"]);
    expect(idsOf(await me(["issue", "list", "--priority", "1", "--status", "todo", "--json"]))).toEqual(["API-5"]);
    expect(idsOf(await me(["issue", "list", "--priority", "medium", "--all-workspaces", "--json"]))).toEqual(["WEB-1"]);
  });

  test("知らない値と空は INVALID_ARGS", async () => {
    const { me } = await seed();
    for (const value of ["5", "critical", ",", "", "P5"]) {
      const r = await me(["issue", "list", "--priority", value, "--json"]);
      expect(r.exitCode).toBe(1);
      expect(r.json.error.code).toBe("INVALID_ARGS");
      expect(r.json.error.message).toContain("P0〜P4");
    }
  });
});

describe("nod issue list --sort", () => {
  test("既定は ID の順のまま。default は 状態 → 優先度 → ID", async () => {
    const { me } = await seed();
    expect(idsOf(await me(["issue", "list", "--json"]))).toEqual(["API-1", "API-2", "API-3", "API-4", "API-5"]);
    expect(idsOf(await me(["issue", "list", "--sort", "id", "--json"]))).toEqual(["API-1", "API-2", "API-3", "API-4", "API-5"]);
    expect(idsOf(await me(["issue", "list", "--sort", "default", "--json"]))).toEqual(["API-2", "API-5", "API-1", "API-3", "API-4"]);
  });

  test("priority・estimate を --desc と組み合わせられ、テキストも同じ順で出す", async () => {
    const { me } = await seed();
    expect(idsOf(await me(["issue", "list", "--sort", "priority", "--json"]))).toEqual(["API-2", "API-5", "API-4", "API-1", "API-3"]);
    expect(idsOf(await me(["issue", "list", "--sort", "priority", "--desc", "--json"]))).toEqual(["API-3", "API-1", "API-4", "API-2", "API-5"]);
    expect(idsOf(await me(["issue", "list", "--sort", "estimate", "--desc", "--json"]))).toEqual(["API-1", "API-5", "API-2", "API-3", "API-4"]);
    expect(idsOf(await me(["issue", "list", "--desc", "--json"]))).toEqual(["API-5", "API-4", "API-3", "API-2", "API-1"]);
    const text = (await me(["issue", "list", "--sort", "priority"])).stdout.trimEnd().split("\n").map((line) => line.slice(0, 5));
    expect(text).toEqual(["API-2", "API-5", "API-4", "API-1", "API-3"]);
  });

  test("--delegated では担当ごとの見出しの中で並べる", async () => {
    const { me } = await seed();
    await me(["issue", "update", "API-1", "--assignee", "claude-code"]);
    await me(["issue", "update", "API-5", "--assignee", "codex"]);
    expect((await me(["issue", "list", "--delegated", "--sort", "priority", "--json"])).json.map((i: { id: string; assignee: string }) => [i.assignee, i.id])).toEqual([
      ["claude-code", "API-4"],
      ["claude-code", "API-1"],
      ["codex", "API-5"],
    ]);
  });

  test("知らない並び順は INVALID_ARGS", async () => {
    const { me } = await seed();
    const r = await me(["issue", "list", "--sort", "status", "--json"]);
    expect(r.exitCode).toBe(1);
    expect(r.json.error.code).toBe("INVALID_ARGS");
  });
});
