import { expect, test } from "bun:test";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addFileAttachment, archiveIssue, attachmentFile, createIssue, HUMAN_ACTOR, initWorkspace, openDb } from "@nod/core";
import { createApp } from "../src/app";
import { call, setup, tempDir } from "./helpers";

test("POST /api/issues/:id/delete はアーカイブ済みだけを消し、監査ログを GET /api/workspaces/:key/issue-deletions で返す", async () => {
  const { app, me, ws } = setup();
  const live = createIssue(me, { workspaceId: ws.id, title: "残す" });
  const gone = createIssue(me, { workspaceId: ws.id, title: "消す" });

  const notArchived = await call(app, "POST", `/api/issues/${live.id}/delete`, {});
  expect(notArchived.status).toBe(409);
  expect(notArchived.json.error.code).toBe("INVALID_STATE");
  expect(notArchived.json.error.message).toContain("先にアーカイブしてください");

  archiveIssue(me, gone.id);
  const r = await call(app, "POST", `/api/issues/${gone.id}/delete`);
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ issueId: gone.id, title: "消す", deletedBy: "me" });
  expect((await call(app, "GET", `/api/issues/${gone.id}`)).status).toBe(404);

  const log = await call(app, "GET", `/api/workspaces/${ws.key}/issue-deletions`);
  expect(log.status).toBe(200);
  expect(log.json).toEqual([r.json]);
});

test("不正な本文は 400、ない Issue・Workspace は 404", async () => {
  const { app, me, ws } = setup();
  const issue = createIssue(me, { workspaceId: ws.id, title: "x" });
  archiveIssue(me, issue.id);
  expect((await call(app, "POST", `/api/issues/${issue.id}/delete`, { force: true })).status).toBe(400);
  expect((await call(app, "POST", "/api/issues/API-99/delete", {})).status).toBe(404);
  expect((await call(app, "GET", "/api/workspaces/NOPE/issue-deletions")).status).toBe(404);
});

test("添付の実体は attachmentsDir の下から消える", async () => {
  const db = openDb(join(tempDir(), "nod.db"));
  const ws = initWorkspace(db, { path: "/tmp/repos/api-server" }).workspace;
  const me = { db, actor: HUMAN_ACTOR };
  const dir = realpathSync(tempDir("nod-server-attach-"));
  const src = join(realpathSync(tempDir("nod-server-src-")), "log.txt");
  writeFileSync(src, "hello");
  const app = createApp({ db, attachmentsDir: dir });
  const issue = createIssue(me, { workspaceId: ws.id, title: "添付あり" });
  const a = addFileAttachment(me, issue.id, { path: src, dir });
  const stored = attachmentFile(db, a.id, dir).abs;
  archiveIssue(me, issue.id);

  expect((await call(app, "POST", `/api/issues/${issue.id}/delete`, {})).status).toBe(200);
  expect(existsSync(stored)).toBe(false);
});
