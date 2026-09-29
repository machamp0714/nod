import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addFileAttachment, archiveIssue, attachmentFile, createIssue, getIssue, HUMAN_ACTOR, initWorkspace, openDb } from "@nod/core";
import { createApp } from "../src/app";
import { call, tempDir } from "./helpers";

function setupAttachments() {
  const db = openDb(join(tempDir(), "nod.db"));
  const ws = initWorkspace(db, { path: "/tmp/repos/api-server" }).workspace;
  const me = { db, actor: HUMAN_ACTOR };
  const attachmentsDir = join(tempDir("nod-attachments-"), "root");
  const issue = createIssue(me, { workspaceId: ws.id, title: "添付" });
  const src = tempDir("nod-attach-src-");
  const file = (name: string, content = "hello") => {
    const path = join(src, name);
    writeFileSync(path, content);
    return addFileAttachment(me, issue.id, { path, dir: attachmentsDir });
  };
  return { db, me, issue, attachmentsDir, file, app: createApp({ db, attachmentsDir }) };
}

describe("添付 API", () => {
  test("POST /api/issues/:id/attachments はリンクを足して 201、Issue の詳細に載る", async () => {
    const { app, issue } = setupAttachments();
    const r = await call(app, "POST", `/api/issues/${issue.id}/attachments`, { url: "https://example.com/a", title: "仕様" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ kind: "link", url: "https://example.com/a", title: "仕様", createdBy: "me" });
    const detail = await call(app, "GET", `/api/issues/${issue.id}`);
    expect(detail.json.attachments).toMatchObject([{ id: r.json.id, kind: "link" }]);
  });

  test("危険なスキーム・未知のキー・ファイルのパスは 400", async () => {
    const { app, issue } = setupAttachments();
    for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd"]) {
      const r = await call(app, "POST", `/api/issues/${issue.id}/attachments`, { url });
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe("INVALID_ARGS");
    }
    expect((await call(app, "POST", `/api/issues/${issue.id}/attachments`, { path: "/etc/passwd" })).status).toBe(400);
    expect((await call(app, "POST", `/api/issues/${issue.id}/attachments`, {})).status).toBe(400);
  });

  test("DELETE は添付を消してファイルも消す。無い添付は 404", async () => {
    const { app, db, issue, file, attachmentsDir } = setupAttachments();
    const f = file("a.txt");
    const abs = attachmentFile(db, f.id, attachmentsDir).abs;
    const r = await call(app, "DELETE", `/api/issues/${issue.id}/attachments/${f.id}`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ removed: f.id });
    expect(existsSync(abs)).toBe(false);
    expect(getIssue(db, issue.id).attachments).toEqual([]);
    expect((await call(app, "DELETE", `/api/issues/${issue.id}/attachments/${f.id}`)).status).toBe(404);
    expect((await call(app, "DELETE", `/api/issues/${issue.id}/attachments/abc`)).status).toBe(400);
  });

  test("外部サイトからの追加と削除は 403", async () => {
    const { app, issue } = setupAttachments();
    const res = await app.request(`/api/issues/${issue.id}/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ url: "https://e.com" }),
    });
    expect(res.status).toBe(403);
  });

  test("アーカイブ中は追加も削除も 409、ダウンロードはできる", async () => {
    const { app, me, issue, file } = setupAttachments();
    const f = file("a.txt");
    archiveIssue(me, issue.id);
    expect((await call(app, "POST", `/api/issues/${issue.id}/attachments`, { url: "https://e.com" })).json.error.code).toBe("ISSUE_ARCHIVED");
    expect((await call(app, "DELETE", `/api/issues/${issue.id}/attachments/${f.id}`)).status).toBe(409);
    expect((await app.request(`/api/attachments/${f.id}/download`)).status).toBe(200);
  });

  test("GET /api/attachments/:id/download は attachment として配信する", async () => {
    const { app, file } = setupAttachments();
    const f = file("報告 \"1\".pdf", "%PDF");
    const res = await app.request(`/api/attachments/${f.id}/download`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("%PDF");
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="__ _1_.pdf"; filename*=UTF-8''%E5%A0%B1%E5%91%8A%20%221%22.pdf`,
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("リンク・無い添付・消えたファイルのダウンロードは 404", async () => {
    const { app, db, issue, file, attachmentsDir } = setupAttachments();
    const link = await call(app, "POST", `/api/issues/${issue.id}/attachments`, { url: "https://e.com" });
    expect((await app.request(`/api/attachments/${link.json.id}/download`)).status).toBe(404);
    expect((await app.request("/api/attachments/999/download")).status).toBe(404);
    const f = file("a.txt");
    Bun.spawnSync(["rm", attachmentFile(db, f.id, attachmentsDir).abs]);
    const res = await app.request(`/api/attachments/${f.id}/download`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("FILE_NOT_FOUND");
  });
});
