import { expect, test } from "bun:test";
import { join } from "node:path";
import * as core from "../src/index";
import { codeOf, tempDbPath } from "./helpers";
import { acceptPreparedSprint, prepareSprint } from "./fixtures/sprint-start";

async function competitor(path: string, operation: string, ref: string, input: unknown) {
  const child = Bun.spawn(["bun", join(import.meta.dir, "fixtures/sprint-start-race.ts"), path, operation, ref, JSON.stringify(input)], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toBe("ready\n");
  return {
    release() { child.stdin.end(); },
    async result() {
      let text = "";
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        text += new TextDecoder().decode(part.value);
      }
      const [stderr, exit] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      expect([exit, stderr]).toEqual([0, ""]);
      return JSON.parse(text);
    },
  };
}

test("合意前に候補を読んだ別DB接続も、合意後のnext/start/一般更新では採択保護を再確認する", async () => {
  const path = tempDbPath(), db = core.openDb(path), second = core.openDb(path);
  const me = { db, actor: "me" }, other = { db: second, actor: "codex" };
  const ws = core.initWorkspace(db, { key: "RACE", path: "/tmp/sprint-start-race" }).workspace;
  const issue = core.createIssue(me, { workspaceId: ws.id, title: "採択" });
  const prepared = prepareSprint(me, ws.key, [issue.id]);
  expect(core.suggestIssue(other, { workspaceId: ws.id })?.id).toBe(issue.id);
  const children = await Promise.all([
    competitor(path, "next", "", { workspaceId: ws.id }),
    competitor(path, "start", issue.id, {}),
    competitor(path, "update", issue.id, {}),
  ]);
  acceptPreparedSprint(me, prepared);
  const before = core.getIssue(db, issue.id);
  for (const child of children) child.release();
  const results = await Promise.all(children.map(child => child.result()));
  expect(results).toEqual([{ value: null }, { error: { code: "SPRINT_CONTEXT_REQUIRED" } }, { error: { code: "SPRINT_CONTEXT_REQUIRED" } }]);
  expect(core.nextIssue(other, { workspaceId: ws.id })).toBeNull();
  expect(codeOf(() => core.startIssue(other, issue.id))).toBe("SPRINT_CONTEXT_REQUIRED");
  expect(core.getIssue(db, issue.id)).toEqual(before);
  db.close(); second.close();
});

test("別プロセスの合意とnextが競合しても直列化し、合意後は同じactorも追加着手できない", async () => {
  const path = tempDbPath(), db = core.openDb(path), me = { db, actor: "me" };
  const ws = core.initWorkspace(db, { key: "RACE", path: "/tmp/sprint-start-race" }).workspace;
  const issue = core.createIssue(me, { workspaceId: ws.id, title: "採択" });
  const prepared = prepareSprint(me, ws.key, [issue.id]);
  const children = await Promise.all([
    competitor(path, "accept", prepared.sprint.id, { planId: prepared.plan.id, mutation: { expectedVersion: prepared.sprint.version, requestKey: "合意", contentHash: prepared.plan.contentHash } }),
    competitor(path, "next", "", { workspaceId: ws.id }),
  ]);
  for (const child of children) child.release();
  const [agreement, claim] = await Promise.all(children.map(child => child.result()));
  expect(agreement.value.sprint.phase).toBe("ready");
  expect(claim.error).toBeUndefined();
  const final = core.getIssue(db, issue.id);
  if (claim.value) {
    expect(claim.value.id).toBe(issue.id);
    expect(final).toMatchObject({ status: "in_progress", assignee: "codex" });
    expect(final.activity.filter(a => a.kind === "event" && a.type === "status_changed")).toHaveLength(1);
  } else {
    expect(final).toMatchObject({ status: "todo", assignee: null });
  }
  expect(codeOf(() => core.startIssue({ db, actor: "codex" }, issue.id))).toBe("SPRINT_CONTEXT_REQUIRED");
  db.close();
});
