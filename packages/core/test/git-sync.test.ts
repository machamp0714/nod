import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeIssue, startIssue } from "../src/ops/agent";
import { listAutoTransitions, undoAutoTransition } from "../src/ops/auto-transitions";
import { getAutomationSettings, setAutomationSettings } from "../src/ops/automation";
import { findClosingRefs, GIT_SYNC_SCAN_MAX, gitRunner, syncGitCommits } from "../src/ops/git-sync";
import { rejectReview } from "../src/ops/human";
import { archiveIssue, createIssue, getIssue, updateIssue } from "../src/ops/issues";
import { initWorkspace } from "../src/ops/workspaces";
import type { OpCtx } from "../src/ctx";
import { openDb } from "../src/db";
import { codeOf, eventsOf, tempDbPath } from "./helpers";

// 一時リポジトリを作り、git を直接使う（実リポジトリ・ネットワークには触れない）
function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=nod-test", "-c", "user.email=nod@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}

function fixture(opts: { enabled?: boolean } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "nod-git-"));
  git(repo, "init", "-q", "-b", "main");
  const db = openDb(tempDbPath());
  const ws = initWorkspace(db, { path: repo, key: "API" }).workspace;
  const me: OpCtx = { db, actor: "me" };
  const llm: OpCtx = { db, actor: "claude-code" };
  if (opts.enabled !== false) setAutomationSettings(me, ws.key, { commitReview: true });
  const make = (status = "in_progress", title = status) => {
    const issue = createIssue(me, { workspaceId: ws.id, title });
    db.query("UPDATE issues SET status = ? WHERE id = (SELECT max(id) FROM issues)").run(status);
    return issue.id;
  };
  const commit = (message: string, date?: string) => {
    const env = date ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : {};
    const r = Bun.spawnSync(
      ["git", "-c", "user.name=nod-test", "-c", "user.email=nod@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", message],
      { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env } },
    );
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return git(repo, "rev-parse", "HEAD");
  };
  return { repo, db, ws, me, llm, make, commit };
}

const statusOf = (db: ReturnType<typeof openDb>, ref: string) => getIssue(db, ref).status as string;

describe("コミットメッセージから Issue ID を読む", () => {
  test("Closes/Fixes/Resolves（活用形・大文字小文字・コロン）と区切りの複数 ID を拾う", () => {
    expect(findClosingRefs("Closes API-1", "API")).toEqual([{ id: "API-1", keyword: "Closes" }]);
    expect(findClosingRefs("fix: 検索を直す\n\nfixes: api-2, API-3 and API-4 & API-5", "API").map((r) => r.id)).toEqual([
      "API-2",
      "API-3",
      "API-4",
      "API-5",
    ]);
    for (const kw of ["close", "closed", "fix", "fixed", "resolve", "resolves", "resolved", "RESOLVED"]) {
      expect(findClosingRefs(`${kw} API-7`, "API").map((r) => r.id)).toEqual(["API-7"]);
    }
  });

  test("別の Workspace のキー・単語の途中・キーワードなし・ID の続きは拾わない", () => {
    expect(findClosingRefs("Closes NOD-1", "API")).toEqual([]);
    expect(findClosingRefs("prefixes API-1", "API")).toEqual([]);
    expect(findClosingRefs("API-1 を直した", "API")).toEqual([]);
    expect(findClosingRefs("Closes API-12a", "API")).toEqual([]);
    expect(findClosingRefs("Closes XAPI-1", "API")).toEqual([]);
    expect(findClosingRefs("Refs API-1", "API")).toEqual([]);
  });

  test("コードブロック（``` で囲まれた行）の中の参照は拾わない", () => {
    const msg = "直した\n\n```\nFixes API-1\n```\nCloses API-2\n```sh\ngit commit -m 'Resolves API-3'\n```";
    expect(findClosingRefs(msg, "API").map((r) => r.id)).toEqual(["API-2"]);
    // 閉じていないコードブロックは末尾まで
    expect(findClosingRefs("Closes API-4\n```\nFixes API-5", "API").map((r) => r.id)).toEqual(["API-4"]);
  });

  test("同じ ID は1回だけ", () => {
    expect(findClosingRefs("Fixes API-1\nCloses API-1", "API")).toEqual([{ id: "API-1", keyword: "Fixes" }]);
  });
});

