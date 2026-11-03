import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { findIssueRow } from "../src/issue-query";
import { getGithubState, linkGithubIssue, unlinkGithubIssue } from "../src/ops/github-links";
import {
  type CreateOutcome,
  checkGithubPublishText,
  classifyCreate,
  clearUnknownGithubPublish,
  type GithubPublishDeps,
  previewGithubPublish,
  publishGithubIssue,
} from "../src/ops/github-publish";
import { setWorkspaceGithubRepo } from "../src/ops/github-repo";
import { archiveIssue, createIssue, updateIssue } from "../src/ops/issues";
import type { GhRunner, GhRunResult } from "../src/ops/pr-status";
import { initWorkspace } from "../src/ops/workspaces";
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

// GitHub の対応を記録する（link-github と同じ行を直接足す）
function linkRow(db: Database, ref: string, sourceKey: string): void {
  const row = findIssueRow(db, ref);
  db.query("INSERT INTO issue_imports (workspace_id, source, source_key, issue_id, imported_by, imported_at, origin) VALUES (?, 'github', ?, ?, 'me', 'x', 'link')").run(row.workspace_id, sourceKey, row.id);
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

  test("タイトル 256・本文 65536 コードポイントを超えると、公開できない理由に INVALID_ARGS を出す", async () => {
    const { db, me, id, deps } = fixture();
    const textCodes = async () => (await previewGithubPublish(me, id, deps(fakeGh()))).blockers.filter((b) => b.code === "INVALID_ARGS").map((b) => b.message);
    db.query("UPDATE issues SET title = ?, description = ?").run("𠮷".repeat(256), "𠮷".repeat(65_536));
    expect(await textCodes()).toEqual([]);
    db.query("UPDATE issues SET title = ?, description = ?").run("𠮷".repeat(257), "𠮷".repeat(65_537));
    expect(await textCodes()).toEqual(["タイトルは 256 文字までです", "本文は 65536 文字までです"]);
  });
});

