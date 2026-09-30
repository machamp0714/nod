import { describe, expect, test } from "bun:test";
import type { OpCtx } from "../src/ctx";
import { openDb } from "../src/db";
import { GITHUB_IMPORT_LIMIT_MAX, importGithubIssues } from "../src/ops/github-import";
import { getIssue, updateIssue } from "../src/ops/issues";
import { createProject } from "../src/ops/projects";
import { completionStats } from "../src/ops/stats";
import { recentSummary } from "../src/ops/summary";
import type { GhRunner, GhRunResult } from "../src/ops/pr-status";
import { initWorkspace } from "../src/ops/workspaces";
import { setTransitionRules } from "../src/transition-rules";
import { eventsOf, tempDbPath } from "./helpers";

// 実際の gh・GitHub には触れず、gh issue list / view の出力を返すスタブで取り込む
interface GhIssue {
  number: number;
  title: string;
  body?: string;
  state?: "OPEN" | "CLOSED";
  stateReason?: string | null;
  labels?: string[];
  assignees?: string[];
  author?: string | null;
  createdAt?: string;
  closedAt?: string | null;
  comments?: { author: string | null; body: string; createdAt: string }[];
}

function listJson(issues: GhIssue[], repo = "Example/API-Server"): string {
  return JSON.stringify(
    issues.map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body ?? "",
      state: i.state ?? "OPEN",
      stateReason: i.stateReason ?? (i.state === "CLOSED" ? "COMPLETED" : ""),
      labels: (i.labels ?? []).map((name) => ({ id: `L_${name}`, name, color: "ffffff", description: "" })),
      assignees: (i.assignees ?? []).map((login) => ({ id: `U_${login}`, login, name: login })),
      author: i.author === null ? null : { login: i.author ?? "octocat", is_bot: false },
      createdAt: i.createdAt ?? "2026-01-02T03:04:05Z",
      closedAt: i.closedAt ?? null,
      url: `https://github.com/${repo}/issues/${i.number}`,
    })),
  );
}

function viewJson(i: GhIssue): string {
  return JSON.stringify({
    comments: (i.comments ?? []).map((c) => ({ author: c.author === null ? null : { login: c.author }, body: c.body, createdAt: c.createdAt })),
  });
}

const exited = (stdout: string, exitCode = 0, stderr = ""): GhRunResult => ({ kind: "exited", exitCode, stdout, stderr });

// list は issues を返し、view <number> はその Issue のコメントを返す。fail に入れた番号の view は失敗させる
function fakeGh(issues: GhIssue[], opts: { fail?: number[]; list?: GhRunResult } = {}): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push(args);
    if (args[1] === "list") return opts.list ?? exited(listJson(issues));
    const n = Number(args[2]);
    if (opts.fail?.includes(n)) return exited("", 1, "HTTP 502: Bad Gateway");
    const issue = issues.find((i) => i.number === n);
    return issue ? exited(viewJson(issue)) : exited("", 1, "Could not resolve to an Issue");
  };
  return Object.assign(run, { calls });
}

function fixture() {
  const db = openDb(tempDbPath());
  const ws = initWorkspace(db, { path: "/tmp/repos/api-server", key: "API" }).workspace;
  const me: OpCtx = { db, actor: "me" };
  const llm: OpCtx = { db, actor: "claude-code" };
  return { db, ws, me, llm };
}

