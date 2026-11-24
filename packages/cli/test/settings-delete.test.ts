import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

for (const actor of ["me", "claude-code", "codex", "omp"]) {
  test(`${actor}: 定義の削除は --yes がなければ無変更、付ければ削除して Issue は残す`, async () => {
    const db = tempDb();
    const cwd = makeRepo();
    registerRepo(db, cwd);
    const opts = { cwd, db, actor };
    const run = (args: string[]) => runNod([...args, "--json"], opts);
    const file = join(cwd, "template.md");
    writeFileSync(file, "定型手順");
    expect((await run(["project", "create", "release"])).exitCode).toBe(0);
    expect((await run(["project", "milestone", "add", "release", "beta"])).exitCode).toBe(0);
    expect((await run(["template", "add", "daily", "--from", file])).exitCode).toBe(0);
    expect((await run(["workspace", "labels", "add", "ops", "--color", "#123456"])).exitCode).toBe(0);
    const recurring = await run(["recurring", "add", "定期作業", "--template", "daily", "--project", "release", "-l", "ops", "--every", "daily", "--start", "2020-01-01", "--tz", "UTC"]);
    expect(recurring.exitCode).toBe(0);
    const applied = await run(["recurring", "run"]);
    expect(applied.exitCode).toBe(0);
    const issueId = applied.json.items[0].issueId;
    expect((await run(["issue", "update", issueId, "--milestone", "beta"])).exitCode).toBe(0);
    const issueBefore = (await run(["issue", "show", issueId])).json;
    const targets = [
      { remove: ["project", "milestone", "remove", "release", "beta"], list: ["project", "milestone", "list", "release"] },
      { remove: ["template", "remove", "daily"], list: ["template", "list"] },
      { remove: ["recurring", "remove", String(recurring.json.id)], list: ["recurring", "list"] },
      { remove: ["workspace", "labels", "remove", "ops"], list: ["workspace", "labels", "list"] },
    ];
    for (const target of targets) {
      const before = await run(target.list);
      expect(before.exitCode).toBe(0);
      const blocked = await run(target.remove);
      expect(blocked.exitCode).toBe(1);
      expect(blocked.json.error.code).toBe("CONFIRM_REQUIRED");
      expect((await run(target.list)).json).toEqual(before.json);
    }
    expect((await run(["issue", "show", issueId])).json).toEqual(issueBefore);
    for (const target of targets) {
      expect((await run([...target.remove, "--yes"])).exitCode).toBe(0);
      expect((await run(target.list)).json).toEqual([]);
    }
    const issue = await run(["issue", "show", issueId]);
    expect(issue.exitCode).toBe(0);
    expect(issue.json).toMatchObject({ title: "定期作業", description: "定型手順", labels: ["ops"], project: { name: "release" }, milestone: null });
  });
}
