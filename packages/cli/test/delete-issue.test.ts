import { expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

function setupDelete() {
  const db = tempDb();
  const repo = makeRepo();
  registerRepo(db, repo, "API");
  const root = join(tempDir("nod-attachments-"), "root");
  const nod = (args: string[], actor?: string) => runNod(args, { cwd: repo, db, actor, env: { NOD_ATTACHMENTS_DIR: root } });
  return { repo, root, nod };
}

test("nod issue delete はアーカイブ済みだけを --yes で消し、nod workspace audit で記録を確かめられる", async () => {
  const { repo, root, nod } = setupDelete();
  const issue = (await nod(["issue", "create", "消す", "--json"])).json;
  writeFileSync(join(repo, "result.log"), "ok\n");
  await nod(["issue", "attach", "add", issue.id, "--file", "result.log"]);
  expect(readdirSync(root)).toHaveLength(1);

  const notArchived = await nod(["issue", "delete", issue.id, "--yes", "--json"]);
  expect(notArchived.exitCode).toBe(1);
  expect(notArchived.json.error.code).toBe("INVALID_STATE");
  expect(notArchived.json.error.message).toContain("先にアーカイブしてください");

  await nod(["issue", "archive", issue.id]);
  const unconfirmed = await nod(["issue", "delete", issue.id, "--json"]);
  expect(unconfirmed.exitCode).toBe(1);
  expect(unconfirmed.json.error.code).toBe("CONFIRM_REQUIRED");
  expect((await nod(["issue", "show", issue.id, "--json"])).exitCode).toBe(0);

  const deleted = await nod(["issue", "delete", issue.id, "--yes"]);
  expect(deleted.exitCode).toBe(0);
  expect(deleted.stdout).toContain(`${issue.id}「消す」を完全に削除しました`);
  expect((await nod(["issue", "show", issue.id, "--json"])).json.error.code).toBe("NOT_FOUND");
  expect(readdirSync(root)).toHaveLength(0);

  const audit = await nod(["workspace", "audit", "--json"]);
  expect(audit.json).toHaveLength(1);
  expect(audit.json[0]).toMatchObject({ issueId: issue.id, title: "消す", deletedBy: "me" });
  const text = await nod(["workspace", "audit"]);
  expect(text.stdout).toContain(`${issue.id}  消す  （削除: me）`);
});

test("LLM は --yes を付けても削除できない", async () => {
  const { nod } = setupDelete();
  const issue = (await nod(["issue", "create", "x", "--json"])).json;
  await nod(["issue", "archive", issue.id]);
  const r = await nod(["issue", "delete", issue.id, "--yes", "--json"], "claude-code");
  expect(r.exitCode).toBe(1);
  expect(r.json.error.code).toBe("FORBIDDEN_FOR_LLM");
  expect((await nod(["issue", "show", issue.id, "--json"])).exitCode).toBe(0);
  expect((await nod(["workspace", "audit"])).stdout).toContain("削除した Issue の記録はありません");
});
