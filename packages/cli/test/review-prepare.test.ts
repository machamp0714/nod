import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, makeRepo, registerRepo, runNod, tempDb, tempDir } from "./helpers";

function output(repo: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd: repo });
  expect(p.exitCode).toBe(0);
  return p.stdout.toString();
}
async function fixture() {
  const repo = makeRepo();
  const db = tempDb();
  registerRepo(db, repo, "RV");
  writeFileSync(join(repo, "AGENTS.md"), "# 規約\nコメントは日本語で書く。\n");
  writeFileSync(join(repo, "value.ts"), "export const value = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "基点");
  const base = output(repo, "rev-parse", "HEAD").trim();
  writeFileSync(join(repo, "value.ts"), "export const value = 2;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "対象");
  const head = output(repo, "rev-parse", "HEAD").trim();
  const env = { NOD_DOCS_DIR: tempDir("review-docs-") };
  const cli = (...args: string[]) => runNod([...args, "--json"], { cwd: repo, db, env });
  const issue = (await cli("issue", "create", "値を変更する", "--description", "値を2にする。既存の公開名を維持する。")).json.id;
  const prepare = (...args: string[]) => cli("review", "prepare", "--repo", repo, "--base", base, "--issue", issue, ...args);
  return { repo, db, env, cli, issue, base, head, prepare };
}

test("固定commitとSpec全文・Issue・計画・規約を保存し、レビュー未実施と元のindexを保つ", async () => {
  const f = await fixture();
  const spec = (await f.cli("doc", "create", "spec.md", "--kind", "spec", "--issue", f.issue, "--body", "値を2にする。\n\n## 受入条件\n公開名valueを維持する。")).json;
  await f.cli("issue", "plan", f.issue, "--step", "値を2にする");
  writeFileSync(join(f.repo, "value.ts"), "export const value = 3;\n");
  git(f.repo, "add", "value.ts");
  writeFileSync(join(f.repo, "value.ts"), "export const value = 4;\n");
  const before = output(f.repo, "diff", "HEAD");
  const index = readFileSync(join(f.repo, ".git/index"));
  const r = await f.prepare();
  expect(r.exitCode, r.stdout + r.stderr).toBe(0);
  expect(r.json).toMatchObject({ status: "prepared", score: null, review: { standards: "not_started", spec: "not_started" }, target: { baseSha: f.base, headSha: f.head, mode: "commit" } });
  expect(r.json.runId).toBeString();
  expect(r.json.target.patch).toContain("+export const value = 2;");
  expect(r.json.target.patch).not.toContain("value = 3");
  expect(r.json.requirements.primary).toEqual([`document:${spec.id}`]);
  expect(r.json.sources).toContainEqual(expect.objectContaining({ type: "document", id: String(spec.id), content: expect.stringContaining("公開名valueを維持する。"), hash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
  expect(r.json.sources.map((s: { type: string }) => s.type)).toEqual(expect.arrayContaining(["issue", "plan", "standard"]));
  expect(r.json.requirements.acquisition).toEqual({ status: "complete", mode: "issue_context", sourceIds: r.json.sources.filter((s: any) => s.type !== "standard").map((s: any) => `${s.type}:${s.id}`) });
  expect(r.json.requirements.consistency).toBe("unverified");
  expect(readFileSync(r.json.artifactPath, "utf8")).toBe(JSON.stringify(r.json, null, 2) + "\n");
  expect(output(f.repo, "diff", "HEAD")).toBe(before);
  expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
});

test("旧版SpecだけならIssue全文へ代替し、旧版を現行要求へ混ぜない", async () => {
  const f = await fixture();
  const old = (await f.cli("doc", "create", "old.md", "--kind", "spec", "--title", "旧版：値の変更", "--issue", f.issue, "--body", "値を1にする。")).json;
  const r = await f.prepare();
  expect(r.exitCode).toBe(0);
  expect(r.json.requirements.primary).toEqual([`issue:${f.issue}`]);
  expect(r.json.requirements.excluded).toContainEqual(expect.objectContaining({ id: old.id }));
  expect(r.json.sources.some((s: { type: string; id: string }) => s.type === "document" && s.id === String(old.id))).toBe(false);
});

test("異なる有効Specが複数あると更新日時で選ばず未完了で全出典を残す", async () => {
  const f = await fixture();
  for (const [path, body] of [["one.md", "値を2にする。"], ["two.md", "値を5にする。"]]) await f.cli("doc", "create", path!, "--kind", "spec", "--issue", f.issue, "--body", body!);
  const r = await f.prepare();
  expect(r.exitCode).toBe(1);
  expect(r.json).toMatchObject({ status: "incomplete", score: null });
  expect(r.json.problems[0].code).toBe("REQUIREMENTS_AMBIGUOUS");
  expect(r.json.requirements.primary).toHaveLength(2);
});

test("規約が要求するローカル参照を取得できないと未完了にする", async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "AGENTS.md"), "# 規約\n必ず[詳細規約](docs/required.md)に従う。\n");
  git(f.repo, "add", "AGENTS.md");
  git(f.repo, "commit", "-qm", "規約参照");
  const r = await f.prepare();
  expect(r.exitCode).toBe(1);
  expect(r.json.status).toBe("incomplete");
  expect(r.json.problems[0].code).toBe("STANDARD_UNREADABLE");
});

test("明示した未登録Markdownを全文取得できる", async () => {
  const f = await fixture();
  const path = join(tempDir("review-request-"), "requirements.md");
  writeFileSync(path, "# 要求\n値を2にする。\n");
  const r = await f.cli("review", "prepare", "--repo", f.repo, "--base", f.base, "--document", path);
  expect(r.exitCode).toBe(0);
  expect(r.json.requirements.primary).toEqual([`document:${path}`]);
  expect(r.json.sources).toContainEqual(expect.objectContaining({ type: "document", path, content: "# 要求\n値を2にする。\n" }));
  expect(r.json.requirements.acquisition).toEqual({ status: "complete", mode: "document_only", sourceIds: [`document:${path}`] });
  expect(r.json.requirements.issueIds).toEqual([]);
  expect(r.json.requirements.consistency).toBe("unverified");
});

test("IssueにSpecや計画が未設定でも取得完了と意味の未確認を分ける", async () => {
  const f = await fixture();
  const r = await f.prepare();
  expect(r.json.status).toBe("prepared");
  expect(r.json.requirements.acquisition).toEqual({ status: "complete", mode: "issue_context", sourceIds: [`issue:${f.issue}`] });
  expect(r.json.requirements.consistency).toBe("unverified");
});

for (const kind of ["document", "issue"] as const) test(`明示した要求元の取得失敗を文書単独の取得完了にしない（${kind}）`, async () => {
  const f = await fixture();
  const path = join(tempDir("review-selected-"), "missing.md");
  const args = kind === "document" ? ["--document", path] : ["--issue", "RV-999999"];
  const r = await f.cli("review", "prepare", "--repo", f.repo, "--base", f.base, ...args);
  expect(r.json.status).toBe("incomplete");
  expect(r.json.requirements.acquisition).toBeUndefined();
  expect(r.json.problems.length).toBeGreaterThan(0);
});

for (const kind of ["spec", "plan"] as const) test(`文書を指定しても関連Issueの必要資料の取得失敗を無視しない（${kind}）`, async () => {
  const f = await fixture();
  const selected = (await f.cli("doc", "create", "selected.md", "--kind", "doc", "--issue", f.issue, "--body", "値を2にする。")).json;
  let missing: string;
  if (kind === "spec") missing = (await f.cli("doc", "create", "required.md", "--kind", "spec", "--issue", f.issue, "--body", "公開名を維持する。")).json.path;
  else {
    missing = join(f.env.NOD_DOCS_DIR, "plan.md");
    writeFileSync(missing, "# 計画\n\n### Task 1: 公開値を変更する\n\n- [ ] **Step 1: 公開名を維持する**\n");
    const planned = await f.cli("issue", "plan", f.issue, "--from", missing);
    expect(planned.exitCode).toBe(0);
  }
  rmSync(missing);
  const r = await f.cli("review", "prepare", "--repo", f.repo, "--base", f.base, "--document", selected.path);
  expect(r.json.status).toBe("incomplete");
  expect(r.json.requirements.acquisition).toBeUndefined();
  expect(r.json.problems).toContainEqual(expect.objectContaining({ code: "DOCUMENT_UNREADABLE" }));
});

test("要求本文がないIssueを準備完了にしない", async () => {
  const f = await fixture();
  const empty = (await f.cli("issue", "create", "タイトルだけ")).json.id;
  const r = await f.prepare("--issue", empty);
  expect(r.exitCode).toBe(1);
  expect(r.json.problems[0].code).toBe("REQUIREMENTS_EMPTY");
});

test("SpecなしはIssue全文を使い、偽モデルCLIとghを起動しない", async () => {
  const f = await fixture();
  const dir = tempDir("review-fake-cli-");
  const log = join(dir, "calls");
  const fake = join(dir, "model");
  writeFileSync(fake, `#!/bin/sh\necho called >> '${log}'\nexit 99\n`);
  chmodSync(fake, 0o755);
  for (const name of ["claude", "codex", "gh"]) {
    writeFileSync(join(dir, name), readFileSync(fake));
    chmodSync(join(dir, name), 0o755);
  }
  const r = await runNod(["review", "prepare", "--repo", f.repo, "--base", f.base, "--issue", f.issue, "--json"], {
    cwd: f.repo, db: f.db, env: { ...f.env, PATH: `${dir}:${process.env.PATH}`, NOD_GH: fake },
  });
  expect(r.exitCode).toBe(0);
  expect(r.json.requirements.primary).toEqual([`issue:${f.issue}`]);
  expect(r.json.sources).toContainEqual(expect.objectContaining({ type: "issue", content: "値を2にする。既存の公開名を維持する。" }));
  expect(existsSync(log)).toBe(false);
});

test("存在したSpecの取得失敗はIssue本文へ代替せず、別runで保存する", async () => {
  const f = await fixture();
  const spec = (await f.cli("doc", "create", "spec.md", "--kind", "spec", "--issue", f.issue, "--body", "値を2にする。")).json;
  const initial = await f.prepare();
  rmSync(spec.path);
  const r = await f.prepare();
  expect(r.exitCode).toBe(1);
  expect(r.json).toMatchObject({ status: "incomplete", score: null, review: { standards: "not_started", spec: "not_started" } });
  expect(r.json.problems[0]).toMatchObject({ code: "DOCUMENT_UNREADABLE" });
  expect(r.json.requirements.primary).not.toContain(`issue:${f.issue}`);
  expect(r.json.runId).not.toBe(initial.json.runId);
  expect(JSON.parse(readFileSync(initial.json.artifactPath, "utf8")).status).toBe("prepared");
});

for (const [base, code] of [["no-such-ref", "GIT_FAILED"], ["HEAD", "EMPTY_DIFF"]]) {
  test(`誤った基点・空差分は未完了の結果を保存する（${base}）`, async () => {
    const f = await fixture();
    const r = await f.prepare("--base", base!);
    expect(r.exitCode).toBe(1);
    expect(r.json).toMatchObject({ status: "incomplete", score: null });
    expect(r.json.problems[0].code).toBe(code);
    expect(existsSync(r.json.artifactPath)).toBe(true);
  });
}

test("明示Documentに紐付くIssueの確定要求と現在計画を省略しない", async () => {
  const f = await fixture();
  const spec = (await f.cli("doc", "create", "spec.md", "--kind", "spec", "--issue", f.issue, "--body", "値を2にする。")).json;
  const plan = join(f.env.NOD_DOCS_DIR, "plan.md");
  writeFileSync(plan, "# 承認済み計画\n### Task 1: 値を変更する\n- [ ] **Step 1: 公開名を維持する**\n");
  await f.cli("issue", "plan", f.issue, "--from", plan);
  const old = (await f.cli("doc", "create", "old-plan.md", "--kind", "plan", "--issue", f.issue, "--body", "廃止した計画")).json;
  const r = await f.cli("review", "prepare", "--repo", f.repo, "--base", f.base, "--document", spec.path);
  expect(r.exitCode).toBe(0);
  expect(r.json.requirements.acquisition.mode).toBe("issue_context");
  expect(r.json.requirements.issueIds).toEqual([f.issue]);
  expect(r.json.sources).toContainEqual(expect.objectContaining({ type: "issue", content: "値を2にする。既存の公開名を維持する。" }));
  expect(r.json.sources).toContainEqual(expect.objectContaining({ type: "document", path: plan, content: expect.stringContaining("公開名を維持する") }));
  expect(r.json.requirements.excluded).toContainEqual(expect.objectContaining({ id: old.id }));
});

test("ブランチ名からIssue IDを推測せず、記録されたbranchの完全一致で解決する", async () => {
  const f = await fixture();
  git(f.repo, "checkout", "-qb", `feature/${f.issue}`);
  const args = ["review", "prepare", "--repo", f.repo, "--base", f.base];
  const missing = await f.cli(...args);
  expect(missing.exitCode).toBe(1);
  expect(missing.json.problems[0].code).toBe("ISSUE_UNRESOLVED");
  const started = await runNod(["issue", "start", f.issue, "--json"], { cwd: f.repo, db: f.db, actor: "claude-code", env: f.env });
  expect(started.exitCode, started.stdout).toBe(0);
  const r = await f.cli(...args);
  expect(r.exitCode, r.stdout).toBe(0);
  expect(r.json.requirements.issueIds).toEqual([f.issue]);
  const reviewing = await runNod(["issue", "update", f.issue, "--status", "in_review", "--json"], { cwd: f.repo, db: f.db, actor: "claude-code", env: f.env });
  expect(reviewing.exitCode, reviewing.stdout).toBe(0);
  const inReview = await f.cli(...args);
  expect(inReview.exitCode, inReview.stdout).toBe(0);
  expect(inReview.json.requirements.issueIds).toEqual([f.issue]);
});

test("別WorkspaceのIssueをbranchと作業場所で解決し、無関係repoの同名branchを選ばない", async () => {
  const f = await fixture();
  git(f.repo, "checkout", "-qb", "review-work");
  const otherRepo = makeRepo("personal");
  registerRepo(f.db, otherRepo, "PS");
  git(otherRepo, "checkout", "-qb", "review-work");
  const personal = (await f.cli("-w", "PS", "issue", "create", "別repoの作業", "--description", "値を2にする。")).json.id;
  const start = (cwd: string) => runNod(["issue", "start", personal, "--json"], { cwd, db: f.db, actor: "claude-code", env: f.env });
  expect((await start(otherRepo)).exitCode).toBe(0);
  const args = ["review", "prepare", "--repo", f.repo, "--base", f.base];
  expect((await f.cli(...args)).json.problems[0].code).toBe("ISSUE_UNRESOLVED");
  expect((await start(f.repo)).exitCode).toBe(0);
  const r = await f.cli(...args);
  expect(r.exitCode, r.stdout).toBe(0);
  expect(r.json.requirements.issueIds).toEqual([personal]);
});

test("明示Markdownも旧版と明記されていれば現行要求として採用しない", async () => {
  const f = await fixture();
  const path = join(tempDir("review-request-"), "requirements.md");
  writeFileSync(path, "---\nstatus: superseded\n---\n# 要求\n値を1にする。\n");
  const r = await f.cli("review", "prepare", "--repo", f.repo, "--base", f.base, "--document", path);
  expect(r.exitCode).toBe(1);
  expect(r.json.problems[0].code).toBe("DOCUMENT_INACTIVE");
});

test("明示localはstagedと作業ツリーを分けて固定し、元index・HEADを変更しない", async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "value.ts"), "export const value = 3;\n");
  git(f.repo, "add", "value.ts");
  writeFileSync(join(f.repo, "value.ts"), "export const value = 4;\n");
  writeFileSync(join(f.repo, "selected.ts"), "export const selected = true;\n");
  writeFileSync(join(f.repo, "private-notes.txt"), "PRIVATE_SENTINEL");
  const index = readFileSync(join(f.repo, ".git/index"));
  const result = await f.prepare("--local", "--untracked", "selected.ts");
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  expect(result.json.target).toMatchObject({ mode: "local", headSha: f.head, local: { untracked: ["selected.ts"] } });
  expect(result.json.target.patch).toContain("+export const value = 4;");
  expect(result.json.target.patch).toContain("+export const selected = true;");
  expect(result.json.target.local.stagedPatch).toContain("+export const value = 3;");
  expect(JSON.stringify(result.json)).not.toContain("PRIVATE_SENTINEL");
  expect(result.json.target.files).not.toContain("private-notes.txt");
  expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
  expect(readFileSync(join(f.repo, "value.ts"), "utf8")).toBe("export const value = 4;\n");
  expect(output(f.repo, "rev-parse", "HEAD").trim()).toBe(f.head);
  expect(output(f.repo, "stash", "list")).toBe("");
});

