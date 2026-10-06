import { describe, expect, test } from "bun:test";
import { findIssueRow } from "../src/issue-query";
import { importGithubIssues } from "../src/ops/github-import";
import { getGithubState, linkGithubIssue, parseGithubIssueUrl, pendingAttemptOf, unlinkGithubIssue } from "../src/ops/github-links";
import { setWorkspaceGithubRepo } from "../src/ops/github-repo";
import { archiveIssue, copyIssue, createIssue } from "../src/ops/issues";
import type { GhRunner, GhRunResult } from "../src/ops/pr-status";
import { codeOf, eventsOf, setup } from "./helpers";

const exited = (stdout: string, exitCode = 0, stderr = ""): GhRunResult => ({ kind: "exited", exitCode, stdout, stderr });
const issueJson = (n: number, repo = "example/api-server", extra: Record<string, unknown> = {}) =>
  JSON.stringify({ number: n, html_url: `https://github.com/${repo}/issues/${n}`, ...extra });

// repos/<repo>/issues/<n> を返す偽の gh。list は import 用
function fakeGh(issues: Record<string, GhRunResult> = {}, list: unknown[] = []): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") return exited(JSON.stringify(list));
    if (args[0] === "issue" && args[1] === "view") return exited(JSON.stringify({ comments: [] }));
    const path = args.find((a) => a.startsWith("repos/")) ?? "";
    return issues[path] ?? exited("", 1, "gh: Not Found (HTTP 404)");
  };
  return Object.assign(run, { calls });
}

