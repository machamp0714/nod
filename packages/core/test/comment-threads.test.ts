import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { commentIssue, createIssue, getIssue } from "../src/ops/issues";
import { MIGRATIONS } from "../src/schema";
import { codeOf, setup, tempDbPath } from "./helpers";

const commentsOf = (activity: ReturnType<typeof getIssue>["activity"]) => activity.filter((a) => a.kind === "comment");

describe("コメントのスレッド返信", () => {
  test("返信は親コメントの replies に並び、Activity には親だけが親の時刻で並ぶ", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const root = commentIssue(me, i.id, "原因は？");
    const other = commentIssue(me, i.id, "別の話題");
    const reply = commentIssue(llm, i.id, "N+1 でした", { replyTo: root.id });
    expect(root.parentId).toBeNull();
    expect(reply).toMatchObject({ parentId: root.id, author: "claude-code", body: "N+1 でした" });
    const comments = commentsOf(getIssue(db, i.id).activity);
    expect(comments.map((c) => c.id)).toEqual([root.id, other.id]);
    expect(comments[0]).toMatchObject({ body: "原因は？", actor: "me" });
    expect(comments[0]!.replies).toEqual([
      { id: reply.id, at: reply.createdAt, actor: "claude-code", body: "N+1 でした" },
    ]);
    expect(comments[1]!.replies).toEqual([]);
  });

  test("返信への返信はスレッドの親へ付け替えて1階層に保つ", () => {
    const { db, ws, me, llm } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const root = commentIssue(me, i.id, "親");
    const reply = commentIssue(llm, i.id, "返信", { replyTo: root.id });
    const nested = commentIssue(me, i.id, "返信への返信", { replyTo: reply.id });
    expect(nested.parentId).toBe(root.id);
    const [thread] = commentsOf(getIssue(db, i.id).activity);
    expect(thread!.replies.map((r) => r.body)).toEqual(["返信", "返信への返信"]);
  });

  test("存在しない親と他 Issue のコメントへの返信は拒否し、何も書かない", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    const onB = commentIssue(me, b.id, "B のコメント");
    expect(codeOf(() => commentIssue(me, a.id, "x", { replyTo: 9999 }))).toBe("NOT_FOUND");
    expect(codeOf(() => commentIssue(me, a.id, "x", { replyTo: onB.id }))).toBe("INVALID_ARGS");
    expect(codeOf(() => commentIssue(me, a.id, "", { replyTo: onB.id }))).toBe("INVALID_ARGS");
    expect((db.query("SELECT count(*) AS n FROM comments").get() as { n: number }).n).toBe(1);
  });
});

test("スレッド導入前の DB のコメントは、移行後にスレッドの親として扱う", () => {
  const path = tempDbPath();
  const raw = new Database(path, { create: true });
  raw.exec("PRAGMA foreign_keys=ON");
  for (const step of MIGRATIONS[0]!) raw.exec(step as string);
  raw.exec("PRAGMA user_version=1");
  raw.exec("INSERT INTO workspaces (id,key,name,path,next_number,created_at) VALUES (1,'API','API','/repos/api',2,'')");
  raw.exec("INSERT INTO issues (id,workspace_id,number,title,status,created_by,created_at,updated_at) VALUES (1,1,1,'t','todo','me','','')");
  raw.exec("INSERT INTO comments (issue_id,author,body,created_at) VALUES (1,'me','旧コメント','2026-09-01T00:00:00.000Z')");
  raw.close();
  const db = openDb(path);
  const [old] = commentsOf(getIssue(db, "API-1").activity);
  expect(old).toMatchObject({ body: "旧コメント", replies: [] });
  const reply = commentIssue({ db, actor: "me" }, "API-1", "返信", { replyTo: old!.id });
  expect(reply.parentId).toBe(old!.id);
  db.close();
});
