import { beforeAll, describe, expect, test } from "bun:test";
import { makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

let db: string;
let api: string;
let web: string;
const ids: Record<string, string> = {};
const questions: Record<string, number> = {};

const run = (args: string[], cwd = api, actor?: string) => runNod(args, { cwd, db, actor });
const me = (args: string[], cwd = api) => run([...args, "--json"], cwd);
const llm = (args: string[], cwd = api) => run([...args, "--json"], cwd, "claude-code");
const listed = (r: { json: { questions: { issueId: string; question: string }[] } }) => r.json.questions.map((q) => q.question);

// API: 設問（Project 調査票・High・me の未決事項 2 件）、検索（LLM の質問 1 件で入力待ち）、未決事項なし
// WEB: 画面（me の未決事項 1 件）
beforeAll(async () => {
  db = tempDb();
  api = makeRepo("api-server");
  web = makeRepo("web");
  registerRepo(db, api, "API");
  registerRepo(db, web, "WEB");
  await me(["project", "create", "調査票"]);
  ids.survey = (await me(["issue", "create", "設問を決める", "--project", "調査票", "-p", "2"])).json.id;
  ids.search = (await me(["issue", "create", "検索を速くする"])).json.id;
  ids.plain = (await me(["issue", "create", "未決事項なし"])).json.id;
  ids.screen = (await me(["issue", "create", "画面の配色"], web)).json.id;
  questions.required = (await me(["issue", "ask", ids.survey!, "Q3 は必須にするか"])).json.question.id;
  questions.due = (await me(["issue", "ask", ids.survey!, "回答期限はいつか"])).json.question.id;
  await llm(["issue", "start", ids.search!]);
  questions.index = (await llm(["issue", "ask", ids.search!, "インデックスを足してよいか"])).json.question.id;
  questions.color = (await me(["issue", "ask", ids.screen!, "ボタンの色"], web)).json.question.id;
});

describe("nod questions", () => {
  test("既定ではすべての Workspace の未回答の未決事項を、人が付けたものも含めて出す", async () => {
    const r = await me(["questions"], tempDir());
    expect(r.exitCode).toBe(0);
    expect(r.json).toMatchObject({ total: 4, issueCount: 3, more: 0 });
    expect(listed(r)).toEqual(["Q3 は必須にするか", "回答期限はいつか", "インデックスを足してよいか", "ボタンの色"]);
    expect(r.json.questions[0]).toMatchObject({
      id: questions.required,
      issueId: ids.survey,
      issueTitle: "設問を決める",
      workspace: "API",
      status: "needs_clarification",
      priority: 2,
      project: { name: "調査票" },
      askedBy: "me",
      questionCount: { answered: 0, total: 2 },
    });
  });

  test("質問者・Workspace・Project・ステータス・検索・件数で絞る", async () => {
    expect(listed(await me(["questions", "--asked-by", "me"]))).toEqual(["Q3 は必須にするか", "回答期限はいつか", "ボタンの色"]);
    expect(listed(await me(["questions", "--asked-by", "llm"]))).toEqual(["インデックスを足してよいか"]);
    expect(listed(await me(["-w", "WEB", "questions"]))).toEqual(["ボタンの色"]);
    expect(listed(await me(["questions", "--project", "調査票"]))).toEqual(["Q3 は必須にするか", "回答期限はいつか"]);
    expect(listed(await me(["questions", "-s", "in_progress"]))).toEqual(["インデックスを足してよいか"]);
    expect(listed(await me(["questions", "--query", "期限"]))).toEqual(["回答期限はいつか"]);
    const limited = await me(["questions", "--limit", "1"]);
    expect(limited.json).toMatchObject({ total: 4, issueCount: 3, more: 2 });
    expect(listed(limited)).toEqual(["Q3 は必須にするか", "回答期限はいつか"]);
  });

  test("不正な指定は INVALID_ARGS、登録のない Workspace は NOT_INITIALIZED", async () => {
    expect((await me(["questions", "--asked-by", "codex"])).json.error.code).toBe("INVALID_ARGS");
    expect((await me(["questions", "--limit", "0"])).json.error.code).toBe("INVALID_ARGS");
    expect((await me(["questions", "-s", "done"])).json.error.code).toBe("INVALID_ARGS");
    expect((await me(["-w", "NOPE", "questions"])).json.error.code).toBe("NOT_INITIALIZED");
  });

  test("テキストでは Issue ごとにまとめ、決定数 / 総数と質問の id、回答のしかたを出す", async () => {
    const r = await run(["questions"]);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("未回答の未決事項 4 件（3 Issue）");
    expect(lines[1]).toMatch(new RegExp(`^${ids.survey}  Needs Clarification +設問を決める  \\[未決 0/2\\]$`));
    expect(lines[2]).toMatch(new RegExp(`^  #${questions.required} Q3 は必須にするか（me・\\d{4}-\\d{2}-\\d{2}）$`));
    expect(lines[3]).toMatch(new RegExp(`^  #${questions.due} 回答期限はいつか（me・`));
    expect(lines[4]).toMatch(new RegExp(`^${ids.search}  In Progress +検索を速くする  \\[未決 0/1\\]$`));
    expect(lines[5]).toMatch(new RegExp(`^  #${questions.index} インデックスを足してよいか（claude-code・`));
    expect(lines.at(-2)).toBe("");
    expect(lines.at(-1)).toBe("回答: nod answer <Issue の ID> <回答> --question <#番号>");

    const limited = (await run(["questions", "--limit", "1"])).stdout;
    expect(limited).toContain("ほか 2 Issue");
    expect((await run(["questions", "--query", "どれにも合わない"])).stdout.trim()).toBe("未回答の未決事項はありません");
  });

  test("手引きに nod questions がある", async () => {
    expect((await run(["skills", "get", "nod"])).stdout).toContain("nod questions [--asked-by me|llm]");
  });

  test("LLM も一覧は読める", async () => {
    const r = await llm(["questions", "--asked-by", "me"]);
    expect(r.exitCode).toBe(0);
    expect(r.json.total).toBe(3);
  });
});

describe("nod issue list の未決事項の件数", () => {
  test("未決事項のある Issue の行に決定数 / 総数を付け、ない Issue には付けない", async () => {
    const lines = (await run(["issue", "list"])).stdout.trimEnd().split("\n");
    expect(lines.find((l) => l.startsWith(ids.survey!))).toMatch(/設問を決める {2}\[未決 0\/2\]$/);
    expect(lines.find((l) => l.startsWith(ids.search!))).toMatch(/検索を速くする {2}\[未決 0\/1\]$/);
    expect(lines.find((l) => l.startsWith(ids.plain!))).toMatch(/未決事項なし$/);
    const clarification = (await run(["issue", "list", "-s", "needs_clarification"])).stdout.trimEnd().split("\n");
    expect(clarification).toHaveLength(1);
    expect(clarification[0]).toContain("[未決 0/2]");
  });

  test("JSON の形と、一覧以外の1行表示は変えない", async () => {
    const json = (await me(["issue", "list"])).json as { id: string; questionCount: unknown }[];
    expect(json.find((i) => i.id === ids.survey)!.questionCount).toEqual({ answered: 0, total: 2 });
    const asked = await run(["issue", "ask", ids.survey!, "Q3 は必須にするか"]);
    expect(asked.stdout).not.toContain("[未決");
  });
});

describe("一覧からの回答", () => {
  test("nod answer --question で1つ決めると一覧から消え、件数が進む。すべて決めると Issue ごと消える", async () => {
    const first = await me(["answer", ids.survey!, "必須にする", "--question", String(questions.required)]);
    expect(first.exitCode).toBe(0);
    expect(listed(await me(["questions", "--project", "調査票"]))).toEqual(["回答期限はいつか"]);
    expect((await run(["questions", "--project", "調査票"])).stdout).toContain("[未決 1/2]");
    expect((await run(["issue", "list", "-s", "needs_clarification"])).stdout).toContain("[未決 1/2]");

    await me(["answer", ids.survey!, "10月末", "--question", String(questions.due)]);
    expect((await me(["questions", "--project", "調査票"])).json).toMatchObject({ total: 0, issueCount: 0, questions: [] });
    const line = (await run(["issue", "list"])).stdout.split("\n").find((l) => l.startsWith(ids.survey!));
    expect(line).toMatch(/\[未決 2\/2\]$/);
  });
});
