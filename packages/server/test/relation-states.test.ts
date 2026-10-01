import { expect, test } from "bun:test";
import { archiveIssue, createIssue, relateIssue, updateIssue } from "@nod/core";
import { call, setup } from "./helpers";

test("GET /api/issues/:id は、関係の相手の状態を relationStates で返す（#203）", async () => {
  const { app, me, ws } = setup();
  const make = (title: string) => createIssue(me, { workspaceId: ws.id, title });
  const target = make("ブロックされる");
  const archived = make("アーカイブするブロック元");
  const done = make("完了するブロック元");
  const canceled = make("キャンセルするブロック元");
  const open = make("残るブロック元");
  const related = make("アーカイブする関連");
  for (const b of [archived, done, canceled, open]) relateIssue(me, b.id, { blocks: target.id });
  relateIssue(me, target.id, { related: related.id });
  archiveIssue(me, archived.id);
  archiveIssue(me, related.id);
  updateIssue(me, done.id, { status: "done" });
  updateIssue(me, canceled.id, { status: "canceled" });

  const detail = (await call(app, "GET", `/api/issues/${target.id}`)).json;
  // relations は相手を落とさず、数えないブロック元は relationStates で見分ける
  expect(detail.relations.blockedBy).toEqual([archived.id, done.id, canceled.id, open.id]);
  expect(detail.relationStates).toEqual({
    [archived.id]: { status: "todo", archived: true },
    [done.id]: { status: "done", archived: false },
    [canceled.id]: { status: "canceled", archived: false },
    [open.id]: { status: "todo", archived: false },
    [related.id]: { status: "todo", archived: true },
  });
  // 数えるブロック元（一覧・ボードに出るもの）は open だけ
  expect(detail.blockedBy).toEqual([open.id]);
});