describe("nod git sync", () => {
  test("既定は無効。有効にできるのは me だけ", () => {
    const s = fixture({ enabled: false });
    expect(getAutomationSettings(s.db, s.ws.key).commitReview).toBe(false);
    expect(codeOf(() => setAutomationSettings(s.llm, s.ws.key, { commitReview: true }))).toBe("FORBIDDEN_FOR_LLM");
  });

  test("dry-run は候補だけを返し、実行で backlog/todo/in_progress を in_review にして記録と event を残す", async () => {
    const s = fixture();
    const a = s.make("in_progress", "検索");
    const b = s.make("todo", "画面");
    const c = s.make("backlog", "文書");
    const sha1 = s.commit(`検索を直す\n\nFixes ${a}`);
    const sha2 = s.commit(`画面と文書\n\nCloses ${b}, ${c}`);
    const dry = await syncGitCommits(s.llm, s.ws.key, { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, enabled: true, ref: "HEAD", sinceDays: 30, scanned: 2, total: 3, processed: [] });
    expect(dry.candidates.map((x) => [x.id, x.sha])).toEqual([
      [a, sha1],
      [b, sha2],
      [c, sha2],
    ]);
    expect(dry.candidates[0]).toMatchObject({ status: "in_progress", subject: "検索を直す", keyword: "Fixes" });
    expect(statusOf(s.db, a)).toBe("in_progress");

    const run = await syncGitCommits(s.me, s.ws.key, {});
    expect(run.processed).toEqual([a, b, c]);
    for (const id of [a, b, c]) expect(statusOf(s.db, id)).toBe("in_review");
    const ev = eventsOf(s.db, b).at(-1)!;
    expect(ev).toMatchObject({ type: "status_changed", actor: "me", data: { from: "todo", to: "in_review", automation: "commit_review" } });
    expect(ev.data.reason).toContain(sha2.slice(0, 12));
    expect(listAutoTransitions(s.db, c)).toMatchObject([{ source: "commit", sourceKey: sha2, from: "backlog", to: "in_review" }]);
    // 冪等: もう一度実行しても何もしない
    expect((await syncGitCommits(s.me, s.ws.key, {})).total).toBe(0);
  });

  test("対象外: triage・needs_clarification・in_review・done・canceled・アーカイブ済み・未登録の ID", async () => {
    const s = fixture();
    const ids = ["triage", "needs_clarification", "in_review", "done", "canceled"].map((st) => [st, s.make(st)] as const);
    const archived = s.make("todo");
    archiveIssue(s.me, archived);
    s.commit(`Closes ${[...ids.map(([, id]) => id), archived, "API-999"].join(", ")}`);
    const run = await syncGitCommits(s.me, s.ws.key, {});
    expect(run.total).toBe(0);
    for (const [st, id] of ids) expect(statusOf(s.db, id)).toBe(st);
  });

  test("LLM は実行できない（dry-run はできる）。無効なら実行できない", async () => {
    const s = fixture({ enabled: false });
    const a = s.make();
    s.commit(`Fixes ${a}`);
    const dry = await syncGitCommits(s.llm, s.ws.key, { dryRun: true });
    expect(dry).toMatchObject({ enabled: false, total: 1 });
    expect(await syncGitCommits(s.me, s.ws.key, {}).catch((e) => e.code)).toBe("AUTOMATION_DISABLED");
    setAutomationSettings(s.me, s.ws.key, { commitReview: true });
    expect(await syncGitCommits(s.llm, s.ws.key, {}).catch((e) => e.code)).toBe("FORBIDDEN_FOR_LLM");
    expect(statusOf(s.db, a)).toBe("in_progress");
  });

  test("読み取る範囲: --since の日数より古いコミットと、--ref に含まれないコミットは読まない", async () => {
    const s = fixture();
    const old = s.make();
    const branch = s.make();
    s.commit(`Fixes ${old}`, new Date(Date.now() - 40 * 86_400_000).toISOString());
    git(s.repo, "checkout", "-q", "-b", "feature");
    s.commit(`Fixes ${branch}`);
    git(s.repo, "checkout", "-q", "main");
    expect((await syncGitCommits(s.me, s.ws.key, { dryRun: true })).total).toBe(0);
    expect((await syncGitCommits(s.me, s.ws.key, { dryRun: true, sinceDays: 60 })).candidates.map((c) => c.id)).toEqual([old]);
    expect((await syncGitCommits(s.me, s.ws.key, { dryRun: true, ref: "feature" })).candidates.map((c) => c.id)).toEqual([branch]);
  });

  test("同じ Issue を書いた複数のコミットは最新のコミットで1件にまとめ、--limit を超えた分は残りにする", async () => {
    const s = fixture();
    const a = s.make();
    const b = s.make();
    s.commit(`Fixes ${a}`);
    const newer = s.commit(`Closes ${a}`);
    s.commit(`Closes ${b}`);
    const dry = await syncGitCommits(s.me, s.ws.key, { dryRun: true, limit: 1 });
    expect(dry).toMatchObject({ total: 2, remaining: 1 });
    expect(dry.candidates.map((c) => [c.id, c.sha])).toEqual([[a, newer]]);
  });

  test("コミットのあとで一度でも in_review になった Issue（差し戻し後）は進めない。取消後も同じコミットでは進めない", async () => {
    const s = fixture();
    const reviewed = s.make("todo");
    s.commit(`Fixes ${reviewed}`);
    startIssue(s.llm, reviewed);
    completeIssue(s.llm, reviewed, { summary: "直した" });
    rejectReview(s.me, reviewed, "足りない");
    expect((await syncGitCommits(s.me, s.ws.key, {})).total).toBe(0);
    expect(statusOf(s.db, reviewed)).toBe("in_progress");

    const undone = s.make("todo");
    s.commit(`Fixes ${undone}`);
    await syncGitCommits(s.me, s.ws.key, {});
    expect(undoAutoTransition(s.me, undone)).toMatchObject({ source: "commit", from: "todo" });
    expect(statusOf(s.db, undone)).toBe("todo");
    expect((await syncGitCommits(s.me, s.ws.key, {})).total).toBe(0);
    updateIssue(s.me, undone, { status: "in_progress" });
    expect((await syncGitCommits(s.me, s.ws.key, {})).total).toBe(0);
  });

  test("引数の誤り・git の失敗を拒む", async () => {
    const s = fixture();
    for (const opts of [{ sinceDays: 0 }, { sinceDays: 3651 }, { limit: 0 }, { limit: 501 }, { ref: "-p" }, { ref: "" }]) {
      expect(await syncGitCommits(s.me, s.ws.key, { dryRun: true, ...opts }).catch((e) => e.code)).toBe("INVALID_ARGS");
    }
    expect(await syncGitCommits(s.me, s.ws.key, { dryRun: true, ref: "no-such-branch" }).catch((e) => e.code)).toBe("GIT_FAILED");
    // コミットのないリポジトリは 0 件
    expect((await syncGitCommits(s.me, s.ws.key, { dryRun: true })).scanned).toBe(0);
    expect(GIT_SYNC_SCAN_MAX).toBe(1000);
  });

  test("Revert コミット（件名が Revert \" で始まる・本文に This reverts commit）は読まない", async () => {
    const s = fixture();
    const [a, b, c] = [s.make("todo"), s.make("todo"), s.make("todo")];
    s.commit(`Revert "Fixes ${a}"\n\nThis reverts commit 0123456789abcdef0123456789abcdef01234567.`);
    s.commit(`元に戻す\n\nFixes ${b}\nThis reverts commit 0123456789abcdef0123456789abcdef01234567.`);
    s.commit(`Reverting the fix is not needed\n\nFixes ${c}`);
    const dry = await syncGitCommits(s.me, s.ws.key, { dryRun: true });
    expect(dry.candidates.map((x) => x.id)).toEqual([c]);
  });

  test("人が差し戻した（in_review から動かした）Issue は、新しいコミットでも進めない（rebase・cherry-pick で SHA が変わっても同じ）", async () => {
    const s = fixture();
    const auto = s.make("todo");
    s.commit(`Fixes ${auto}`);
    await syncGitCommits(s.me, s.ws.key, {});
    expect(statusOf(s.db, auto)).toBe("in_review");
    updateIssue(s.me, auto, { status: "in_progress" }); // 人の差し戻し
    const manual = s.make("todo");
    updateIssue(s.me, manual, { status: "in_review" });
    updateIssue(s.me, manual, { status: "todo" });
    // 同じ内容のコミットを後から作る（rebase・cherry-pick で SHA が変わったのと同じ）
    s.commit(`Fixes ${auto}, ${manual}`, new Date(Date.now() + 60_000).toISOString());
    expect((await syncGitCommits(s.me, s.ws.key, {})).total).toBe(0);
    expect(statusOf(s.db, auto)).toBe("in_progress");
    expect(statusOf(s.db, manual)).toBe("todo");
  });

  test("backlog / todo から進めても started_at は空のまま（手動の遷移と同じ。作業時間は未計測）", async () => {
    const s = fixture();
    const a = s.make("backlog");
    s.commit(`Fixes ${a}`);
    await syncGitCommits(s.me, s.ws.key, {});
    expect(getIssue(s.db, a)).toMatchObject({ status: "in_review", startedAt: null });
  });

  test("git log は署名の表示を切り、GIT_DIR などの環境変数に左右されない", async () => {
    const s = fixture();
    const a = s.make("todo");
    s.commit(`Fixes ${a}`);
    const calls: string[][] = [];
    const spy: typeof gitRunner = (args, opts) => {
      calls.push(args);
      return gitRunner(args, opts);
    };
    const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = join(s.repo, "no-such-dir");
    process.env.GIT_WORK_TREE = "/";
    try {
      expect((await syncGitCommits(s.me, s.ws.key, { dryRun: true }, spy)).candidates.map((x) => x.id)).toEqual([a]);
    } finally {
      for (const [k, v] of [["GIT_DIR", saved.dir], ["GIT_WORK_TREE", saved.tree]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(calls[0]?.slice(0, 2)).toEqual(["-c", "log.showSignature=false"]);
  });
});
