// packages/core/test/github-repo.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitRunner } from "../src/ops/git-sync";
import {
  clearWorkspaceGithubRepo,
  getWorkspaceGithubRepo,
  getWorkspaceGithubRepoView,
  normalizeGithubRepo,
  parseGithubRemote,
  readOriginRepo,
  setWorkspaceGithubRepo,
} from "../src/ops/github-repo";
import { codeOf, setup } from "./helpers";

function repoWithOrigin(url: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "nod-origin-"));
  Bun.spawnSync(["git", "init", "-q", dir]);
  if (url) Bun.spawnSync(["git", "-C", dir, "remote", "add", "origin", url]);
  return dir;
}

describe("origin の URL を owner/repo にする", () => {
  test.each([
    ["https://github.com/Example/API-Server.git", "example/api-server"],
    ["https://github.com/example/api-server", "example/api-server"],
    ["https://github.com/example/api-server/", "example/api-server"],
    ["https://token@github.com/example/api.server.git", "example/api.server"],
    ["git@github.com:Example/api-server.git", "example/api-server"],
    ["ssh://git@github.com/example/api-server.git", "example/api-server"],
    ["ssh://git@github.com:22/example/api-server", "example/api-server"],
  ])("%s → %s", (url, repo) => {
    expect(parseGithubRemote(url)).toEqual({ repo, reason: null });
  });

  test("github.com 以外のホストと、SSH のホスト別名は解決しない。形が違えば unparsable", () => {
    expect(parseGithubRemote("https://gitlab.com/example/api-server.git")).toEqual({ repo: null, reason: "other_host" });
    expect(parseGithubRemote("git@github-work:example/api-server.git")).toEqual({ repo: null, reason: "other_host" });
    expect(parseGithubRemote("/srv/git/api-server.git")).toEqual({ repo: null, reason: "unparsable" });
    expect(parseGithubRemote("https://github.com/only-owner")).toEqual({ repo: null, reason: "unparsable" });
  });

  test("git の remote から読む。origin がなければ no_origin", async () => {
    expect(await readOriginRepo(gitRunner, repoWithOrigin("git@github.com:Example/API-Server.git"))).toEqual({ repo: "example/api-server", reason: null });
    expect(await readOriginRepo(gitRunner, repoWithOrigin(null))).toEqual({ repo: null, reason: "no_origin" });
    expect(await readOriginRepo(gitRunner, "/nonexistent/nod-test")).toEqual({ repo: null, reason: "no_origin" });
  });
});

describe("Workspace の公開先", () => {
  test("人は設定・解除でき、値は小文字の owner/repo。LLM は変えられない", () => {
    const { db, me, llm } = setup();
    expect(getWorkspaceGithubRepo(db, "API")).toEqual({ workspaceKey: "API", repo: null, updatedAt: null, updatedBy: null });
    const set = setWorkspaceGithubRepo(me, "API", "Example/API-Server");
    expect(set.repo).toBe("example/api-server");
    expect(set.updatedBy).toBe("me");
    expect(codeOf(() => setWorkspaceGithubRepo(llm, "API", "example/other"))).toBe("FORBIDDEN_FOR_LLM");
    expect(codeOf(() => clearWorkspaceGithubRepo(llm, "API"))).toBe("FORBIDDEN_FOR_LLM");
    expect(codeOf(() => setWorkspaceGithubRepo(me, "API", "-bad/repo"))).toBe("INVALID_ARGS");
    expect(codeOf(() => setWorkspaceGithubRepo(me, "NOPE", "example/x"))).toBe("NOT_FOUND");
    expect(clearWorkspaceGithubRepo(me, "API").repo).toBeNull();
  });

  test("未設定なら origin の候補を返し、設定済みなら origin を読まない", async () => {
    const { db, me } = setup();
    db.query("UPDATE workspaces SET path = ?").run(repoWithOrigin("https://github.com/Example/API-Server.git"));
    const calls: string[][] = [];
    const git: typeof gitRunner = async (args, o) => {
      calls.push(args);
      return gitRunner(args, o);
    };
    expect((await getWorkspaceGithubRepoView(db, "API", git)).originCandidate).toBe("example/api-server");
    setWorkspaceGithubRepo(me, "API", "example/api-server");
    calls.length = 0;
    expect((await getWorkspaceGithubRepoView(db, "API", git)).originCandidate).toBeNull();
    expect(calls).toEqual([]);
  });

  test("normalizeGithubRepo は前後の空白を除き、小文字にする", () => {
    expect(normalizeGithubRepo("  Example/Repo.js ")).toBe("example/repo.js");
    expect(codeOf(() => normalizeGithubRepo("example"))).toBe("INVALID_ARGS");
  });
});
