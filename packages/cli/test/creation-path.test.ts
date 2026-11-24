import { expect, test } from "bun:test";
import { makeRepo, registerRepo, runNod, tempDb } from "./helpers";

for (const actor of ["me", "claude-code", "codex", "omp"]) {
  test(`${actor}: CLI の既定は Triage、依頼・複製・定期Issueは Todo`, async () => {
    const db = tempDb();
    const cwd = makeRepo();
    registerRepo(db, cwd, "PATH");
    const run = async (args: string[]) => {
      const result = await runNod([...args, "--json"], { cwd, db, actor });
      expect(result.exitCode).toBe(0);
      return result.json;
    };
    const found = await run(["issue", "create", "見つけた作業"]);
    expect(found).toMatchObject({ status: "triage", createdBy: actor });
    const blocked = await runNod(["issue", "start", found.id, "--json"], { cwd, db, actor });
    expect(blocked.exitCode).toBe(1);
    expect(blocked.json.error.code).toBe("NOT_ACCEPTED");
    const requested = await run(["issue", "create", "頼まれた作業", "--requested"]);
    expect(requested).toMatchObject({ status: "todo", createdBy: actor });
    const detail = await run(["issue", "show", requested.id]);
    expect(detail.activity).toContainEqual(expect.objectContaining({
      kind: "event", actor, type: "created", data: { status: "todo", requested_by: "me" },
    }));
    const copy = await run(["issue", "copy", found.id]);
    expect(copy).toMatchObject({ status: "todo", createdBy: actor });
    await run(["recurring", "add", "定期作業", "--every", "daily", "--start", "2026-01-01", "--tz", "UTC"]);
    const recurring = await run(["recurring", "run"]);
    expect(recurring.failed).toEqual([]);
    expect(await run(["issue", "show", recurring.items[0].issueId])).toMatchObject({ status: "todo", createdBy: actor });
    await run(["recurring", "add", "自動化の定期作業", "--every", "daily", "--start", "2026-01-01", "--tz", "UTC"]);
    const automation = await run(["automation", "run"]);
    expect(automation.recurring.failed).toEqual([]);
    expect(await run(["issue", "show", automation.recurring.items[0].issueId])).toMatchObject({ status: "todo", createdBy: actor });
  });
}