describe("下見の案", () => {
  test("検出がなければ、案は nod の文面のままで、書き換えはない", async () => {
    const { me, id, deps } = fixture();
    const p = await previewGithubPublish(me, id, deps(fakeGh()));
    expect(p).toMatchObject({ title: "検索を速くする", body: "遅い", original: { title: "検索を速くする", body: "遅い" }, changes: [], findings: [] });
  });

  test("公開する Issue 自身の ID は「この Issue」にし、元の文面での位置と書き換えを返す。nod の本文は変えない", async () => {
    const { db, me, id, deps } = fixture();
    updateIssue(me, id, { title: `${id} 検索を速くする`, description: "遅い\nあ😀 api-1 の続き" });
    const p = await previewGithubPublish(me, id, deps(fakeGh()));
    expect(p).toMatchObject({
      title: "この Issue 検索を速くする",
      body: "遅い\nあ😀 この Issue の続き",
      original: { title: "API-1 検索を速くする", body: "遅い\nあ😀 api-1 の続き" },
      changes: [
        { field: "title", line: 1, column: 1, before: "API-1", after: "この Issue", rule: "issue_id", reason: expect.any(String) },
        { field: "body", line: 2, column: 4, before: "api-1", after: "この Issue", rule: "issue_id", reason: expect.any(String) },
      ],
      findings: [],
    });
    expect(findIssueRow(db, id)).toMatchObject({ title: "API-1 検索を速くする", description: "遅い\nあ😀 api-1 の続き" });
    expect(checkGithubPublishText(db, p.original, deps(fakeGh())).map((f) => f.text)).toEqual(["API-1", "api-1"]);
  });

  test("ほかの ID は、GitHub に対応があれば（Workspace を問わず）その URL、同じ Workspace で対応がなければ（アーカイブ済みも）タイトルで言い換え、ほかは残す。検出の位置は案のもの", async () => {
    const { db, me, ws, id, deps } = fixture();
    const web = initWorkspace(db, { path: "/tmp/repos/web-app", key: "WEB" }).workspace;
    const add = (workspaceId: number, title: string) => createIssue(me, { workspaceId, title }).id;
    const unlinked = add(ws.id, "ログを整理する");
    const archived = add(ws.id, "古い画面");
    archiveIssue(me, archived);
    const linked = add(ws.id, "通知を送る");
    linkRow(db, linked, "example/api-server#7");
    const otherLinked = add(web.id, "画面を作る");
    linkRow(db, otherLinked, "example/web#3");
    const otherUnlinked = add(web.id, "色を変える");
    updateIssue(me, id, { description: [`- ${unlinked}`, `- ${archived}`, `- ${linked}`, `- ${otherLinked}`, `- ${unlinked} / ${otherUnlinked}`, "- API-99"].join("\n") });
    const p = await previewGithubPublish(me, id, deps(fakeGh()));
    expect(p.body).toBe(
      [
        "- 「ログを整理する」の Issue",
        "- 「古い画面」の Issue",
        "- https://github.com/example/api-server/issues/7",
        "- https://github.com/example/web/issues/3",
        "- 「ログを整理する」の Issue / WEB-2",
        "- API-99",
      ].join("\n"),
    );
    expect(p.changes.map((c) => [c.line, c.column, c.before, c.rule])).toEqual([
      [1, 3, "API-2", "issue_id"],
      [2, 3, "API-3", "issue_id"],
      [3, 3, "API-4", "issue_id"],
      [4, 3, "WEB-1", "issue_id"],
      [5, 3, "API-2", "issue_id"],
    ]);
    expect(p.findings).toEqual([
      { field: "body", line: 5, column: 22, text: "WEB-2", rule: "issue_id", reason: expect.any(String) },
      { field: "body", line: 6, column: 3, text: "API-99", rule: "issue_id", reason: expect.any(String) },
    ]);
  });

  test("owner/repo#N は GitHub の URL にし、番号だけの #N は残す", async () => {
    const { me, id, deps } = fixture();
    updateIssue(me, id, { description: "example/web#5 を見る。#12 も" });
    const p = await previewGithubPublish(me, id, deps(fakeGh()));
    expect(p).toMatchObject({
      body: "https://github.com/example/web/issues/5 を見る。#12 も",
      changes: [{ field: "body", line: 1, column: 1, before: "example/web#5", after: "https://github.com/example/web/issues/5", rule: "issue_ref" }],
      findings: [{ line: 1, column: 45, text: "#12", rule: "issue_ref" }],
    });
  });

  test("nod の Web の /issues/<ID> の URL は ID の規則で URL ごと書き換え、残す ID の URL・ほかの URL とその中の ID は残す", async () => {
    const { db, me, ws, id, deps } = fixture();
    const web = initWorkspace(db, { path: "/tmp/repos/web-app", key: "WEB" }).workspace;
    const other = createIssue(me, { workspaceId: ws.id, title: "ログを整理する" }).id;
    const kept = createIssue(me, { workspaceId: web.id, title: "色を変える" }).id;
    updateIssue(me, id, {
      description: [
        `http://localhost:4700/issues/${other} を見る`,
        `前回は http://127.0.0.1:4700/issues/${id}/?tab=log。`,
        `http://localhost:4700/issues/${kept}`,
        "http://localhost:4700/projects/1",
        `https://example.com/${other}`,
        `<http://localhost:4700/issues/${id}> と <http://localhost:4700/issues/${kept}>`,
      ].join("\n"),
    });
    const p = await previewGithubPublish(me, id, deps(fakeGh()));
    expect(p.body).toBe(
      [
        "「ログを整理する」の Issue を見る",
        "前回は この Issue。",
        "http://localhost:4700/issues/WEB-1",
        "http://localhost:4700/projects/1",
        "https://example.com/API-2",
        "この Issue と <http://localhost:4700/issues/WEB-1>",
      ].join("\n"),
    );
    expect(p.changes).toMatchObject([
      { line: 1, column: 1, before: "http://localhost:4700/issues/API-2", after: "「ログを整理する」の Issue", rule: "nod_web" },
      { line: 2, column: 5, before: "http://127.0.0.1:4700/issues/API-1/?tab=log", after: "この Issue", rule: "nod_web" },
      { line: 6, column: 1, before: "<http://localhost:4700/issues/API-1>", after: "この Issue", rule: "nod_web" },
    ]);
    expect(p.findings.map((f) => [f.line, f.rule])).toEqual([
      [3, "nod_web"],
      [3, "issue_id"],
      [4, "nod_web"],
      [5, "issue_id"],
      [6, "nod_web"],
      [6, "issue_id"],
    ]);
  });

  test("本文の末尾に生成したままの取り込みの footer は「参考: <取り込み元の URL>」の1行にし、形が崩れたもの・途中にあるものは残す", async () => {
    const { me, id, deps } = fixture();
    const footer = [
      "取り込み元: https://github.com/Example/API-Server/issues/12（GitHub #12、@bob が 2026-01-02T03:04:05Z に作成、2026-02-01T00:00:00Z に close）",
      "担当（GitHub）: @alice, @bob",
    ].join("\n");
    updateIssue(me, id, { description: `遅い\n\n---\n${footer}` });
    const p = await previewGithubPublish(me, id, deps(fakeGh()));
    expect(p).toMatchObject({
      body: "遅い\n\n---\n参考: https://github.com/Example/API-Server/issues/12",
      changes: [{ field: "body", line: 4, column: 1, before: footer, after: "参考: https://github.com/Example/API-Server/issues/12", rule: "import_footer" }],
      findings: [],
    });
    for (const description of [`---\n${footer}\n\n追記`, "---\n取り込み元: https://github.com/Example/API-Server/issues/12（手で書いた）"]) {
      updateIssue(me, id, { description });
      const kept = await previewGithubPublish(me, id, deps(fakeGh()));
      expect(kept.body).toBe(description);
      expect(kept.findings.map((f) => f.rule)).toContain("import_footer");
    }
  });

  test("公開する Issue の Workspace の中を指す絶対パスは相対パスにし、Workspace のルート・ほかの Workspace・HOME・外のパスは残す", async () => {
    const { db, me, id, deps } = fixture();
    initWorkspace(db, { path: "/tmp/repos/api-server/vendor/lib", key: "LIB" });
    const lines = [
      "- /tmp/repos/api-server/src/a.ts を直す",
      "- 手順は /tmp/repos/api-server/docs/b.md。",
      "- /tmp/repos/api-server",
      "- /tmp/repos/api-server/vendor/lib/x.ts",
      "- /tmp/repos/api-server-old/x",
      "- /Users/tester/notes.md",
    ];
    updateIssue(me, id, { description: lines.join("\n") });
    const p = await previewGithubPublish(me, id, deps(fakeGh()));
    expect(p.body).toBe(["- src/a.ts を直す", "- 手順は docs/b.md。", ...lines.slice(2)].join("\n"));
    expect(p.changes).toMatchObject([
      { line: 1, column: 3, before: "/tmp/repos/api-server/src/a.ts", after: "src/a.ts", rule: "absolute_path" },
      { line: 2, column: 7, before: "/tmp/repos/api-server/docs/b.md", after: "docs/b.md", rule: "absolute_path" },
    ]);
    expect(p.findings.map((f) => [f.line, f.rule])).toEqual([
      [3, "absolute_path"],
      [4, "absolute_path"],
      [5, "absolute_path"],
      [6, "absolute_path"],
    ]);
  });

  test("Workspace のパスの実体（realpath）で書いたパスも相対パスにする", async () => {
    const { db, me } = fixture();
    const dir = mkdtempSync(join(tmpdir(), "nod-draft-"));
    const real = realpathSync(dir);
    const ws = initWorkspace(db, { path: dir, key: "REAL" }).workspace;
    setWorkspaceGithubRepo(me, "REAL", "example/real");
    const id = createIssue(me, { workspaceId: ws.id, title: "t", description: `${real}/src/a.ts と ${dir}/b.ts` }).id;
    const p = await previewGithubPublish(me, id, { gh: fakeGh(), env: { HOME: "/Users/tester" } });
    expect(p.body).toBe("src/a.ts と b.ts");
  });

  test("リンクは、GitHub に対応がある nod の Issue ならリンク先だけを GitHub の URL に、相対パス・Workspace のパスなら「文字（パス）」にし、ほかは残す", async () => {
    const { db, me, ws, id, deps } = fixture();
    const linked = createIssue(me, { workspaceId: ws.id, title: "通知を送る" }).id;
    linkRow(db, linked, "example/api-server#7");
    const unlinked = createIssue(me, { workspaceId: ws.id, title: "ログを整理する" }).id;
    const kept = [
      "![図](images/a.png)",
      "[ref]: ./a.md",
      "[添付](/api/attachments/3)",
      `[未対応](/issues/${unlinked})`,
      "[外](../other/x.md)",
    ];
    updateIssue(me, id, {
      description: [
        `[通知の件](/issues/${linked})`,
        `[通知](http://localhost:4700/issues/${linked})`,
        "[仕様](docs/spec.md)",
        "[設計](</tmp/repos/api-server/docs/a b.md>) を見る",
        ...kept,
      ].join("\n"),
    });
    const p = await previewGithubPublish(me, id, deps(fakeGh()));
    expect(p.body).toBe(
      [
        "[通知の件](https://github.com/example/api-server/issues/7)",
        "[通知](https://github.com/example/api-server/issues/7)",
        "仕様（docs/spec.md）",
        "設計（docs/a b.md） を見る",
        ...kept,
      ].join("\n"),
    );
    expect(p.changes).toMatchObject([
      { line: 1, column: 8, before: "/issues/API-2", after: "https://github.com/example/api-server/issues/7", rule: "link_target" },
      { line: 2, column: 6, before: "http://localhost:4700/issues/API-2", after: "https://github.com/example/api-server/issues/7", rule: "nod_web" },
      { line: 3, column: 1, before: "[仕様](docs/spec.md)", after: "仕様（docs/spec.md）", rule: "link_target" },
      { line: 4, column: 1, before: "[設計](</tmp/repos/api-server/docs/a b.md>)", after: "設計（docs/a b.md）", rule: "link_target" },
    ]);
    expect([...new Set(p.findings.map((f) => f.line))]).toEqual([5, 6, 7, 8, 9]);
  });

  test("コードブロック・インラインコードの中は、Workspace のパスの相対パス化だけを行う", async () => {
    const { me, ws, id, deps } = fixture();
    createIssue(me, { workspaceId: ws.id, title: "ログを整理する" });
    const fenced = (path: string) => ["```sh", `nod issue show ${id}`, `http://localhost:4700/issues/${id}`, "example/web#5", path, "```"];
    const tilde = ["~~~", "[x](docs/a.md)", "~~~"];
    updateIssue(me, id, {
      description: ["`API-2` と `/tmp/repos/api-server/src/a.ts`", ...fenced("/tmp/repos/api-server/src/b.ts"), ...tilde, `${id} の続き`].join("\n"),
    });
    const p = await previewGithubPublish(me, id, deps(fakeGh()));
    expect(p.body).toBe(["`API-2` と `src/a.ts`", ...fenced("src/b.ts"), ...tilde, "この Issue の続き"].join("\n"));
    expect(p.changes.map((c) => [c.line, c.rule])).toEqual([
      [1, "absolute_path"],
      [6, "absolute_path"],
      [11, "issue_id"],
    ]);
  });

  test("書き換えは連鎖しない。言い換えに入れたタイトルの中の ID・パスは書き換えず、残った箇所として示す", async () => {
    const { me, ws, id, deps } = fixture();
    const related = createIssue(me, { workspaceId: ws.id, title: "API-3 と /tmp/repos/api-server/a.ts の続き" }).id;
    createIssue(me, { workspaceId: ws.id, title: "古い件" });
    updateIssue(me, id, { description: `${related} を先に` });
    const p = await previewGithubPublish(me, id, deps(fakeGh()));
    expect(p.body).toBe("「API-3 と /tmp/repos/api-server/a.ts の続き」の Issue を先に");
    expect(p.changes).toHaveLength(1);
    expect(p.findings).toMatchObject([
      { line: 1, column: 2, text: "API-3", rule: "issue_id" },
      { line: 1, column: 10, rule: "absolute_path" },
    ]);
  });

  test("残った箇所には、何をすればよいかを理由に示す", async () => {
    const { db, me, id, deps } = fixture();
    const web = initWorkspace(db, { path: "/tmp/repos/web-app", key: "WEB" }).workspace;
    createIssue(me, { workspaceId: web.id, title: "色を変える" });
    updateIssue(me, id, {
      description: ["WEB-1", "#12", "`example/web#5`", "localhost:4700", "nod issue show", "---\n取り込み元: 手で書いた", "/Users/tester/x", "[外](../x.md)"].join("\n"),
    });
    const p = await previewGithubPublish(me, id, deps(fakeGh()));
    const reasonOf = (text: string) => p.findings.find((f) => f.text === text)?.reason;
    expect(reasonOf("WEB-1")).toContain("GitHub の URL に直すか、内容の説明に言い換えてください");
    expect(reasonOf("#12")).toContain("nod のログ・質問の番号なら内容の説明に直してください");
    expect(reasonOf("example/web#5")).toContain("完全な GitHub の URL");
    expect(reasonOf("localhost:4700")).toContain("GitHub の URL に差し替えるか、内容の説明に言い換えてください");
    expect(reasonOf("nod issue show")).toContain("参照先の内容を書くか、削除してください");
    expect(reasonOf("取り込み元:")).toContain("「参考: <取り込み元の URL>」の1行にし");
    expect(reasonOf("/Users/tester")).toContain("リポジトリの中なら相対パスに");
    expect(reasonOf("../x.md")).toContain("公開できる URL に差し替えるか");
  });

  test("書き換え・検出が多い長い本文でも遅くならない", async () => {
    const { me, id, deps } = fixture();
    updateIssue(me, id, { description: "a/b#1 API-1 #2 ".repeat(4000) });
    const t = performance.now();
    const p = await previewGithubPublish(me, id, deps(fakeGh()));
    expect(performance.now() - t).toBeLessThan(1000);
    expect(p.changes).toHaveLength(8000);
    expect(p.findings).toHaveLength(4000);
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

  test("閉じた Issue に結果不明の試行が残っていれば、復旧の案内（GITHUB_RESULT_UNKNOWN）を先に出す", async () => {
    const { db, me, id, deps, input } = fixture();
    await codeOfAsync(publishGithubIssue(me, id, input, deps(fakeGh({ create: () => ({ kind: "timeout" }) }))));
    db.query("UPDATE issues SET status = 'done'").run();
    const gh = fakeGh();
    expect((await previewGithubPublish(me, id, deps(gh))).blockers.map((b) => b.code)).toEqual(["GITHUB_RESULT_UNKNOWN", "ISSUE_CLOSED"]);
    expect(await codeOfAsync(publishGithubIssue(me, id, input, deps(gh)))).toBe("GITHUB_RESULT_UNKNOWN");
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
