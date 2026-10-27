import * as core from "../../src/index";

const [path, operation, ref, payload] = Bun.argv.slice(2);
const db = core.openDb(path!);
process.stdout.write("ready\n");
await Bun.stdin.text();
try {
  const input = JSON.parse(payload!);
  const ctx = { db, actor: operation === "accept" ? "me" : "codex" };
  const value = operation === "accept"
    ? core.acceptSprintPlan(ctx, ref!, input.planId, input.mutation)
    : operation === "next" ? core.nextIssue(ctx, input)
    : operation === "start" ? core.startIssue(ctx, ref!)
    : core.updateIssue(ctx, ref!, { status: "in_progress" });
  process.stdout.write(JSON.stringify({ value }));
} catch (e) {
  process.stdout.write(JSON.stringify({ error: { code: (e as { code?: string }).code } }));
} finally {
  db.close();
}
