import {
  checkGithubPublishText,
  clearUnknownGithubPublish,
  clearWorkspaceGithubRepo,
  type GhRunner,
  getGithubState,
  getWorkspaceGithubRepoView,
  getWorktreeName,
  type GithubPublishDeps,
  gitRunner,
  linkGithubIssue,
  type OpCtx,
  previewGithubPublish,
  publishGithubIssue,
  setWorkspaceGithubRepo,
  unlinkGithubIssue,
} from "@nod/core";
import type { Hono } from "hono";
import { type Body, invalid, readBody, reqString } from "../input";

export interface GithubRouteOptions {
  gh?: GhRunner;
  git?: GhRunner;
  webPort?: () => number | undefined; // 検出に使う、server が待ち受けている実際のポート
}

const optText = (b: Body, key: string): string => {
  if (b[key] === undefined) return "";
  if (typeof b[key] !== "string") throw invalid(`${key} は文字列で指定してください`);
  return b[key] as string;
};

// nod の Issue を GitHub Issue として作成する（人の確認ダイアログから呼ばれる）。/api/issues/:id/:op より先に登録する
export function registerGithubRoutes(app: Hono, me: OpCtx, opts: GithubRouteOptions = {}): void {
  const deps = (): GithubPublishDeps => ({ gh: opts.gh, git: opts.git, webPort: opts.webPort?.() });
  app.get("/api/issues/:id/github", (c) => c.json(getGithubState(me.db, c.req.param("id"))));
  app.post("/api/issues/:id/github/preview", async (c) => c.json(await previewGithubPublish(me, c.req.param("id"), deps())));
  app.post("/api/issues/:id/github/check", async (c) => {
    const b = await readBody(c, ["title", "body"]);
    return c.json({ findings: checkGithubPublishText(me.db, { title: optText(b, "title"), body: optText(b, "body") }, deps()) });
  });
  app.post("/api/issues/:id/github/publish", async (c) => {
    const b = await readBody(c, ["title", "body", "repo", "ghLogin"]);
    const input = { title: optText(b, "title"), body: optText(b, "body"), repo: reqString(b, "repo"), ghLogin: reqString(b, "ghLogin") };
    return c.json(await publishGithubIssue(me, c.req.param("id"), input, deps()));
  });
  app.post("/api/issues/:id/github/clear-unknown", (c) => c.json(clearUnknownGithubPublish(me, c.req.param("id"))));
  app.post("/api/issues/:id/github/link", async (c) => {
    const b = await readBody(c, ["url"]);
    return c.json(await linkGithubIssue(me, c.req.param("id"), reqString(b, "url"), opts.gh));
  });
  app.delete("/api/issues/:id/github/link", (c) => c.json(unlinkGithubIssue(me, c.req.param("id"))));
  app.get("/api/issues/:id/worktree-name", (c) => c.json(getWorktreeName(me.db, c.req.param("id"), c.req.query("feature") ?? "")));
  app.get("/api/workspaces/:key/github-repo", async (c) => c.json(await getWorkspaceGithubRepoView(me.db, c.req.param("key"), opts.git ?? gitRunner)));
  app.put("/api/workspaces/:key/github-repo", async (c) => {
    const b = await readBody(c, ["repo"]);
    return c.json(setWorkspaceGithubRepo(me, c.req.param("key"), reqString(b, "repo")));
  });
  app.delete("/api/workspaces/:key/github-repo", (c) => c.json(clearWorkspaceGithubRepo(me, c.req.param("key"))));
}
