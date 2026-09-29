import { describe, expect, test } from "bun:test";
import { createIssue, findIssueRow, getAutomationSettings, getIssue, setAutomationSettings } from "@nod/core";
import { call, setup } from "./helpers";

const old = "2020-01-01T00:00:00.000Z";

function staleIssue(s: ReturnType<typeof setup>, status = "todo"): string {
  const issue = createIssue(s.me, { workspaceId: s.ws.id, title: status });
  const id = findIssueRow(s.db, issue.id).id;
  const closedAt = status === "done" || status === "canceled" ? old : null;
  s.db.query("UPDATE issues SET status=?, created_at=?, updated_at=?, closed_at=? WHERE id=?").run(status, old, old, closedAt, id);
  s.db.query("UPDATE events SET created_at=? WHERE issue_id=?").run(old, id);
  return issue.id;
}

describe("自動化API", () => {
  test("GET は未設定なら両ルール null、PUT で部分更新・無効化し、書き手は me", async () => {
    const s = setup();
    const url = `/api/workspaces/${s.ws.key}/automation`;
    expect((await call(s.app, "GET", url)).json).toMatchObject({ closeAfterDays: null, archiveAfterDays: null });
    const put = await call(s.app, "PUT", url, { closeAfterDays: 30, archiveAfterDays: 7 });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ workspaceKey: s.ws.key, closeAfterDays: 30, archiveAfterDays: 7, updatedBy: "me" });
    await call(s.app, "PUT", url, { archiveAfterDays: null });
    expect(getAutomationSettings(s.db, s.ws.key)).toMatchObject({ closeAfterDays: 30, archiveAfterDays: null });
  });

  test("不正な日数・未知のキー・未登録の Workspace を拒み、設定を保つ", async () => {
    const s = setup();
    setAutomationSettings(s.me, s.ws.key, { closeAfterDays: 30 });
    const url = `/api/workspaces/${s.ws.key}/automation`;
    for (const body of [{ closeAfterDays: 0 }, { closeAfterDays: 3651 }, { closeAfterDays: 1.5 }, { closeAfterDays: "30" }, { actor: "codex" }, "{"]) {
      const res = await call(s.app, "PUT", url, body);
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe("INVALID_ARGS");
    }
    expect(getAutomationSettings(s.db, s.ws.key).closeAfterDays).toBe(30);
    expect((await call(s.app, "GET", "/api/workspaces/ZZZ/automation")).status).toBe(404);
    expect((await call(s.app, "POST", "/api/workspaces/ZZZ/automation/run", { dryRun: true })).status).toBe(404);
  });

  test("dry-run は対象を返すだけ、実行で canceled・アーカイブし、2回目は0件", async () => {
    const s = setup();
    setAutomationSettings(s.me, s.ws.key, { closeAfterDays: 30, archiveAfterDays: 30 });
    const open = staleIssue(s);
    const done = staleIssue(s, "done");
    const url = `/api/workspaces/${s.ws.key}/automation/run`;
    const dry = await call(s.app, "POST", url, { dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.json.dryRun).toBe(true);
    expect(dry.json.rules.map((r: { candidates: { id: string }[] }) => r.candidates.map((c) => c.id))).toEqual([[open], [done]]);
    expect(getIssue(s.db, open).status).toBe("todo");
    const run = await call(s.app, "POST", url, {});
    expect(run.json.rules.map((r: { processed: string[] }) => r.processed)).toEqual([[open], [done]]);
    expect(getIssue(s.db, open).status).toBe("canceled");
    expect(getIssue(s.db, done).archivedAt).toBeString();
    const again = await call(s.app, "POST", url, {});
    expect(again.json.rules.map((r: { total: number }) => r.total)).toEqual([0, 0]);
  });

  test("不正な dryRun・limit を拒む", async () => {
    const s = setup();
    const url = `/api/workspaces/${s.ws.key}/automation/run`;
    for (const body of [{ dryRun: "yes" }, { limit: 0 }, { limit: 501 }, { limit: "5" }, { evaluatedAt: "2020-01-01T00:00:00Z" }]) {
      const res = await call(s.app, "POST", url, body);
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe("INVALID_ARGS");
    }
  });

  test("外部 Origin からの変更・実行を拒む", async () => {
    const s = setup();
    setAutomationSettings(s.me, s.ws.key, { closeAfterDays: 1 });
    const open = staleIssue(s);
    for (const [method, path, body] of [
      ["PUT", "automation", { closeAfterDays: 5 }],
      ["POST", "automation/run", {}],
    ] as const) {
      const res = await s.app.request(`/api/workspaces/${s.ws.key}/${path}`, {
        method,
        headers: { Origin: "https://example.com", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
    }
    expect(getAutomationSettings(s.db, s.ws.key).closeAfterDays).toBe(1);
    expect(getIssue(s.db, open).status).toBe("todo");
  });
});
