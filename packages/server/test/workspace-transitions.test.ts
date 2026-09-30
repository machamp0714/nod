import { describe, expect, test } from "bun:test";
import { createIssue, getTransitionRules, setTransitionRules } from "@nod/core";
import { call, setup } from "./helpers";

describe("ステータス遷移ルールAPI（#73）", () => {
  test("未設定なら GET は制限なし", async () => {
    const { app, ws } = setup();
    const res = await call(app, "GET", `/api/workspaces/${ws.key}/transitions`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ workspaceKey: ws.key, forbidden: [], presets: [] });
  });

  test("PUT で全体を置き換え、DELETE ですべて解除する", async () => {
    const { app, db, ws } = setup();
    const put = await call(app, "PUT", `/api/workspaces/${ws.key}/transitions`, {
      forbidden: [{ from: "backlog", to: "done" }],
      presets: ["review_before_done"],
    });
    expect(put.status).toBe(200);
    expect(put.json).toEqual({ workspaceKey: ws.key, forbidden: [{ from: "backlog", to: "done" }], presets: ["review_before_done"] });
    expect(getTransitionRules(db, ws.key)).toEqual(put.json);
    const del = await call(app, "DELETE", `/api/workspaces/${ws.key}/transitions`);
    expect(del.status).toBe(200);
    expect(del.json).toEqual({ workspaceKey: ws.key, forbidden: [], presets: [] });
  });

  test("不正な本文は 400 で、DB を保つ", async () => {
    const { app, db, ws, me } = setup();
    setTransitionRules(me, ws.key, { forbidden: [{ from: "todo", to: "done" }] });
    for (const body of [
      { forbidden: "x" },
      { forbidden: [{ from: "todo" }] },
      { forbidden: [["todo", "done"]] },
      { forbidden: [{ from: "in_review", to: "done" }] },
      { presets: ["nope"] },
      { presets: "review_before_done" },
      { forbidden: [], actor: "codex" },
    ]) {
      const res = await call(app, "PUT", `/api/workspaces/${ws.key}/transitions`, body);
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe("INVALID_ARGS");
    }
    expect(getTransitionRules(db, ws.key).forbidden).toEqual([{ from: "todo", to: "done" }]);
  });

  test("未登録の Workspace は 404", async () => {
    const { app } = setup();
    expect((await call(app, "GET", "/api/workspaces/NOPE/transitions")).status).toBe(404);
  });

  test("違反する状態変更は 409 TRANSITION_NOT_ALLOWED で、どのルールかを返す", async () => {
    const { app, ws, me } = setup();
    const issue = createIssue(me, { workspaceId: ws.id, title: "a" });
    setTransitionRules(me, ws.key, { presets: ["review_before_done"] });
    const res = await call(app, "POST", `/api/issues/${issue.id}/update`, { status: "done" });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatchObject({
      code: "TRANSITION_NOT_ALLOWED",
      details: { from: "todo", to: "done", rule: { kind: "preset", preset: "review_before_done" } },
    });
    expect(res.json.error.message).toContain("done の前に in_review 必須");
  });
});
