import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { addFileAttachment, attachmentFile } from "../src/ops/attachments";
import { deleteIssue, listIssueDeletions } from "../src/ops/issue-deletions";
import { archiveIssue, commentIssue, createIssue, getIssue, relateIssue } from "../src/ops/issues";
import { subscribeIssue } from "../src/ops/notifications";
import { initWorkspace, removeWorkspace } from "../src/ops/workspaces";
import { codeOf, setup } from "./helpers";

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function count(db: ReturnType<typeof setup>["db"], table: string, where: string, ...args: (string | number)[]): number {
  return (db.query(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...args) as { n: number }).n;
}

describe("deleteIssue", () => {
  test("アーカイブしていない Issue は INVALID_STATE で消せない", () => {
    const { me, ws, db } = setup();
    const issue = createIssue(me, { workspaceId: ws.id, title: "残す" });
    let err: unknown;
    try {
      deleteIssue(me, issue.id);
    } catch (e) {
      err = e;
    }
    expect((err as { code: string }).code).toBe("INVALID_STATE");
    expect((err as Error).message).toContain("先にアーカイブしてください");
    expect(getIssue(db, issue.id).id).toBe(issue.id);
  });

  test("LLM は FORBIDDEN_FOR_LLM で消せない", () => {
    const { me, llm, ws, db } = setup();
    const issue = createIssue(me, { workspaceId: ws.id, title: "x" });
    archiveIssue(me, issue.id);
    expect(codeOf(() => deleteIssue(llm, issue.id))).toBe("FORBIDDEN_FOR_LLM");
    expect(getIssue(db, issue.id).id).toBe(issue.id);
  });

  test("ない Issue は NOT_FOUND", () => {
    const { me } = setup();
    expect(codeOf(() => deleteIssue(me, "API-999"))).toBe("NOT_FOUND");
  });

  test("消すと監査ログに ID・タイトル・削除者・日時が残り、関連する行は消え、子と定期Issueの記録は残る", () => {
    const { me, llm, ws, db } = setup();
    const parent = createIssue(me, { workspaceId: ws.id, title: "消す親" });
    const child = createIssue(me, { workspaceId: ws.id, title: "子", parentRef: parent.id });
    const other = createIssue(me, { workspaceId: ws.id, title: "関係先" });
    relateIssue(me, parent.id, { blocks: other.id });
    commentIssue(me, parent.id, "メモ");
    subscribeIssue(me, parent.id);
    commentIssue(llm, parent.id, "調べました");
    const row = db.query("SELECT id FROM issues WHERE number = ?").get(Number(parent.id.split("-")[1])) as { id: number };
    db.query(
      `INSERT INTO recurring_issues (workspace_id, title, cadence, start_date, time_zone, created_by, created_at, updated_by, updated_at)
       VALUES (?, '週次', 'daily', '2026-09-01', 'UTC', 'me', '', 'me', '')`,
    ).run(ws.id);
    db.query("INSERT INTO recurring_issue_occurrences (recurring_id, occurrence_date, issue_id, created_at) VALUES (1, '2026-09-01', ?, '')").run(row.id);
    archiveIssue(me, parent.id);
    // 消えることを確かめる前に、消える対象の行が実際にあることを確かめる
    for (const table of ["comments", "events", "notifications", "subscriptions"]) {
      expect(count(db, table, "issue_id = ?", row.id)).toBeGreaterThan(0);
    }
    expect(count(db, "relations", "from_id = ? OR to_id = ?", row.id, row.id)).toBeGreaterThan(0);

    const deletion = deleteIssue(me, parent.id);
    expect(deletion).toMatchObject({ issueId: parent.id, title: "消す親", deletedBy: "me" });
    expect(deletion.deletedAt).toMatch(/^\d{4}-/);
    expect(deletion.archivedAt).not.toBeNull();

    expect(codeOf(() => getIssue(db, parent.id))).toBe("NOT_FOUND");
    expect(getIssue(db, child.id).parentId ?? null).toBeNull();
    for (const table of ["relations"]) expect(count(db, table, "from_id = ? OR to_id = ?", row.id, row.id)).toBe(0);
    for (const table of ["comments", "events", "notifications", "subscriptions"]) {
      expect(count(db, table, "issue_id = ?", row.id)).toBe(0);
    }
    expect(count(db, "recurring_issue_occurrences", "occurrence_date = '2026-09-01' AND issue_id IS NULL")).toBe(1);
    expect(listIssueDeletions(db, ws.key)).toEqual([deletion]);
  });

  test("添付の行と実体ファイルを消す", () => {
    const { me, ws, db } = setup();
    const issue = createIssue(me, { workspaceId: ws.id, title: "添付あり" });
    const src = tempDir("nod-del-src-");
    const dir = join(tempDir("nod-del-root-"), "attachments");
    const path = join(src, "log.txt");
    writeFileSync(path, "hello");
    const a = addFileAttachment(me, issue.id, { path, dir });
    const stored = attachmentFile(db, a.id, dir).abs;
    expect(existsSync(stored)).toBe(true);
    archiveIssue(me, issue.id);

    deleteIssue(me, issue.id, dir);
    expect(existsSync(stored)).toBe(false);
    expect(count(db, "issue_attachments", "1 = 1")).toBe(0);
  });

  test("添付の実体を消せなくても削除は成功を返し、実体は残る（gcAttachments に任せる）", () => {
    const { me, ws, db } = setup();
    const issue = createIssue(me, { workspaceId: ws.id, title: "添付あり" });
    const src = tempDir("nod-del-src-");
    const dir = join(tempDir("nod-del-root-"), "attachments");
    const path = join(src, "log.txt");
    writeFileSync(path, "hello");
    const a = addFileAttachment(me, issue.id, { path, dir });
    const stored = attachmentFile(db, a.id, dir).abs;
    archiveIssue(me, issue.id);
    // 実体の入ったディレクトリを書き込み不可にして、実体の削除を失敗させる
    chmodSync(dirname(stored), 0o500);
    try {
      const deletion = deleteIssue(me, issue.id, dir);
      expect(deletion.issueId).toBe(issue.id);
      expect(codeOf(() => getIssue(db, issue.id))).toBe("NOT_FOUND");
      expect(count(db, "issue_attachments", "1 = 1")).toBe(0);
      expect(existsSync(stored)).toBe(true);
    } finally {
      chmodSync(dirname(stored), 0o700);
    }
  });

  test("監査ログは Workspace ごとに新しい順で、Workspace を消すと一緒に消える", () => {
    const { me, ws, db } = setup();
    const other = initWorkspace(db, { path: "/tmp/repos/web-app" }).workspace;
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    const c = createIssue(me, { workspaceId: other.id, title: "c" });
    for (const i of [a, b, c]) {
      archiveIssue(me, i.id);
      deleteIssue(me, i.id);
    }
    expect(listIssueDeletions(db, ws.key).map((d) => d.issueId)).toEqual([b.id, a.id]);
    expect(listIssueDeletions(db, other.key).map((d) => d.issueId)).toEqual([c.id]);
    expect(codeOf(() => listIssueDeletions(db, "NOPE"))).toBe("NOT_FOUND");

    removeWorkspace(db, ws.key, tempDir("nod-del-ws-"));
    expect(count(db, "issue_deletions", "1 = 1")).toBe(1);
  });

  test("消した番号は次の Issue で再利用されない", () => {
    const { me, ws } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    archiveIssue(me, a.id);
    deleteIssue(me, a.id);
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    expect(b.id).not.toBe(a.id);
  });
});