test("localの追加・削除・改名と実行属性を固定し、指定外の未追跡・ignoreを含めない", async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "deleted.ts"), "export const removed = true;\n");
  writeFileSync(join(f.repo, ".gitignore"), "ignored.txt\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "削除元とignore");
  const base = output(f.repo, "rev-parse", "HEAD").trim();
  git(f.repo, "mv", "value.ts", "renamed.ts");
  git(f.repo, "rm", "deleted.ts");
  writeFileSync(join(f.repo, "added.ts"), "export const added = true;\n");
  git(f.repo, "add", "added.ts");
  writeFileSync(join(f.repo, "selected.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(f.repo, "selected.sh"), 0o755);
  writeFileSync(join(f.repo, "ignored.txt"), "IGNORE_SENTINEL");
  writeFileSync(join(f.repo, "personal.txt"), "PERSONAL_SENTINEL");
  const index = readFileSync(join(f.repo, ".git/index"));
  const before = output(f.repo, "status", "--porcelain=v1", "-uall");
  const result = await f.prepare("--base", base, "--local", "--untracked", "selected.sh");
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  expect(result.json.target.patch).toContain("rename from value.ts");
  expect(result.json.target.patch).toContain("rename to renamed.ts");
  expect(result.json.target.patch).toContain("-export const removed = true;");
  expect(result.json.target.patch).toContain("+export const added = true;");
  expect(result.json.target.patch).toContain("new file mode 100755");
  expect(JSON.stringify(result.json)).not.toContain("SENTINEL");
  expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
  expect(output(f.repo, "status", "--porcelain=v1", "-uall")).toBe(before);
  expect(output(f.repo, "rev-parse", "HEAD").trim()).toBe(base);
});

for (const [path, code] of [["credentials.json", "SNAPSHOT_EXCLUDED"], ["ignored.txt", "LOCAL_UNTRACKED_INVALID"], ["missing.ts", "LOCAL_UNTRACKED_INVALID"], ["../outside.ts", "LOCAL_UNTRACKED_INVALID"]]) {
  test(`localで取得できない未追跡指定は本文を取り込まず未完了にする（${path}）`, async () => {
    const f = await fixture();
    writeFileSync(join(f.repo, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(f.repo, "credentials.json"), "SECRET_SENTINEL");
    writeFileSync(join(f.repo, "ignored.txt"), "IGNORE_SENTINEL");
    const index = readFileSync(join(f.repo, ".git/index"));
    const result = await f.prepare("--local", "--untracked", path!);
    expect(result.json.status).toBe("incomplete");
    expect(result.json.problems).toContainEqual(expect.objectContaining({ code }));
    expect(JSON.stringify(result.json)).not.toContain("SENTINEL");
    expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
  });
}

test("local準備の途中に同時編集された内容を上書きせず、混ざった対象を準備完了にしない", async () => {
  const f = await fixture();
  const dir = tempDir("review-git-");
  const realGit = Bun.spawnSync(["which", "git"]).stdout.toString().trim();
  const marker = join(dir, "edited");
  const fake = join(dir, "git");
  writeFileSync(fake, `#!/usr/bin/env bun\nimport { existsSync, writeFileSync } from "node:fs";\nif (process.argv.includes("write-tree") && !existsSync(${JSON.stringify(marker)})) { writeFileSync(${JSON.stringify(join(f.repo, "value.ts"))}, "取得中の同時編集\\n"); writeFileSync(${JSON.stringify(marker)}, "done"); }\nconst p = Bun.spawnSync([${JSON.stringify(realGit)}, ...process.argv.slice(2)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }); process.exit(p.exitCode);\n`);
  chmodSync(fake, 0o755);
  const index = readFileSync(join(f.repo, ".git/index"));
  const result = await runNod(["review", "prepare", "--repo", f.repo, "--base", f.base, "--issue", f.issue, "--local", "--json"], { cwd: f.repo, db: f.db, env: { ...f.env, PATH: `${dir}:${process.env.PATH}` } });
  expect(result.json.status).toBe("incomplete");
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "LOCAL_TARGET_CHANGED" }));
  expect(readFileSync(join(f.repo, "value.ts"), "utf8")).toBe("取得中の同時編集\n");
  expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
});