async function rejects(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

function fixture() {
  const s = setup();
  setWorkspaceGithubRepo(s.me, "API", "example/api-server");
  const a = createIssue(s.me, { workspaceId: s.ws.id, title: "a" }).id;
  const b = createIssue(s.me, { workspaceId: s.ws.id, title: "b" }).id;
  const gh = fakeGh({ "repos/example/api-server/issues/7": exited(issueJson(7)), "repos/example/api-server/issues/8": exited(issueJson(8)) });
  return { ...s, a, b, gh };
}

describe("URL の検証", () => {
  test("Issue の URL だけを受け付け、PR と形の違う URL は拒否する", () => {
    expect(parseGithubIssueUrl("https://github.com/Example/API-Server/issues/7")).toEqual({ repo: "example/api-server", number: 7 });
    expect(codeOf(() => parseGithubIssueUrl("https://github.com/example/api-server/pull/7"))).toBe("INVALID_ARGS");
    expect(codeOf(() => parseGithubIssueUrl("https://example.com/a/b/issues/7"))).toBe("INVALID_ARGS");
  });
});

describe("紐付け", () => {
  test("実在を確かめて紐付け、経路は link。同じ紐付けの繰り返しは成功扱い", async () => {
    const { db, me, a, gh } = fixture();
    const state = await linkGithubIssue(me, a, "https://github.com/example/api-server/issues/7", gh);
    expect(state.link).toEqual({ repo: "example/api-server", number: 7, url: "https://github.com/example/api-server/issues/7", origin: "link" });
    expect((await linkGithubIssue(me, a, "https://github.com/example/api-server/issues/7", gh)).link?.number).toBe(7);
    expect(eventsOf(db, a).filter((e) => e.type === "github_linked")).toHaveLength(1);
  });

  test("宛先が違う・PR・実在しない・LLM は拒否する", async () => {
    const { me, llm, a, gh } = fixture();
    expect(await rejects(linkGithubIssue(me, a, "https://github.com/other/repo/issues/7", gh))).toBe("INVALID_ARGS");
    expect(await rejects(linkGithubIssue(me, a, "https://github.com/example/api-server/issues/99", gh))).toBe("NOT_FOUND");
    const pr = fakeGh({ "repos/example/api-server/issues/9": exited(issueJson(9, "example/api-server", { pull_request: {} })) });
    expect(await rejects(linkGithubIssue(me, a, "https://github.com/example/api-server/issues/9", pr))).toBe("INVALID_ARGS");
    expect(await rejects(linkGithubIssue(llm, a, "https://github.com/example/api-server/issues/7", gh))).toBe("FORBIDDEN_FOR_LLM");
  });

  test("移管などで応答の repo が違えば、新しい URL を示して拒否する", async () => {
    const { me, a } = fixture();
    const moved = fakeGh({ "repos/example/api-server/issues/7": exited(issueJson(7, "example/new-home")) });
    expect(await rejects(linkGithubIssue(me, a, "https://github.com/example/api-server/issues/7", moved))).toBe("INVALID_ARGS");
  });

  test("別の nod Issue に紐付いた GitHub Issue は紐付け先を示して拒否し、別の対応がある Issue にも付けない", async () => {
    const { me, a, b, gh } = fixture();
    await linkGithubIssue(me, a, "https://github.com/example/api-server/issues/7", gh);
    let err: { code?: string; message?: string } = {};
    try {
      await linkGithubIssue(me, b, "https://github.com/example/api-server/issues/7", gh);
    } catch (e) {
      err = e as typeof err;
    }
    expect(err.code).toBe("GITHUB_LINK_CONFLICT");
    expect(err.message).toContain(a);
    expect(await rejects(linkGithubIssue(me, a, "https://github.com/example/api-server/issues/8", gh))).toBe("GITHUB_ALREADY_LINKED");
  });

  test("公開先が未設定なら拒否する。done・アーカイブ済みでも紐付けられる", async () => {
    const { db, me, a, gh } = fixture();
    db.query("UPDATE issues SET status = 'done'").run();
    archiveIssue(me, a);
    expect((await linkGithubIssue(me, a, "https://github.com/example/api-server/issues/7", gh)).link?.number).toBe(7);
    db.query("UPDATE workspaces SET github_repo = NULL").run();
    unlinkGithubIssue(me, a);
    expect(await rejects(linkGithubIssue(me, a, "https://github.com/example/api-server/issues/7", gh))).toBe("GITHUB_REPO_NOT_SET");
  });

  test("複製した Issue は対応を引き継がない", async () => {
    const { db, me, a, gh } = fixture();
    await linkGithubIssue(me, a, "https://github.com/example/api-server/issues/7", gh);
    const copied = copyIssue(me, a);
    expect(getGithubState(db, copied.id).link).toBeNull();
  });
});

describe("解除", () => {
  test("行を残して issue_id を外し、別の Issue に付け直せる。LLM は外せない", async () => {
    const { db, me, llm, a, b, gh } = fixture();
    await linkGithubIssue(me, a, "https://github.com/example/api-server/issues/7", gh);
    expect(codeOf(() => unlinkGithubIssue(llm, a))).toBe("FORBIDDEN_FOR_LLM");
    expect(unlinkGithubIssue(me, a).link).toBeNull();
    expect(db.query("SELECT count(*) AS n FROM issue_imports").get()).toEqual({ n: 1 });
    expect(codeOf(() => unlinkGithubIssue(me, a))).toBe("NOT_FOUND");
    expect((await linkGithubIssue(me, b, "https://github.com/example/api-server/issues/7", gh)).link?.origin).toBe("link");
    const linked = eventsOf(db, b).find((e) => e.type === "github_linked");
    expect(linked?.data.previous_origin).toBe("link");
  });

  test("外した GitHub Issue は import で取り込み直さない", async () => {
    const { db, me, a } = fixture();
    const list = [{ number: 7, title: "a", body: "", state: "OPEN", stateReason: "", labels: [], assignees: [], author: { login: "bob" }, createdAt: "2026-01-01T00:00:00Z", closedAt: null, url: "https://github.com/example/api-server/issues/7" }];
    const gh = fakeGh({ "repos/example/api-server/issues/7": exited(issueJson(7)) }, list);
    await linkGithubIssue(me, a, "https://github.com/example/api-server/issues/7", gh);
    const again = await importGithubIssues(me, "API", "example/api-server", {}, gh);
    expect(again.imported).toEqual([]);
    expect(again.skipped).toEqual([{ sourceKey: "example/api-server#7", id: a }]);
    unlinkGithubIssue(me, a);
    const afterUnlink = await importGithubIssues(me, "API", "example/api-server", {}, gh);
    expect(afterUnlink.imported).toEqual([]);
    expect(afterUnlink.deleted).toEqual([{ sourceKey: "example/api-server#7" }]);
    expect(db.query("SELECT count(*) AS n FROM issues").get()).toEqual({ n: 2 });
  });
});

describe("未解決の試行", () => {
  test("sending のまま 60 秒を過ぎた試行は unknown として読む", () => {
    const { db, a } = fixture();
    const row = findIssueRow(db, a);
    db.query(
      `INSERT INTO github_publishes (attempt_id, issue_id, workspace_id, repo, title, body, gh_login, state, started_by, started_at)
       VALUES ('t1', ?, ?, 'example/api-server', 't', 'b', 'alice', 'sending', 'me', '2026-10-07T00:00:00.000Z')`,
    ).run(row.id, row.workspace_id);
    const start = Date.parse("2026-10-07T00:00:00.000Z");
    expect(pendingAttemptOf(db, row.id, start + 59_000)?.state).toBe("sending");
    expect(pendingAttemptOf(db, row.id, start + 61_000)?.state).toBe("unknown");
  });

  test("unknown の試行がある Issue に紐付けると、試行を sent にして解消する。宛先は試行の repo", async () => {
    const { db, me, a, gh } = fixture();
    const row = findIssueRow(db, a);
    db.query(
      `INSERT INTO github_publishes (attempt_id, issue_id, workspace_id, repo, title, body, gh_login, state, started_by, started_at)
       VALUES ('t1', ?, ?, 'example/api-server', 't', 'b', 'alice', 'unknown', 'me', '2026-10-07T00:00:00.000Z')`,
    ).run(row.id, row.workspace_id);
    db.query("UPDATE workspaces SET github_repo = 'example/moved'").run();
    const state = await linkGithubIssue(me, a, "https://github.com/example/api-server/issues/7", gh);
    expect(state.pending).toBeNull();
    expect(state.published).toBe(true);
    expect(db.query("SELECT state, result_number FROM github_publishes").get()).toEqual({ state: "sent", result_number: 7 });
    expect(eventsOf(db, a).find((e) => e.type === "github_linked")?.data.resolved_attempt).toBe("t1");
  });
});
