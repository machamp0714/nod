import { expect, test } from "bun:test";
import { acceptTriage, createIssue, proposeTriage } from "@nod/core";
import { call, setup } from "./helpers";

test("GET /api/triage/:id/proposals は記録された提案を新しい順に返し、DBを変えない。提案を書く API は無い", async () => {
  const { db, app, ws, me, llm } = setup();
  const original = createIssue(me, { workspaceId: ws.id, title: "元" });
  const triage = createIssue(llm, { workspaceId: ws.id, title: "判断待ち" });
  expect((await call(app, "GET", `/api/triage/${triage.id}/proposals`)).json).toEqual([]);
  proposeTriage(llm, triage.id, { decision: "duplicate", duplicateOf: original.id, reason: "同じ症状" });
  const before = db.serialize();
  const r = await call(app, "GET", `/api/triage/${triage.id}/proposals`);
  expect(r.status).toBe(200);
  expect(r.json).toEqual([expect.objectContaining({ issueId: triage.id, actor: llm.actor, decision: "duplicate", duplicateOf: original.id, reason: "同じ症状" })]);
  expect(db.serialize()).toEqual(before);
  expect((await call(app, "POST", `/api/triage/${triage.id}/proposals`, { decision: "accept" })).status).toBe(404);
  expect((await call(app, "GET", "/api/triage/API-999/proposals")).status).toBe(404);
  db.close();
});

test("GET /api/triage/proposal-counts は Triage 中の Issue ごとの提案者の数を返す（#125）", async () => {
  const { db, app, ws, me, llm } = setup();
  const a = createIssue(llm, { workspaceId: ws.id, title: "2人が提案" });
  const b = createIssue(llm, { workspaceId: ws.id, title: "確定済み" });
  createIssue(llm, { workspaceId: ws.id, title: "提案なし" });
  expect((await call(app, "GET", "/api/triage/proposal-counts")).json).toEqual({});
  proposeTriage(llm, a.id, { decision: "accept" });
  proposeTriage({ db, actor: "codex" }, a.id, { decision: "decline" });
  proposeTriage(llm, b.id, { decision: "accept" });
  acceptTriage(me, b.id);
  const r = await call(app, "GET", "/api/triage/proposal-counts");
  expect(r.status).toBe(200);
  expect(r.json).toEqual({ [a.id]: 2 });
  db.close();
});