test("localで秘密ディレクトリ配下を明示しても本文を保存しない", async () => {
  const f = await fixture();
  mkdirSync(join(f.repo, ".aws"));
  writeFileSync(join(f.repo, ".aws/config"), "SECRET_DIRECTORY_SENTINEL");
  const result = await f.prepare("--local", "--untracked", ".aws/config");
  expect(result.json.status).toBe("incomplete");
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "SNAPSHOT_EXCLUDED" }));
  expect(JSON.stringify(result.json)).not.toContain("SECRET_DIRECTORY_SENTINEL");
});

test("localで追跡パスの親が外部symlinkへ変わっても参照先を読まない", async () => {
  const f = await fixture();
  mkdirSync(join(f.repo, "nested"));
  writeFileSync(join(f.repo, "nested/value.ts"), "固定する元ファイル");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "追跡ディレクトリ");
  const outside = join(tempDir("review-outside-"), "nested");
  renameSync(join(f.repo, "nested"), outside);
  writeFileSync(join(outside, "value.ts"), "OUTSIDE_SENTINEL");
  symlinkSync(outside, join(f.repo, "nested"));
  const index = readFileSync(join(f.repo, ".git/index"));
  const result = await f.prepare("--local");
  expect(result.json.status).toBe("incomplete");
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "SNAPSHOT_EXCLUDED" }));
  expect(JSON.stringify(result.json)).not.toContain("OUTSIDE_SENTINEL");
  expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
  expect(readFileSync(join(outside, "value.ts"), "utf8")).toBe("OUTSIDE_SENTINEL");
});

