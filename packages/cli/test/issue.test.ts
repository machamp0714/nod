import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommanderError } from "commander";
import { translateCommanderError } from "../src/main";
import { addWorktree, makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

let db: string;
let repo: string;
beforeAll(() => {
  db = tempDb();
  repo = makeRepo();
  registerRepo(db, repo);
});

const llm = (args: string[], cwd = repo) => runNod(args, { cwd, db, actor: "claude-code" });
const me = (args: string[], cwd = repo) => runNod(args, { cwd, db });

describe("Workspace の特定", () => {
  test("サブディレクトリから実行しても Workspace を見つける", async () => {
    const sub = join(repo, "packages", "foo");
    mkdirSync(sub, { recursive: true });
    const r = await llm(["issue", "create", "--json", "サブディレクトリから"], sub);
    expect(r.exitCode).toBe(0);
    expect(r.json.id).toMatch(/^API-\d+$/);
  });

  test("git worktree の中からは本体のリポジトリの Workspace を使う", async () => {
    const wt = addWorktree(repo, "feat-x");
    const r = await llm(["issue", "create", "--json", "worktree から"], wt);
    expect(r.exitCode).toBe(0);
    expect(r.json.id).toMatch(/^API-\d+$/);
  });

  test("git の外や未登録のリポジトリでは NOT_INITIALIZED、-w でキーを指定すれば外からも使える", async () => {
    const outside = await llm(["issue", "list", "--json"], tempDir());
    expect(outside.exitCode).toBe(1);
    expect(outside.json.error.code).toBe("NOT_INITIALIZED");
    const other = await llm(["issue", "list", "--json"], makeRepo("other"));
    expect(other.json.error.code).toBe("NOT_INITIALIZED");
    const byKey = await llm(["-w", "API", "issue", "list", "--json"], tempDir());
    expect(byKey.exitCode).toBe(0);
  });
});

describe("nod issue", () => {
  test("先頭が - のタイトルや質問も、-- の後ろに書けばそのまま保存する", async () => {
    const created = (await llm(["issue", "create", "--json", "--label", "bug", "--", "-p の扱いを直す"])).json;
    expect(created).toMatchObject({ title: "-p の扱いを直す", status: "triage", labels: ["bug"] });
    const asked = await llm(["issue", "ask", created.id, "--json", "--", "--force を外してよいか"]);
    expect(asked.exitCode).toBe(0);
    expect(asked.json.question.question).toBe("--force を外してよいか");
  });

  test("着手できる Issue がなければ null を返し、終了コードは0", async () => {
    const empty = makeRepo("empty");
    registerRepo(db, empty, "EMP");
    const r = await llm(["issue", "next", "--json"], empty);
    expect(r.exitCode).toBe(0);
    expect(r.json).toBeNull();
    expect((await llm(["issue", "next"], empty)).stdout).toContain("着手できる Issue はありません");
  });

  test("2つの LLM が同時に next を実行しても、1件は片方だけが取る", async () => {
    const race = makeRepo("race");
    registerRepo(db, race, "RAC");
    await me(["issue", "create", "--json", "取り合い"], race);
    const [a, b] = await Promise.all([
      runNod(["issue", "next", "--json"], { cwd: race, db, actor: "claude-code" }),
      runNod(["issue", "next", "--json"], { cwd: race, db, actor: "codex" }),
    ]);
    expect([a.exitCode, b.exitCode]).toEqual([0, 0]);
    expect([a.json, b.json].filter((x) => x !== null)).toHaveLength(1);
  });

  test("LLM の作業の流れ（next、log、fail、done）", async () => {
    const flow = makeRepo("flow");
    registerRepo(db, flow, "FLO");
    const created = (await me(["issue", "create", "--json", "流れ"], flow)).json;
    const picked = (await llm(["issue", "next", "--json"], flow)).json;
    expect(picked).toMatchObject({ id: created.id, status: "in_progress", agentState: "working", assignee: "claude-code" });
    expect((await llm(["issue", "log", created.id, "調べ始めた"], flow)).exitCode).toBe(0);
    expect((await llm(["issue", "fail", created.id, "テストが落ちる", "--json"], flow)).json.agentState).toBe("error");
    const done = (
      await llm(["issue", "done", created.id, "--summary", "直した", "--pr", "https://example.com/pull/1", "--json"], flow)
    ).json;
    expect(done).toMatchObject({ status: "in_review", agentState: "done", prUrl: "https://example.com/pull/1" });
  });

  test("計画書を取り込み、Step を進め、show に表示する", async () => {
    const created = (await me(["issue", "create", "--json", "計画つき"])).json;
    const path = join(tempDir(), "plan.md");
    writeFileSync(path, "# 実装計画\n\n### Task 1: 調べる\n\n- [ ] **Step 1: 読む**\n");
    expect((await llm(["issue", "plan", created.id, "--from", path, "--json"])).json.tasks).toHaveLength(1);
    expect((await llm(["issue", "step", created.id, "1.1", "done"])).exitCode).toBe(0);
    const text = (await llm(["issue", "show", created.id])).stdout;
    expect(text).toContain("1. [x] 調べる");
    expect(text).toContain("1.1 [x] 読む");
    expect(text).toContain("実装計画（plan）");
  });

  test("doc add で添付し、show --json の documents に出る", async () => {
    const created = (await me(["issue", "create", "--json", "設計つき"])).json;
    const dir = tempDir();
    writeFileSync(join(dir, "spec.md"), "# 検索の設計\n");
    const added = await me(["issue", "doc", "add", created.id, "spec.md", "--kind", "spec", "--json"], dir);
    expect(added.json).toMatchObject({ path: join(dir, "spec.md"), title: "検索の設計", kind: "spec" });
    expect((await me(["issue", "show", created.id, "--json"])).json.documents).toHaveLength(1);
  });

  test("引数の誤りは INVALID_ARGS、LLM の done への更新は FORBIDDEN_FOR_LLM", async () => {
    const badStatus = await llm(["issue", "list", "--status", "wip", "--json"]);
    expect(badStatus.exitCode).toBe(1);
    expect(badStatus.json.error.code).toBe("INVALID_ARGS");
    const unknown = await llm(["issue", "list", "--nope", "--json"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.json.error.code).toBe("INVALID_ARGS");
    const created = (await me(["issue", "create", "--json", "t"])).json;
    const forbidden = await llm(["issue", "update", created.id, "--status", "done", "--json"]);
    expect(forbidden.json.error.code).toBe("FORBIDDEN_FOR_LLM");
  });
});

describe("コメントのスレッド", () => {
  test("--reply-to で返信し、show にコメント ID と字下げした返信を出す", async () => {
    const created = (await me(["issue", "create", "--json", "スレッド"])).json;
    const root = (await me(["issue", "comment", created.id, "原因は？", "--json"])).json;
    expect(root.parentId).toBeNull();
    const reply = await llm(["issue", "comment", created.id, "N+1 でした", "--reply-to", String(root.id), "--json"]);
    expect(reply.exitCode).toBe(0);
    expect(reply.json).toMatchObject({ parentId: root.id, author: "claude-code" });
    const shown = await me(["issue", "show", created.id]);
    expect(shown.stdout).toContain(`#${root.id} me: 原因は？`);
    expect(shown.stdout).toContain(`↳ #${reply.json.id} claude-code: N+1 でした`);
    const missing = await me(["issue", "comment", created.id, "x", "--reply-to", "99999", "--json"]);
    expect([missing.exitCode, missing.json.error.code]).toEqual([1, "NOT_FOUND"]);
    const bad = await me(["issue", "comment", created.id, "x", "--reply-to", "abc", "--json"]);
    expect(bad.json.error.code).toBe("INVALID_ARGS");
  });
});

describe("ヘルプと終了コード", () => {
  test("サブコマンドを省くとヘルプを出して終了コード1、--json なら INVALID_ARGS", async () => {
    const bare = await llm(["issue"]);
    expect(bare.exitCode).toBe(1);
    expect(bare.stderr).toContain("Usage:");
    const json = await llm(["issue", "--json"]);
    expect(json.exitCode).toBe(1);
    expect(json.json.error.code).toBe("INVALID_ARGS");
  });

  test("--help を明示したときだけ終了コード0", async () => {
    const help = await llm(["issue", "--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("Usage:");
    expect((await llm(["--help"])).exitCode).toBe(0);
  });
});

describe("commander の引数の誤りを日本語で返す", () => {
  const cases: [string, string[], string][] = [
    ["引数の不足", ["issue", "show"], "id"],
    ["オプションの値の不足", ["issue", "list", "--status"], "--status"],
    ["必須オプションの不足", ["issue", "done", "API-1"], "--summary"],
    ["知らないオプション", ["issue", "list", "--nope"], "--nope"],
    ["知らないコマンド", ["issue", "nope"], "nope"],
  ];
  for (const [label, args, name] of cases) {
    test(`${label}: 標準エラーには nod の日本語のメッセージだけを出し、--json なら INVALID_ARGS`, async () => {
      const text = await llm(args);
      expect(text.exitCode).toBe(1);
      expect(text.stderr).toContain("エラー（INVALID_ARGS）");
      expect(text.stderr).toContain(name);
      expect(text.stderr).not.toContain("error:");
      expect(text.stderr).not.toContain("Usage:");
      const json = await llm([...args, "--json"]);
      expect(json.exitCode).toBe(1);
      expect(json.json.error.code).toBe("INVALID_ARGS");
      expect(json.json.error.message).toContain(name);
      expect(json.json.error.message).not.toContain("error:");
      expect(json.stderr).toBe("");
    });
  }

  test("サブコマンドを省いたときは、ヘルプに続けて日本語のメッセージを出す", async () => {
    const bare = await llm(["issue"]);
    expect(bare.exitCode).toBe(1);
    expect(bare.stderr).toContain("Usage:");
    expect(bare.stderr).toContain("サブコマンドを指定してください");
    const json = await llm(["issue", "--json"]);
    expect(json.json.error.message).toBe("サブコマンドを指定してください");
  });
});

describe("translateCommanderError", () => {
  test("7 種類の誤りを、誤った名前を含む日本語にする", () => {
    const cases: [string, string, string[]][] = [
      ["commander.missingArgument", "error: missing required argument 'id'", ["id"]],
      ["commander.optionMissingArgument", "error: option '--status <list>' argument missing", ["--status <list>"]],
      ["commander.missingMandatoryOptionValue", "error: required option '--summary <text>' not specified", ["--summary <text>"]],
      ["commander.unknownOption", "error: unknown option '--nope'\n(Did you mean --no?)", ["--nope"]],
      ["commander.unknownCommand", "error: unknown command 'nope'", ["nope"]],
      [
        "commander.excessArguments",
        "error: too many arguments for 'list'. Expected 0 arguments but got 2.",
        ["list", "0", "2"],
      ],
      [
        "commander.invalidArgument",
        "error: option '-p, --priority <n>' argument 'x' is invalid. bad",
        ["-p, --priority <n>", "x"],
      ],
      [
        "commander.invalidArgument",
        "error: command-argument value 'x' is invalid for argument 'status'. bad",
        ["status", "x"],
      ],
    ];
    for (const [code, message, names] of cases) {
      const e = translateCommanderError(new CommanderError(1, code, message));
      expect(e.code).toBe("INVALID_ARGS");
      expect(e.message).not.toContain("error:");
      expect(e.message).not.toContain("Did you mean");
      for (const n of names) expect(e.message).toContain(n);
    }
  });
});

test("discovered-from は親と独立した正規化起票元を作り、不正参照では採番しない", async () => {
  const parent = (await me(["issue", "create", "親", "--json"])).json;
  const source = (await me(["issue", "create", "元の調査", "--json"])).json;
  const bad = await llm(["issue", "create", "不正な起票元", "--discovered-from", "API-999999", "--json"]);
  expect(bad.exitCode).toBe(1);
  expect(bad.json.error.code).toBe("NOT_FOUND");
  const created = (await llm(["issue", "create", "見つけた不具合", "--parent", parent.id, "--discovered-from", source.id.toLowerCase(), "--json"])).json;
  expect(created.number).toBe(source.number + 1);
  const shown = (await me(["issue", "show", created.id, "--json"])).json;
  expect(shown.parentId).toBe(parent.id);
  expect(shown.activity.find((a: any) => a.type === "created").data.discovered_from).toBe(source.id);
});
