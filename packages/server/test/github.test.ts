import { expect, test } from "bun:test";
import { createIssue, type GhRunner, type GhRunResult, setWorkspaceGithubRepo } from "@nod/core";
import { createApp } from "../src/app";
import { call, setup } from "./helpers";

const exited = (stdout: string, exitCode = 0, stderr = ""): GhRunResult => ({ kind: "exited", exitCode, stdout, stderr });

function fixture(opts: { repo?: boolean } = {}) {
  const s = setup();
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    if (args.includes("user")) return exited("alice\n");
    if (args.includes("POST")) return exited(`HTTP/2.0 201 Created\r\n\r\n${JSON.stringify({ number: 41, html_url: "https://github.com/example/api-server/issues/41" })}`);
    if (args.some((a) => a === "repos/example/api-server/issues/7")) return exited(JSON.stringify({ number: 7, html_url: "https://github.com/example/api-server/issues/7" }));
    return exited("", 1, "gh: Not Found (HTTP 404)");
  };
  const git: GhRunner = async () => exited("git@github.com:Example/API-Server.git\n");
  const app = createApp({ db: s.db, ghRunner: gh, gitRunner: git, webPort: () => 5123 });
  if (opts.repo !== false) setWorkspaceGithubRepo(s.me, "API", "example/api-server");
  const id = createIssue(s.me, { workspaceId: s.ws.id, title: "検索を速くする", description: "遅い" }).id;
  return { ...s, app, id, posts: () => calls.filter((a) => a.includes("POST")).length };
}

test("下見・再検査・作成・状態の取得", async () => {
  const { app, id, posts } = fixture();
  const preview = await call(app, "POST", `/api/issues/${id}/github/preview`);
  expect(preview.status).toBe(200);
  expect(preview.json).toMatchObject({ repo: "example/api-server", ghLogin: "alice", findings: [] });
  const check = await call(app, "POST", `/api/issues/${id}/github/check`, { title: "x", body: "http://localhost:5123/ と API-1" });
  expect(check.json.findings.map((f: { rule: string }) => f.rule).sort()).toEqual(["issue_id", "nod_web"]);
  const leak = await call(app, "POST", `/api/issues/${id}/github/publish`, { title: "API-1", body: "", repo: "example/api-server", ghLogin: "alice" });
  expect(leak.status).toBe(422);
  expect(leak.json.error.code).toBe("LEAK_DETECTED");
  expect(leak.json.error.details.findings).toHaveLength(1);
  const sent = await call(app, "POST", `/api/issues/${id}/github/publish`, { title: "検索を速くする", body: "遅い", repo: "example/api-server", ghLogin: "alice" });
  expect(sent.status).toBe(200);
  expect(sent.json.number).toBe(41);
  const again = await call(app, "POST", `/api/issues/${id}/github/publish`, { title: "検索を速くする", body: "遅い", repo: "example/api-server", ghLogin: "alice" });
  expect(again.status).toBe(409);
  expect(posts()).toBe(1);
  expect((await call(app, "GET", `/api/issues/${id}/github`)).json.link.number).toBe(41);
});

test("宛先の変化は 409、知らないキーは 400", async () => {
  const { app, id } = fixture();
  const changed = await call(app, "POST", `/api/issues/${id}/github/publish`, { title: "t", body: "", repo: "example/other", ghLogin: "alice" });
  expect(changed.status).toBe(409);
  expect(changed.json.error.code).toBe("GITHUB_TARGET_CHANGED");
  expect((await call(app, "POST", `/api/issues/${id}/github/publish`, { title: "t", body: "", repo: "example/api-server", ghLogin: "alice", force: true })).status).toBe(400);
});

test("紐付け・解除・結果不明の解除", async () => {
  const { app, id } = fixture();
  const linked = await call(app, "POST", `/api/issues/${id}/github/link`, { url: "https://github.com/example/api-server/issues/7" });
  expect(linked.json.link.number).toBe(7);
  expect((await call(app, "DELETE", `/api/issues/${id}/github/link`)).json.link).toBeNull();
  const clear = await call(app, "POST", `/api/issues/${id}/github/clear-unknown`);
  expect(clear.status).toBe(409);
  expect(clear.json.error.code).toBe("INVALID_STATE");
});

test("Workspace の公開先の読み書きと origin の候補、worktree 名", async () => {
  const { app, id } = fixture({ repo: false });
  expect((await call(app, "GET", "/api/workspaces/API/github-repo")).json).toMatchObject({ repo: null, originCandidate: "example/api-server" });
  expect((await call(app, "PUT", "/api/workspaces/API/github-repo", { repo: "Example/API-Server" })).json.repo).toBe("example/api-server");
  expect((await call(app, "DELETE", "/api/workspaces/API/github-repo")).json.repo).toBeNull();
  expect((await call(app, "GET", `/api/issues/${id}/worktree-name?feature=search-n1`)).json).toEqual({ issueId: id, name: "search-n1-a67fefb7" });
});

test("結果不明は 502、記録失敗は 500 で url を details に載せる", async () => {
  const s = setup();
  const exitedOk = (stdout: string): GhRunResult => ({ kind: "exited", exitCode: 0, stdout, stderr: "" });
  const gh: GhRunner = async (args) => {
    if (args.includes("user")) return exitedOk("alice\n");
    return { kind: "timeout" };
  };
  const app = createApp({ db: s.db, ghRunner: gh, gitRunner: async () => exitedOk(""), webPort: () => 5123 });
  setWorkspaceGithubRepo(s.me, "API", "example/api-server");
  const id = createIssue(s.me, { workspaceId: s.ws.id, title: "t", description: "" }).id;
  const r = await call(app, "POST", `/api/issues/${id}/github/publish`, { title: "t", body: "", repo: "example/api-server", ghLogin: "alice" });
  expect(r.status).toBe(502);
  expect(r.json.error.code).toBe("GITHUB_RESULT_UNKNOWN");
});

test("GITHUB_RECORD_FAILED は 500 で details.url を返す", async () => {
  const { toErrorResponse } = await import("../src/errors");
  const { NodError } = await import("@nod/core");
  const { status, body } = toErrorResponse(new NodError("GITHUB_RECORD_FAILED", "m", { url: "https://github.com/a/b/issues/1" }));
  expect(status).toBe(500);
  expect(body.error.details).toEqual({ url: "https://github.com/a/b/issues/1" });
});