test("localでskip-worktreeの欠落を削除と誤解せず、未対応を明示する", async () => {
  const f = await fixture();
  git(f.repo, "update-index", "--skip-worktree", "value.ts");
  rmSync(join(f.repo, "value.ts"));
  const index = readFileSync(join(f.repo, ".git/index"));
  const result = await f.prepare("--local");
  expect(result.json.status).toBe("incomplete");
  expect(result.json.problems).toContainEqual(expect.objectContaining({ code: "LOCAL_INDEX_UNSUPPORTED" }));
  expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
  expect(existsSync(join(f.repo, "value.ts"))).toBe(false);
});


test("commit対象のコミットメッセージを固定し、対象版の識別値は変えない", async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "extra.txt"), "x\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "fix: 対象の説明");
  const r = await f.prepare();
  expect(r.json.target.commitMessages.join("\n")).toContain("fix: 対象の説明");
  const again = await f.prepare();
  expect(again.json.target.hash).toBe(r.json.target.hash);
});

test("説明資料の切れたリンクでは止めず記録し、開発規約の切れたリンクでは止める", async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, "README.md"), "[古い設計](missing/design.md)\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "説明資料を更新");
  const prepared = await f.prepare();
  expect(prepared.json.status).toBe("prepared");
  expect(prepared.json.requirements.unresolvedReferences).toEqual([{ path: "missing/design.md", referencedFrom: "README.md", line: 1 }]);
  writeFileSync(join(f.repo, "AGENTS.md"), "[必読](missing/rules.md)\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "規約を更新");
  const stopped = await f.prepare();
  expect(stopped.json.problems).toContainEqual(expect.objectContaining({ code: "STANDARD_UNREADABLE" }));
});

