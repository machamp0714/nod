import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb } from "../src/db";
import { findIssueRow } from "../src/issue-query";
import { getGithubState, linkGithubIssue, unlinkGithubIssue } from "../src/ops/github-links";
import {
  type CreateOutcome,
  classifyCreate,
  clearUnknownGithubPublish,
  type GithubPublishDeps,
  previewGithubPublish,
  publishGithubIssue,
} from "../src/ops/github-publish";
import { setWorkspaceGithubRepo } from "../src/ops/github-repo";
import { archiveIssue, createIssue, updateIssue } from "../src/ops/issues";
import type { GhRunner, GhRunResult } from "../src/ops/pr-status";
import { codeOf, eventsOf, setup } from "./helpers";

const exited = (stdout: string, exitCode = 0, stderr = ""): GhRunResult => ({ kind: "exited", exitCode, stdout, stderr });
const created = (n: number, repo = "example/api-server", status = "HTTP/2.0 201 Created"): GhRunResult =>
  exited(`${status}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ number: n, html_url: `https://github.com/${repo}/issues/${n}` })}`);

interface FakeGh extends GhRunner {
  calls: string[][];
  payloads: { title: string; body: string }[];
}

// user は login、-X POST は create、repos/... は Issue の取得
function fakeGh(opts: { login?: string[]; create?: () => Promise<GhRunResult> | GhRunResult; view?: GhRunResult } = {}): FakeGh {
  const calls: string[][] = [];
  const payloads: { title: string; body: string }[] = [];
  const logins = [...(opts.login ?? ["alice"])];
  const run: GhRunner = async (args) => {
    calls.push(args);
    if (args.includes("user")) return exited(`${logins.length > 1 ? logins.shift() : logins[0]}\n`);
    if (args.includes("POST")) {
      payloads.push(JSON.parse(readFileSync(args[args.indexOf("--input") + 1]!, "utf8")));
      return (await opts.create?.()) ?? created(41);
    }
    return opts.view ?? exited(JSON.stringify({ number: 41, html_url: "https://github.com/example/api-server/issues/41" }));
  };
  return Object.assign(run, { calls, payloads });
}

const posts = (gh: FakeGh) => gh.calls.filter((a) => a.includes("POST")).length;

async function codeOfAsync(p: Promise<unknown>): Promise<string | undefined> {
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
  const id = createIssue(s.me, { workspaceId: s.ws.id, title: "検索を速くする", description: "遅い" }).id;
  const deps = (gh: FakeGh): GithubPublishDeps => ({ gh, env: { HOME: "/Users/tester" } });
  const input = { title: "検索を速くする", body: "遅い", repo: "example/api-server", ghLogin: "alice" };
  return { ...s, id, deps, input };
}

describe("下見", () => {
  test("既定の文面・宛先・アカウント・検出・公開できない理由を返す。LLM も下見できる", async () => {
    const { llm, id, deps } = fixture();
    const gh = fakeGh();
    const p = await previewGithubPublish(llm, id, deps(gh));
    expect(p).toMatchObject({ issueId: id, title: "検索を速くする", body: "遅い", repo: "example/api-server", ghLogin: "alice", findings: [], blockers: [] });
    expect(posts(gh)).toBe(0);
  });

  test("公開先が未設定なら origin の候補を返す", async () => {
    const { db, me, id, deps } = fixture();
    db.query("UPDATE workspaces SET github_repo = NULL").run();
    const git: GhRunner = async () => exited("git@github.com:Example/API-Server.git\n");
    const p = await previewGithubPublish(me, id, { ...deps(fakeGh()), git });
    expect(p).toMatchObject({ repo: null, repoCandidate: "example/api-server", repoCandidateReason: null });
  });
});

describe("作成", () => {
  test("確認した文面を送り、対応（経路 publish）と Activity を残す。nod の本文はあとで変わっても送らない", async () => {
    const { db, me, id, deps, input } = fixture();
    const gh = fakeGh();
    await previewGithubPublish(me, id, deps(gh));
    updateIssue(me, id, { description: "確認したあとに変えた本文" });
    const r = await publishGithubIssue(me, id, input, deps(gh));
    expect(r).toMatchObject({ issueId: id, repo: "example/api-server", number: 41, url: "https://github.com/example/api-server/issues/41", recorded: true, message: null });
    expect(gh.payloads).toEqual([{ title: "検索を速くする", body: "遅い" }]);
    expect(getGithubState(db, id).link).toMatchObject({ number: 41, origin: "publish" });
    expect(eventsOf(db, id).some((e) => e.type === "github_published")).toBe(true);
    const args = gh.calls.find((a) => a.includes("POST"))!;
    expect(args.slice(0, 7)).toEqual(["api", "--hostname", "github.com", "-X", "POST", "repos/example/api-server/issues", "--include"]);
    expect(await codeOfAsync(publishGithubIssue(me, id, input, deps(gh)))).toBe("GITHUB_ALREADY_LINKED");
    expect(posts(gh)).toBe(1);
  });

  test("HTTP/1.1 の応答も成功と判定する", async () => {
    const { me, id, deps, input } = fixture();
    const r = await publishGithubIssue(me, id, input, deps(fakeGh({ create: () => created(42, "example/api-server", "HTTP/1.1 201 Created") })));
    expect(r.number).toBe(42);
  });

  test("別の DB 接続から同時に送っても POST は1回", async () => {
    const { db, me, id, deps, input } = fixture();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gh = fakeGh({ create: async () => (await gate, created(41)) });
    const other = { db: openDb(db.filename), actor: "me" };
    const first = publishGithubIssue(me, id, input, deps(gh));
    await Bun.sleep(20);
    const second = codeOfAsync(publishGithubIssue(other, id, input, deps(gh)));
    expect(await second).toBe("GITHUB_PUBLISH_PENDING");
    release();
    await first;
    expect(posts(gh)).toBe(1);
  });

  test("検出があれば送らず、検出の一覧を返す", async () => {
    const { me, id, deps, input } = fixture();
    const gh = fakeGh();
    let err: { code?: string; details?: { findings: unknown[] } } = {};
    try {
      await publishGithubIssue(me, id, { ...input, body: "API-1 の続き" }, deps(gh));
    } catch (e) {
      err = e as typeof err;
    }
    expect(err.code).toBe("LEAK_DETECTED");
    expect(err.details?.findings).toHaveLength(1);
    expect(gh.calls).toEqual([]);
  });

  test("タイトル 256・本文 65536 文字を超えたら送らない", async () => {
    const { me, id, deps, input } = fixture();
    const gh = fakeGh();
    expect(await codeOfAsync(publishGithubIssue(me, id, { ...input, title: "あ".repeat(257) }, deps(gh)))).toBe("INVALID_ARGS");
    expect(await codeOfAsync(publishGithubIssue(me, id, { ...input, body: "😀".repeat(65_537) }, deps(gh)))).toBe("INVALID_ARGS");
    expect(await codeOfAsync(publishGithubIssue(me, id, { ...input, title: "  " }, deps(gh)))).toBe("INVALID_ARGS");
    expect(gh.calls).toEqual([]);
  });

  test("公開先・アカウントが確認時と違えば送らない。アカウントの違いは failed で残し、再試行できる", async () => {
    const { db, me, id, deps, input } = fixture();
    expect(await codeOfAsync(publishGithubIssue(me, id, { ...input, repo: "example/other" }, deps(fakeGh())))).toBe("GITHUB_TARGET_CHANGED");
    const switched = fakeGh({ login: ["bob"] });
    expect(await codeOfAsync(publishGithubIssue(me, id, input, deps(switched)))).toBe("GITHUB_TARGET_CHANGED");
    expect(posts(switched)).toBe(0);
    expect(db.query("SELECT state FROM github_publishes").all()).toEqual([{ state: "failed" }]);
    expect((await publishGithubIssue(me, id, input, deps(fakeGh()))).number).toBe(41);
  });

  test("明確な拒否（422 など）は failed で、そのまま再試行できる", async () => {
    const { me, id, deps, input } = fixture();
    const rejected = fakeGh({ create: () => exited('HTTP/2.0 422 Unprocessable Entity\r\n\r\n{"message":"Validation Failed"}', 1, "gh: Validation Failed (HTTP 422)") });
    expect(await codeOfAsync(publishGithubIssue(me, id, input, deps(rejected)))).toBe("GH_FAILED");
    expect((await publishGithubIssue(me, id, input, deps(fakeGh()))).number).toBe(41);
  });

  test("タイムアウト・5xx・応答の解析失敗は結果不明にし、再送しない", async () => {
    for (const result of [{ kind: "timeout" } as GhRunResult, exited("HTTP/2.0 502 Bad Gateway\r\n\r\n", 1, "gh: HTTP 502"), exited("HTTP/2.0 201 Created\r\n\r\nnot json"), exited("")]) {
      const { db, me, id, deps, input } = fixture();
      const gh = fakeGh({ create: () => result });
      expect(await codeOfAsync(publishGithubIssue(me, id, input, deps(gh)))).toBe("GITHUB_RESULT_UNKNOWN");
      expect(getGithubState(db, id).pending).toMatchObject({ state: "unknown", repo: "example/api-server" });
      const preview = await previewGithubPublish(me, id, deps(gh));
      expect(preview.blockers.map((b) => b.code)).toContain("GITHUB_RESULT_UNKNOWN");
      expect(await codeOfAsync(publishGithubIssue(me, id, input, deps(gh)))).toBe("GITHUB_RESULT_UNKNOWN");
      expect(posts(gh)).toBe(1);
      expect(eventsOf(db, id).some((e) => e.type === "github_publish_unknown")).toBe(true);
    }
  });

  test("移管などで応答の repo が違っても作成は成功として記録し、違うことを知らせる", async () => {
    const { db, me, id, deps, input } = fixture();
    const r = await publishGithubIssue(me, id, input, deps(fakeGh({ create: () => created(5, "example/new-home") })));
    expect(r).toMatchObject({ repo: "example/new-home", number: 5, recorded: true });
    expect(r.message).toContain("example/new-home");
    expect(getGithubState(db, id).link?.repo).toBe("example/new-home");
  });

  test("送信中に解除や別の対応が入っても、遅れて届いた成功は sent として残し、別の対応は上書きしない", async () => {
    const { db, me, id, deps, input } = fixture();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const pending = publishGithubIssue(me, id, input, deps(fakeGh({ create: async () => (await gate, created(41)) })));
    await Bun.sleep(20);
    const row = findIssueRow(db, id);
    db.query("UPDATE github_publishes SET state = 'cleared'").run();
    db.query("INSERT INTO issue_imports (workspace_id, source, source_key, issue_id, imported_by, imported_at, origin) VALUES (?, 'github', 'example/api-server#9', ?, 'me', 'x', 'link')").run(row.workspace_id, row.id);
    release();
    const r = await pending;
    expect(r.recorded).toBe(false);
    expect(r.message).toContain("https://github.com/example/api-server/issues/41");
    expect(db.query("SELECT state FROM github_publishes").get()).toEqual({ state: "sent" });
    expect(getGithubState(db, id).link?.number).toBe(9);
  });

  test("作成後に対応の記録が失敗しても試行は sent のまま残し、URL を添えて GITHUB_RECORD_FAILED にする", async () => {
    const { db, me, id, deps, input } = fixture();
    db.exec("CREATE TRIGGER fail_link BEFORE INSERT ON issue_imports BEGIN SELECT RAISE(ABORT, 'injected'); END");
    let err: { code?: string; details?: { url?: string } } = {};
    try {
      await publishGithubIssue(me, id, input, deps(fakeGh()));
    } catch (e) {
      err = e as typeof err;
    }
    expect(err.code).toBe("GITHUB_RECORD_FAILED");
    expect(err.details?.url).toBe("https://github.com/example/api-server/issues/41");
    expect(db.query("SELECT state, result_number, result_url FROM github_publishes").all()).toEqual([
      { state: "sent", result_number: 41, result_url: "https://github.com/example/api-server/issues/41" },
    ]);
    expect(db.query("SELECT COUNT(*) AS n FROM issue_imports").get()).toEqual({ n: 0 });
    expect(eventsOf(db, id).find((e) => e.type === "github_published")?.data).toMatchObject({ recorded: false });
    expect(getGithubState(db, id)).toMatchObject({ pending: null, published: true, link: null });
  });

  test("done・canceled・アーカイブ済み・LLM は送らない", async () => {
    const { db, me, llm, id, deps, input } = fixture();
    const gh = fakeGh();
    expect(await codeOfAsync(publishGithubIssue(llm, id, input, deps(gh)))).toBe("FORBIDDEN_FOR_LLM");
    db.query("UPDATE issues SET status = 'done'").run();
    expect(await codeOfAsync(publishGithubIssue(me, id, input, deps(gh)))).toBe("ISSUE_CLOSED");
    db.query("UPDATE issues SET status = 'todo'").run();
    archiveIssue(me, id);
    expect(await codeOfAsync(publishGithubIssue(me, id, input, deps(gh)))).toBe("ISSUE_ARCHIVED");
    expect(posts(gh)).toBe(0);
  });

  test("一度作成した Issue は、紐付けを外しても再公開しない", async () => {
    const { me, id, deps, input } = fixture();
    await publishGithubIssue(me, id, input, deps(fakeGh()));
    unlinkGithubIssue(me, id);
    expect(await codeOfAsync(publishGithubIssue(me, id, input, deps(fakeGh())))).toBe("GITHUB_ALREADY_PUBLISHED");
  });
});

describe("結果不明の解除", () => {
  test("人が解除すると cleared になり、送らない。そのあと改めて公開できる", async () => {
    const { db, me, llm, id, deps, input } = fixture();
    await codeOfAsync(publishGithubIssue(me, id, input, deps(fakeGh({ create: () => ({ kind: "timeout" }) }))));
    expect(codeOf(() => clearUnknownGithubPublish(llm, id))).toBe("FORBIDDEN_FOR_LLM");
    const gh = fakeGh();
    expect(clearUnknownGithubPublish(me, id).pending).toBeNull();
    expect(posts(gh)).toBe(0);
    expect(eventsOf(db, id).some((e) => e.type === "github_publish_cleared")).toBe(true);
    expect(codeOf(() => clearUnknownGithubPublish(me, id))).toBe("INVALID_STATE");
    expect((await publishGithubIssue(me, id, input, deps(gh))).number).toBe(41);
  });

  test("期限を過ぎた sending も解除でき、期限内の sending は解除できない", () => {
    const { db, me, id } = fixture();
    const row = findIssueRow(db, id);
    const insert = (startedAt: string) =>
      db
        .query(
          `INSERT INTO github_publishes (attempt_id, issue_id, workspace_id, repo, title, body, gh_login, state, started_by, started_at)
           VALUES (?, ?, ?, 'example/api-server', 't', 'b', 'alice', 'sending', 'me', ?)`,
        )
        .run(crypto.randomUUID(), row.id, row.workspace_id, startedAt);
    insert(new Date().toISOString());
    expect(codeOf(() => clearUnknownGithubPublish(me, id))).toBe("INVALID_STATE");
    db.query("UPDATE github_publishes SET started_at = '2020-01-01T00:00:00.000Z'").run();
    expect(clearUnknownGithubPublish(me, id).pending).toBeNull();
  });

  test("作られていた GitHub Issue を紐付けると結果不明が解消する", async () => {
    const { db, me, id, deps, input } = fixture();
    const gh = fakeGh({ create: () => ({ kind: "timeout" }) });
    await codeOfAsync(publishGithubIssue(me, id, input, deps(gh)));
    await linkGithubIssue(me, id, "https://github.com/example/api-server/issues/41", gh);
    expect(getGithubState(db, id)).toMatchObject({ pending: null, published: true, link: { number: 41 } });
  });
});

describe("結果の分類", () => {
  test.each<[GhRunResult, CreateOutcome["kind"]]>([
    [{ kind: "not_found" }, "failed"],
    [{ kind: "spawn_failed", detail: "EACCES" }, "failed"],
    [{ kind: "timeout" }, "unknown"],
    [{ kind: "too_large", limitBytes: 1 }, "unknown"],
    [exited("HTTP/2.0 401 Unauthorized\r\n\r\n{}", 1), "failed"],
    [exited("HTTP/2.0 403 Forbidden\r\n\r\n{}", 1), "failed"],
    [exited("HTTP/2.0 404 Not Found\r\n\r\n{}", 1), "failed"],
    [exited("HTTP/2.0 410 Gone\r\n\r\n{}", 1), "failed"],
    [exited("HTTP/2.0 422 Unprocessable Entity\r\n\r\n{}", 1), "failed"],
    [exited("HTTP/2.0 429 Too Many Requests\r\n\r\n{}", 1), "failed"],
    [exited("", 1, "gh: Validation Failed (HTTP 422)"), "failed"],
    [exited("HTTP/2.0 408 Request Timeout\r\n\r\n{}", 1), "unknown"],
    [exited("HTTP/2.0 409 Conflict\r\n\r\n{}", 1), "unknown"],
    [exited("HTTP/2.0 500 Internal Server Error\r\n\r\n{}", 1), "unknown"],
    [exited("", 1, "error connecting to api.github.com"), "unknown"],
    [exited("HTTP/2.0 200 OK\r\n\r\n{\"number\":1,\"html_url\":\"https://github.com/example/api-server/issues/1\"}"), "unknown"],
    [exited("HTTP/2.0 201 Created\r\n\r\n{\"number\":0,\"html_url\":\"x\"}"), "unknown"],
    [exited("HTTP/2.0 201 Created\r\n\r\n{\"number\":1,\"html_url\":\"https://github.com/example/api-server/issues/2\"}"), "unknown"],
  ])("%j → %s", (result, kind) => {
    expect(classifyCreate(result, "example/api-server").kind).toBe(kind);
  });
});
