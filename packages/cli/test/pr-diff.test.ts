import { beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

const PR_URL = "https://github.com/example/api-server/pull/128";
const HEAD = "a".repeat(40);
const BASE = "c".repeat(40);
const VIEW = JSON.stringify({ headRefOid: HEAD, baseRefOid: BASE, changedFiles: 3 });
// 差分の本文に端末の制御文字（ESC）を含める。表示では置き換える
const DIFF = [
  "diff --git a/src/search.ts b/src/search.ts",
  "--- a/src/search.ts",
  "+++ b/src/search.ts",
  "@@ -1,2 +1,2 @@",
  " import x;",
  "-const q = 1;",
  "+const q = '\x1b[31mred';",
  "diff --git a/img/logo.png b/img/logo.png",
  "Binary files a/img/logo.png and b/img/logo.png differ",
  "diff --git a/src/a.ts b/src/b.ts",
  "similarity index 100%",
  "rename from src/a.ts",
  "rename to src/b.ts",
  "",
].join("\n");

// 実際の gh の代わりに NOD_GH で起動する偽のコマンド。引数を記録し、pr view と api で出力を返し分ける（GitHub には触れない）
function fakeGh(view: string, diff: string): { path: string; log: string } {
  const dir = tempDir("nod-fake-gh-");
  const path = join(dir, "gh");
  const log = join(dir, "args.log");
  writeFileSync(join(dir, "view.out"), view);
  writeFileSync(join(dir, "diff.out"), diff);
  writeFileSync(path, `#!/bin/sh\necho "$@" >> "${log}"\nif [ "$1" = pr ]; then cat "${dir}/view.out"; else cat "${dir}/diff.out"; fi\n`);
  chmodSync(path, 0o755);
  return { path, log };
}

let db: string;
let repo: string;
beforeAll(() => {
  db = tempDb();
  repo = makeRepo();
  registerRepo(db, repo);
});

async function issueWithPr(prUrl = PR_URL): Promise<string> {
  const created = (await runNod(["issue", "create", "--json", "PR つき"], { cwd: repo, db })).json;
  const llm = { cwd: repo, db, actor: "claude-code" };
  await runNod(["issue", "start", created.id], llm);
  await runNod(["issue", "done", created.id, "--summary", "直した", "--pr", prUrl], llm);
  return created.id;
}

describe("nod issue pr-diff", () => {
  test("--refresh なしは保存済みを表示し、gh を実行しない", async () => {
    const id = await issueWithPr();
    const gh = fakeGh(VIEW, DIFF);
    const r = await runNod(["issue", "pr-diff", id], { cwd: repo, db, env: { NOD_GH: gh.path } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`未取得。nod issue pr-diff ${id} --refresh`);
    expect(() => readFileSync(gh.log)).toThrow();
  });

  test("--refresh で HEAD に固定した差分を取得して保存し、LLM も実行できる", async () => {
    const id = await issueWithPr();
    const gh = fakeGh(VIEW, DIFF);
    const r = await runNod(["issue", "pr-diff", id, "--refresh", "--json"], { cwd: repo, db, actor: "claude-code", env: { NOD_GH: gh.path } });
    expect(r.exitCode).toBe(0);
    expect(r.json.diff).toMatchObject({ headSha: HEAD, additions: 1, deletions: 1, fetchedBy: "claude-code" });
    expect(readFileSync(gh.log, "utf8").trim().split("\n")).toEqual([
      `pr view ${PR_URL} --json headRefOid,baseRefOid,changedFiles`,
      `api -H Accept: application/vnd.github.diff repos/example/api-server/compare/${BASE}...${HEAD}`,
    ]);
    const text = await runNod(["issue", "pr-diff", id], { cwd: repo, db });
    expect(text.stdout).toContain("HEAD aaaaaaa · 変更ファイル 3 · +1 −1");
    expect(text.stdout).toContain("  M src/search.ts  +1 −1");
    expect(text.stdout).toContain("  M img/logo.png  +0 −0  バイナリ");
    expect(text.stdout).toContain("  R src/a.ts → src/b.ts  +0 −0");
  });

  test("--file でそのファイルの差分を出し、制御文字は置き換える", async () => {
    const id = await issueWithPr();
    await runNod(["issue", "pr-diff", id, "--refresh"], { cwd: repo, db, env: { NOD_GH: fakeGh(VIEW, DIFF).path } });
    const r = await runNod(["issue", "pr-diff", id, "--file", "src/search.ts"], { cwd: repo, db });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("@@ -1,2 +1,2 @@\n import x;\n-const q = 1;\n+const q = '�[31mred';");
    expect(r.stdout).not.toContain("\x1b");
    const bin = await runNod(["issue", "pr-diff", id, "--file", "img/logo.png"], { cwd: repo, db });
    expect(bin.stdout).toContain("バイナリのため差分を表示しません");
    const missing = await runNod(["issue", "pr-diff", id, "--file", "nope.ts", "--json"], { cwd: repo, db });
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr + missing.stdout).toContain("差分に nope.ts はありません");
  });

  test("gh の失敗は終了コード 0 でエラーを表示し、前回の差分を残す", async () => {
    const id = await issueWithPr();
    await runNod(["issue", "pr-diff", id, "--refresh"], { cwd: repo, db, env: { NOD_GH: fakeGh(VIEW, DIFF).path } });
    const dir = tempDir("nod-fake-gh-");
    const path = join(dir, "gh");
    writeFileSync(path, "#!/bin/sh\necho 'gh auth login' >&2\nexit 4\n");
    chmodSync(path, 0o755);
    const r = await runNod(["issue", "pr-diff", id, "--refresh"], { cwd: repo, db, env: { NOD_GH: path } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("取得に失敗（GH_AUTH）: gh が未認証です。gh auth login を実行してください");
    expect(r.stdout).toContain("前回取得");
    expect(r.stdout).toContain("src/search.ts");
  });
});