test("READMEだけにある祖先の規約と参照先を固定し、無関係な兄弟の規約を混ぜない", async () => {
  const f = await fixture();
  rmSync(join(f.repo, "AGENTS.md"));
  for (const path of ["src", "docs", "other"]) mkdirSync(join(f.repo, path));
  const rootRule = "# 開発規約\nSkill変更時は4か所のversionを同期する。\n[詳細](docs/policy.md)\n";
  writeFileSync(join(f.repo, "README.md"), rootRule);
  writeFileSync(join(f.repo, "src/README.md"), "# 公開契約\n公開名valueを維持する。\n");
  writeFileSync(join(f.repo, "docs/policy.md"), "版番号は配布先で同じ値にする。\n");
  writeFileSync(join(f.repo, "other/README.md"), "この無関係な規約は含めない。\n");
  writeFileSync(join(f.repo, "src/value.ts"), "export const value = 1;\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "READMEの規約");
  const base = output(f.repo, "rev-parse", "HEAD").trim();
  writeFileSync(join(f.repo, "src/value.ts"), "export const value = 2;\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "公開値の変更");
  const head = output(f.repo, "rev-parse", "HEAD").trim();
  writeFileSync(join(f.repo, "README.md"), "未コミットの規約へ変えた。\n");
  const index = readFileSync(join(f.repo, ".git/index"));
  const r = await f.prepare("--base", base);
  expect(r.exitCode, r.stdout + r.stderr).toBe(0);
  const standards = r.json.sources.filter((s: any) => s.type === "standard");
  expect(standards.map((s: any) => s.id).sort()).toEqual(["README.md", "docs/policy.md", "src/README.md"]);
  expect(standards).toContainEqual(expect.objectContaining({ id: "README.md", content: rootRule, version: head, hash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
  expect(readFileSync(join(f.repo, "README.md"), "utf8")).toBe("未コミットの規約へ変えた。\n");
  expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
});


test("READMEから参照されても秘密候補の規約本文は読まず未完了にする", async () => {
  const f = await fixture();
  mkdirSync(join(f.repo, "credentials"));
  writeFileSync(join(f.repo, "credentials/contract.md"), "SECRET_POLICY_SENTINEL\n");
  writeFileSync(join(f.repo, "README.md"), "[参照先](credentials/contract.md)\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "規約参照の準備");
  const base = output(f.repo, "rev-parse", "HEAD").trim();
  writeFileSync(join(f.repo, "value.ts"), "export const value = 3;\n");
  git(f.repo, "add", "value.ts"); git(f.repo, "commit", "-qm", "公開値の変更");
  const r = await f.prepare("--base", base);
  expect(r.exitCode).toBe(1);
  expect(r.json).toMatchObject({ status: "incomplete", score: null });
  expect(r.json.problems).toContainEqual(expect.objectContaining({ code: "STANDARD_UNREADABLE" }));
  expect(JSON.stringify(r.json)).not.toContain("SECRET_POLICY_SENTINEL");
  expect(readFileSync(r.json.artifactPath, "utf8")).not.toContain("SECRET_POLICY_SENTINEL");
});


test("READMEのsymlinkを規約としてたどらず未完了にする", async () => {
  const f = await fixture();
  const external = join(tempDir("review-external-policy-"), "policy.md");
  writeFileSync(external, "EXTERNAL_POLICY_SENTINEL\n");
  symlinkSync(external, join(f.repo, "README.md"));
  git(f.repo, "add", "README.md"); git(f.repo, "commit", "-qm", "参照不可の規約");
  const r = await f.prepare();
  expect(r.json).toMatchObject({ status: "incomplete", score: null });
  expect(r.json.problems).toContainEqual(expect.objectContaining({ code: "STANDARD_UNREADABLE" }));
  expect(JSON.stringify(r.json)).not.toContain("EXTERNAL_POLICY_SENTINEL");
});

test("規約適用計画の雛形は固定hash・全行範囲を持ち、未判断のまま実行できない", async () => {
  const f = await fixture();
  const prepared = await f.prepare();
  expect(prepared.json.standardScopeTemplatePath).toBeString();
  const template = JSON.parse(readFileSync(prepared.json.standardScopeTemplatePath, "utf8"));
  const standard = prepared.json.sources.find((s: any) => s.type === "standard");
  expect(template).toMatchObject({ version: 1, standards: [{ source: `standard:${standard.id}`, hash: standard.hash, ranges: [{ start: 1, end: standard.content.split("\n").length, kind: "unresolved" }] }] });
  const unresolved = await f.prepare("--scope-plan", prepared.json.standardScopeTemplatePath);
  expect(unresolved.json.problems).toContainEqual(expect.objectContaining({ code: "SCOPE_UNVERIFIED" }));
});
