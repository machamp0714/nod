import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changedReviewLines } from "../../core/src/ops/review-change-evidence";
import { git, makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

test("空白を含むパスの変更行を差分のTABなしで識別する", () => {
  const repo = makeRepo();
  mkdirSync(join(repo, "my dir"));
  writeFileSync(join(repo, "my dir/f g.txt"), "a\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "基点");
  writeFileSync(join(repo, "my dir/f g.txt"), "b\n");
  const lines = changedReviewLines(Bun.spawnSync(["git", "-C", repo, "diff", "--no-ext-diff"]).stdout.toString());
  expect(lines.has("head:my dir/f g.txt:1")).toBe(true);
  expect(lines.has("base:my dir/f g.txt:1")).toBe(true);
});

for (const [name, value] of [["diff.mnemonicPrefix", "true"], ["diff.noprefix", "true"]] as const) {
  test(`固定差分は利用者の${name}設定に左右されない`, async () => {
    const repo = makeRepo();
    const db = tempDb();
    registerRepo(db, repo, "FIX");
    writeFileSync(join(repo, "value.ts"), "export const value = 1;\n");
    git(repo, "add", "."); git(repo, "commit", "-qm", "対象");
    git(repo, "config", name, value);
    const env = { NOD_DOCS_DIR: tempDir("boundary-docs-") };
    const issue = (await runNod(["issue", "create", "値を追加する", "--description", "valueを追加する。", "--json"], { cwd: repo, db, env })).json.id;
    const result = await runNod(["review", "prepare", "--repo", repo, "--base", "HEAD^", "--issue", issue, "--json"], { cwd: repo, db, env });
    expect(result.json.target.patch).toContain("--- /dev/null\n+++ b/value.ts\n");
    expect(changedReviewLines(result.json.target.patch).has("head:value.ts:1")).toBe(true);
  });
}