async function rejects(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

const SAMPLE: GhIssue[] = [
  {
    number: 12,
    title: "ログインが遅い",
    body: "再現手順あり",
    labels: ["bug", "p1"],
    assignees: ["alice"],
    author: "bob",
    createdAt: "2026-03-01T00:00:00Z",
    comments: [
      { author: "carol", body: "こちらでも再現", createdAt: "2026-03-02T00:00:00Z" },
      { author: null, body: "退会したユーザー", createdAt: "2026-03-03T00:00:00Z" },
    ],
  },
  { number: 5, title: "完了した件", state: "CLOSED", stateReason: "COMPLETED", closedAt: "2026-02-01T00:00:00Z" },
  { number: 7, title: "やらない件", state: "CLOSED", stateReason: "NOT_PLANNED", closedAt: "2026-02-02T00:00:00Z" },
];

describe("importGithubIssues", () => {
  test("--dry-run は gh issue list だけを読み、状態の対応を提案して何も書かない（LLM も可）", async () => {
    const { db, llm } = fixture();
    const gh = fakeGh(SAMPLE);
    const r = await importGithubIssues(llm, "API", "example/api-server", { dryRun: true, state: "all" }, gh);
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]).toEqual([
      "issue",
      "list",
      "-R",
      "example/api-server",
      "--state",
      "all",
      "--limit",
      "50",
      "--json",
      "number,title,body,state,stateReason,labels,assignees,author,createdAt,closedAt,url",
    ]);
    expect(r.dryRun).toBe(true);
    // 古い番号順に並べ、nod の連番が GitHub の順になるようにする
    expect(r.items.map((i) => [i.sourceKey, i.status, i.existing])).toEqual([
      ["example/api-server#5", "done", null],
      ["example/api-server#7", "canceled", null],
      ["example/api-server#12", "triage", null],
    ]);
    expect(r.items[2]!.labels).toEqual(["bug", "p1"]);
    expect(r.imported).toEqual([]);
    expect((db.query("SELECT count(*) AS n FROM issues").get() as { n: number }).n).toBe(0);
    expect((db.query("SELECT count(*) AS n FROM issue_imports").get() as { n: number }).n).toBe(0);
  });

  test("実行は人だけ。LLM は gh を起動する前に FORBIDDEN_FOR_LLM で止まる", async () => {
    const { llm } = fixture();
    const gh = fakeGh(SAMPLE);
    expect(await rejects(importGithubIssues(llm, "API", "example/api-server", {}, gh))).toBe("FORBIDDEN_FOR_LLM");
    expect(gh.calls).toHaveLength(0);
  });

  test("タイトル・本文・ラベル・状態・コメント（作者名付き）・作成日時を取り込み、対応表に残す", async () => {
    const { db, me } = fixture();
    const project = createProject(me, { name: "移行" });
    const gh = fakeGh(SAMPLE);
    const r = await importGithubIssues(me, "API", "example/api-server", { state: "all", projectRef: String(project.id) }, gh);
    expect(r.imported).toEqual([
      { sourceKey: "example/api-server#5", id: "API-1" },
      { sourceKey: "example/api-server#7", id: "API-2" },
      { sourceKey: "example/api-server#12", id: "API-3" },
    ]);
    expect(r.failed).toEqual([]);
    // コメントは実行時に1件ずつ gh issue view で読む（GitHub へは読み取りのみ）
    expect(gh.calls.slice(1)).toEqual([5, 7, 12].map((n) => ["issue", "view", String(n), "-R", "example/api-server", "--json", "comments"]));

    const open = getIssue(db, "API-3");
    expect(open.title).toBe("ログインが遅い");
    expect(open.status).toBe("triage");
    expect(open.labels).toEqual(["bug", "p1"]);
    expect(open.assignee).toBeNull(); // GitHub の担当は写さず、本文末尾に記録する
    expect(open.project?.name).toBe("移行");
    expect(open.createdBy).toBe("me");
    expect(open.description).toStartWith("再現手順あり\n\n---\n");
    expect(open.description).toContain("取り込み元: https://github.com/Example/API-Server/issues/12");
    expect(open.description).toContain("@bob が 2026-03-01T00:00:00Z に作成");
    expect(open.description).toContain("担当（GitHub）: @alice");
    const comments = open.activity.filter((a) => a.kind === "comment");
    expect(comments.map((c) => (c as { actor: string }).actor)).toEqual(["me", "me"]);
    expect(comments.map((c) => (c as { body: string }).body)).toEqual([
      "@carol が GitHub でコメント（2026-03-02T00:00:00Z）\n\nこちらでも再現",
      "@ghost が GitHub でコメント（2026-03-03T00:00:00Z）\n\n退会したユーザー",
    ]);
    const created = eventsOf(db, "API-3").find((e) => e.type === "created");
    expect(created?.data).toMatchObject({
      status: "triage",
      imported_from: "https://github.com/Example/API-Server/issues/12",
      github_created_at: "2026-03-01T00:00:00Z",
    });

    const done = getIssue(db, "API-1");
    expect(done.status).toBe("done");
    expect(done.closeReason).toBeNull(); // 理由は canceled のときだけ付ける
    expect(done.description).toContain("2026-02-01T00:00:00Z に close");
    const canceled = getIssue(db, "API-2");
    expect(canceled.status).toBe("canceled");
    expect(canceled.closeReason).toBe("GitHub で close（NOT_PLANNED）");
    const closedAt = (db.query("SELECT closed_at FROM issues WHERE number = 1").get() as { closed_at: string | null }).closed_at;
    expect(closedAt).not.toBeNull(); // nod の日時は取り込んだ時刻（GitHub の日時は本文と created の由来に残す）
    expect(closedAt).not.toBe("2026-02-01T00:00:00Z");

    // 取り込んだ人自身には通知しない（大量に取り込んでも Inbox を埋めない）
    expect((db.query("SELECT count(*) AS n FROM notifications").get() as { n: number }).n).toBe(0);
    const rows = db.query("SELECT source, source_key, imported_by FROM issue_imports ORDER BY id").all();
    expect(rows).toEqual([
      { source: "github", source_key: "example/api-server#5", imported_by: "me" },
      { source: "github", source_key: "example/api-server#7", imported_by: "me" },
      { source: "github", source_key: "example/api-server#12", imported_by: "me" },
    ]);
  });

  test("close の理由が NOT_PLANNED・DUPLICATE なら canceled、COMPLETED・null・空なら done", async () => {
    const { me } = fixture();
    const issues: GhIssue[] = [
      { number: 1, title: "完了", state: "CLOSED", stateReason: "COMPLETED" },
      { number: 2, title: "理由なし", state: "CLOSED", stateReason: null },
      { number: 3, title: "理由が空", state: "CLOSED", stateReason: "" },
      { number: 4, title: "やらない", state: "CLOSED", stateReason: "NOT_PLANNED" },
      { number: 5, title: "重複", state: "CLOSED", stateReason: "DUPLICATE" },
    ];
    // listJson は stateReason の null を COMPLETED に埋めるので、null はそのまま返す
    const list = JSON.parse(listJson(issues)) as { number: number; stateReason: string | null }[];
    list[1]!.stateReason = null;
    const r = await importGithubIssues(me, "API", "example/api-server", { dryRun: true, state: "all" }, fakeGh(issues, { list: exited(JSON.stringify(list)) }));
    expect(r.items.map((i) => [i.number, i.stateReason, i.status])).toEqual([
      [1, "COMPLETED", "done"],
      [2, null, "done"],
      [3, null, "done"],
      [4, "NOT_PLANNED", "canceled"],
      [5, "DUPLICATE", "canceled"],
    ]);
  });

  test("閉じた Issue は状態の遷移を経ずに最初から done・canceled で作り、close_reason は canceled だけに付ける", async () => {
    const { db, me } = fixture();
    await importGithubIssues(me, "API", "example/api-server", { state: "all" }, fakeGh(SAMPLE));
    for (const [ref, status] of [["API-1", "done"], ["API-2", "canceled"]] as const) {
      const events = eventsOf(db, ref);
      expect(events.filter((e) => e.type === "status_changed")).toEqual([]);
      expect(events.find((e) => e.type === "created")?.data).toMatchObject({ status });
      expect(getIssue(db, ref).status).toBe(status);
    }
    const rows = db.query("SELECT number, closed_at, close_reason FROM issues ORDER BY number").all() as
      { number: number; closed_at: string | null; close_reason: string | null }[];
    expect(rows.map((r) => [r.number, r.closed_at !== null, r.close_reason])).toEqual([
      [1, true, null],
      [2, true, "GitHub で close（NOT_PLANNED）"],
      [3, false, null],
    ]);
  });

  test("遷移ルール（#73）で todo から done・canceled を禁じていても、閉じた Issue は遷移を経ないので取り込める", async () => {
    const { db, me } = fixture();
    setTransitionRules(me, "API", { forbidden: [{ from: "todo", to: "done" }, { from: "todo", to: "canceled" }], presets: [] });
    const r = await importGithubIssues(me, "API", "example/api-server", { state: "all" }, fakeGh(SAMPLE));
    expect(r.failed).toEqual([]);
    expect(["API-1", "API-2", "API-3"].map((ref) => getIssue(db, ref).status)).toEqual(["done", "canceled", "triage"]);
  });

  test("取り込んだ時点で閉じていた Issue は完了数（stats）と要約の完了・キャンセルに数えない。取り込み後に閉じ直したものは数える", async () => {
    const { db, me } = fixture();
    await importGithubIssues(me, "API", "example/api-server", { state: "all" }, fakeGh(SAMPLE));
    const today = new Date().toISOString().slice(0, 10);
    const range = { tz: "UTC", by: "day" as const, from: today, to: today };
    expect(completionStats(db, range).totals).toMatchObject({ completed: 0, canceled: 0 });
    const summary = recentSummary(db);
    const count = (kind: string) => summary.sections.find((s) => s.kind === kind)!.total;
    expect([count("completed"), count("canceled"), count("created")]).toEqual([0, 0, 3]);

    // 取り込んだ open の Issue を nod で完了し、取り込み済みの done を開き直して閉じ直すと、どちらも数える
    updateIssue(me, "API-3", { status: "done" });
    updateIssue(me, "API-1", { status: "todo" });
    updateIssue(me, "API-1", { status: "done" });
    expect(completionStats(db, range).totals).toMatchObject({ completed: 2, canceled: 0 });
    const after = recentSummary(db);
    expect(after.sections.find((s) => s.kind === "completed")!.total).toBe(2);
  });

  test("nod で永久削除した取り込み済みの Issue は、再取り込みで作り直さず削除済みとしてスキップする", async () => {
    const { db, me } = fixture();
    await importGithubIssues(me, "API", "example/api-server", {}, fakeGh(SAMPLE.slice(0, 1)));
    db.query("DELETE FROM issues WHERE number = 1").run();
    expect(db.query("SELECT source_key, issue_id FROM issue_imports").all()).toEqual([
      { source_key: "example/api-server#12", issue_id: null },
    ]);
    const dry = await importGithubIssues(me, "API", "example/api-server", { dryRun: true }, fakeGh(SAMPLE.slice(0, 1)));
    expect(dry.items.map((i) => [i.sourceKey, i.existing, i.deleted])).toEqual([["example/api-server#12", null, true]]);
    const gh = fakeGh(SAMPLE.slice(0, 1));
    const r = await importGithubIssues(me, "API", "example/api-server", {}, gh);
    expect(r.imported).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.deleted).toEqual([{ sourceKey: "example/api-server#12" }]);
    expect(r.failed).toEqual([]);
    expect(gh.calls.filter((c) => c[1] === "view")).toEqual([]);
    expect((db.query("SELECT count(*) AS n FROM issues").get() as { n: number }).n).toBe(0);
  });

  test("再実行では取り込み済みを重複作成せず、上書きもしない。大文字小文字違いの指定でも同じ Issue とみなす", async () => {
    const { db, me } = fixture();
    await importGithubIssues(me, "API", "example/api-server", {}, fakeGh(SAMPLE.slice(0, 1)));
    db.query("UPDATE issues SET title = '手で直した' WHERE number = 1").run();
    const changed = [{ ...SAMPLE[0]!, title: "GitHub で改題" }, { number: 20, title: "新しい件" }];
    const dry = await importGithubIssues(me, "API", "EXAMPLE/api-server", { dryRun: true }, fakeGh(changed));
    expect(dry.items.map((i) => [i.sourceKey, i.existing])).toEqual([
      ["example/api-server#12", "API-1"],
      ["example/api-server#20", null],
    ]);
    const gh = fakeGh(changed);
    const r = await importGithubIssues(me, "API", "EXAMPLE/api-server", {}, gh);
    expect(r.skipped).toEqual([{ sourceKey: "example/api-server#12", id: "API-1" }]);
    expect(r.imported).toEqual([{ sourceKey: "example/api-server#20", id: "API-2" }]);
    expect(gh.calls.filter((c) => c[1] === "view").map((c) => c[2])).toEqual(["20"]); // 取り込み済みのコメントは読まない
    expect(getIssue(db, "API-1").title).toBe("手で直した");
    expect((db.query("SELECT count(*) AS n FROM comments WHERE issue_id = 1").get() as { n: number }).n).toBe(2);
  });

  test("1件ごとに確定し、失敗しても残りを続ける。失敗した件は再実行で取り込める", async () => {
    const { db, me } = fixture();
    const issues: GhIssue[] = [{ number: 1, title: "一" }, { number: 2, title: "二" }, { number: 3, title: "三" }];
    const r = await importGithubIssues(me, "API", "example/api-server", {}, fakeGh(issues, { fail: [2] }));
    expect(r.imported.map((i) => i.sourceKey)).toEqual(["example/api-server#1", "example/api-server#3"]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.sourceKey).toBe("example/api-server#2");
    expect(r.failed[0]!.message).toContain("HTTP 502");
    expect((db.query("SELECT count(*) AS n FROM issues").get() as { n: number }).n).toBe(2);

    const again = await importGithubIssues(me, "API", "example/api-server", {}, fakeGh(issues));
    expect(again.imported).toEqual([{ sourceKey: "example/api-server#2", id: "API-3" }]);
    expect(again.skipped.map((s) => s.id)).toEqual(["API-1", "API-2"]);
  });

  test("DB への書き込みが途中で失敗したら、その Issue は Issue・コメント・対応表ごと残さない", async () => {
    const { db, me } = fixture();
    // コメントの追加で落ちるよう、comments への INSERT を拒むトリガーを置く
    db.run("CREATE TRIGGER no_comments BEFORE INSERT ON comments BEGIN SELECT RAISE(ABORT, 'コメントを書けません'); END");
    const r = await importGithubIssues(me, "API", "example/api-server", {}, fakeGh(SAMPLE.slice(0, 1)));
    expect(r.failed[0]!.message).toContain("コメントを書けません");
    expect((db.query("SELECT count(*) AS n FROM issues").get() as { n: number }).n).toBe(0);
    expect((db.query("SELECT count(*) AS n FROM issue_imports").get() as { n: number }).n).toBe(0);
  });

  test("--open-status・--label・--limit を gh とステータスに反映し、上限に達したら truncated を返す", async () => {
    const { db, me } = fixture();
    const gh = fakeGh([{ number: 1, title: "一" }, { number: 2, title: "二" }]);
    const r = await importGithubIssues(me, "API", "example/api-server", { openStatus: "backlog", labels: ["bug", "good first issue"], limit: 2 }, gh);
    expect(gh.calls[0]).toContain("--label=bug");
    expect(gh.calls[0]).toContain("--label=good first issue");
    expect(gh.calls[0]!.slice(gh.calls[0]!.indexOf("--limit"), gh.calls[0]!.indexOf("--limit") + 2)).toEqual(["--limit", "2"]);
    expect(r.truncated).toBe(true);
    expect(getIssue(db, "API-1").status).toBe("backlog");
  });

  test("引数の誤りは gh を起動する前に拒む", async () => {
    const { me } = fixture();
    const gh = fakeGh(SAMPLE);
    for (const repo of ["example", "-R/x", "example/api/server", "https://github.com/example/api", "exa mple/api"]) {
      expect(await rejects(importGithubIssues(me, "API", repo, { dryRun: true }, gh))).toBe("INVALID_ARGS");
    }
    for (const opts of [
      { limit: 0 },
      { limit: GITHUB_IMPORT_LIMIT_MAX + 1 },
      { state: "closed" as "open" },
      { openStatus: "done" as "todo" },
      { labels: [""] },
    ]) {
      expect(await rejects(importGithubIssues(me, "API", "example/api-server", { dryRun: true, ...opts }, gh))).toBe("INVALID_ARGS");
    }
    expect(await rejects(importGithubIssues(me, "API", "example/api-server", { dryRun: true, projectRef: "ない" }, gh))).toBe("NOT_FOUND");
    expect(await rejects(importGithubIssues(me, "NOPE", "example/api-server", { dryRun: true }, gh))).toBe("NOT_FOUND");
    expect(gh.calls).toHaveLength(0);
  });

  test("gh の失敗を原因ごとのコードにする", async () => {
    const { me } = fixture();
    const cases: [GhRunResult, string][] = [
      [{ kind: "not_found" }, "GH_NOT_INSTALLED"],
      [exited("", 4, "To get started with GitHub CLI, please run:  gh auth login"), "GH_AUTH"],
      [exited("", 1, "GraphQL: Could not resolve to a Repository with the name 'example/nope'."), "NOT_FOUND"],
      [{ kind: "timeout" }, "GH_FAILED"],
      [exited("not json"), "GH_FAILED"],
    ];
    for (const [list, code] of cases) {
      expect(await rejects(importGithubIssues(me, "API", "example/api-server", { dryRun: true }, fakeGh([], { list })))).toBe(code);
    }
  });
});
