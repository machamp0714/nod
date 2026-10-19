import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb, initWorkspace, saveTemplate } from "../../../../packages/core/src";
const root = process.argv[2] ? resolve(process.argv[2]) : realpathSync(mkdtempSync(join(tmpdir(), "nod-backlog-eval-")));
const repoRoot = resolve(import.meta.dir, "../../../..");
const cases = ["empty", "registered", "ambiguous", "failure", "draft", "update-failure", "multi-empty", "multi-registered", "small"];
mkdirSync(root, { recursive: true });
for (const [index, name] of cases.entries()) {
  const dir = join(root, String(index + 1).padStart(2, "0"));
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  // 既存環境への再実行でIssueや操作ログを上書きしない。
  mkdirSync(dir);
  mkdirSync(repo);
  mkdirSync(bin, { recursive: true });
  const git = Bun.spawnSync(["git", "init", "-q", repo]);
  if (git.exitCode !== 0) throw new Error(git.stderr.toString());
  const dbPath = join(dir, "nod.db");
  const db = openDb(dbPath);
  initWorkspace(db, { path: repo, key: "EVAL" });
  // 隔離DBだけに、人が登録済みのテンプレートをfixtureとして用意する。
  const human = { db, actor: "me" };
  if (["registered", "update-failure", "multi-registered"].includes(name)) {
    saveTemplate(human, {name:"機能改善", body:"## 利用場面\n［対象者と場面］\n\n## 実現したいこと\n［価値と動作］\n\n## 確認項目\n- [ ] ［観測できる結果］\n\n## 補足\n［未決事項など］\n"});
  }
  if (name === "ambiguous") {
    for (const label of ["チームAの機能", "チームBの機能"]) {
      saveTemplate(human, {name:label, body:"## Story\n［利用場面と価値］\n\n## 受け入れ条件\n- [ ] ［動作］\n"});
    }
  }
  db.close();
  const config = { name, repo, dbPath, log:join(dir,"operations.jsonl"), main:join(repoRoot,"packages/cli/src/main.ts"), bun:process.execPath, docs:join(dir,"docs"), attachments:join(dir,"attachments") };
  writeFileSync(join(dir,"config.json"),JSON.stringify(config));
  writeFileSync(config.log,"");
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  writeFileSync(join(bin,"nod"), "#!/bin/sh\nexec python3 " + quote(join(import.meta.dir,"nod-wrapper.py")) + " " + quote(join(dir,"config.json")) + " \"$@\"\n");
  chmodSync(join(bin,"nod"),0o755);
  writeFileSync(join(dir,"env.sh"),"export PATH=" + quote(bin) + ":\"$PATH\"\nexport NOD_ACTOR=codex\nexport NOD_DB=" + quote(dbPath) + "\nexport NOD_ORCA=0\nexport NOD_DOCS_DIR=" + quote(config.docs) + "\nexport NOD_ATTACHMENTS_DIR=" + quote(config.attachments) + "\ncd " + quote(repo) + "\n");
}
console.log(JSON.stringify({ directory: root, cases: cases.map((_, index) => String(index + 1).padStart(2, "0")) }, null, 2));
