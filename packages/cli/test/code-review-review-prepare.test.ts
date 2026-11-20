import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import {
  anyFileContains,
  commit,
  fakePackageManager,
  filesUnder,
  git,
  gitOut,
  makeGitRepo,
  prepareCaseWork,
  put,
  registerRepo,
  runReview,
  type Sandbox,
  sandbox,
  sha256,
  shellFingerprint,
  tempNod,
} from "./code-review-review-helpers";

// review.ts prepare が標準出力に出す結果（1行の JSON。同じものを parent/prepare.json に残す）
interface Prepare {
  ok: boolean;
  subcommand: string;
  runId: string;
  work: string;
  ready: boolean;
  status: string;
  reason: string | null;
  score: string | null;
  merge: string | null;
  mode: string;
  base: string;
  mergeBase: string;
  head: string;
  issue: string | null;
  headSource: { kind: string; pr?: string; ref?: string } | null;
  clone: { ok: boolean; failed: string[]; checks: { name: string; ok: boolean }[] } | null;
  deps: { prepared: boolean; reason: string | null; manager?: string; lockfile?: string; command?: string; exitCode?: number | null; files?: number } | null;
  inputs: { path: string; sha256: string }[];
  manifestSha256: string | null;
  unavailable: { item: string; reason: string }[];
  spec: SpecPlan | null;
}

// prepare が決めた要求の範囲（Spec 探索の担当ごとの要求資料・区間・依頼本文の担当範囲）
interface SpecPlan {
  split: boolean;
  reason: string | null;
  lines: number;
  cut: number | null;
  assignees: { id: string; dir: string; prefix: string; files: string[]; segments: { file: string; start: number; end: number }[]; range: string | null; request: string | null }[];
}

const prepare = (args: string[], s: Sandbox, env: Record<string, string> = {}) => runReview<Prepare>("prepare", args, s, env);
const read = (path: string) => readFileSync(path, "utf8");

// 本文に置く目印。探索の入力（input/）に出れば、混ぜてはいけないものを写したことになる
const ACTIVITY_MARK = "ACTIVITY-MARK-91c2";

// 委譲してよい限定 clone の境界（parent-details.md 2.1節）を、スクリプトの記録ではなく clone そのものから確かめる
function expectBoundedClone(clone: string, head: string, mergeBase: string, origin: string) {
  expect(gitOut(clone, "for-each-ref")).toBe("");
  expect(gitOut(clone, "remote", "-v")).toBe("");
  expect(existsSync(join(clone, ".git/objects/info/alternates"))).toBe(false);
  expect(existsSync(join(clone, ".git/FETCH_HEAD"))).toBe(false);
  expect(gitOut(clone, "rev-parse", "HEAD")).toBe(head);
  gitOut(clone, "merge-base", "--is-ancestor", mergeBase, head);
  expect(gitOut(clone, "rev-list", "--count", "--all")).toBe(gitOut(clone, "rev-list", "--count", head));
  const all = new Set(gitOut(clone, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)").split("\n"));
  const reachable = new Set(gitOut(clone, "rev-list", "--objects", "--all").split("\n").map((l) => l.split(" ")[0] ?? ""));
  expect([...all].sort()).toEqual([...reachable].sort());
  expect(gitOut(clone, "ls-files")).toBe("");
  expect(readdirSync(clone)).toEqual([".git"]);
  expect(anyFileContains(join(clone, ".git"), origin).filter((p) => !p.startsWith("objects/"))).toEqual([]);
}

describe("code-review の対象の固定と入力の準備（review.ts prepare）", () => {
  test("mode: commit と Issue: 対象を固定し、限定 clone・依存の写し・要求の原文・目録を作る", async () => {
    const s = sandbox();
    const nod = tempNod(s);
    const repo = makeGitRepo(s, "アプリ");
    registerRepo(nod.db, repo, "APP");
    const base = gitOut(repo, "rev-parse", "HEAD");
    // head から辿れない object（別ブランチだけにある commit）
    git(repo, "checkout", "-q", "-b", "other");
    const other = commit(repo, { "other.txt": "OTHER-ONLY\n" });
    git(repo, "checkout", "-q", "main");
    git(repo, "checkout", "-q", "-b", "feature");
    commit(repo, { "bun.lock": '{ "lockfileVersion": 1 }\n', "package.json": "{}\n" });
    const head = commit(repo, { "src/機能.ts": "export const x = 1;\n" });
    const bun = fakePackageManager(s, "bun");

    const issue = await nod.run(["--json", "issue", "create", "要求の Issue", "--description", "本文 ISSUE-BODY"], repo);
    const id = issue.json.id as string;
    await nod.run(["--json", "issue", "comment", id, `作業の記録 ${ACTIVITY_MARK}`], repo);
    const specA = await nod.run(["--json", "doc", "create", "spec-a.md", "--title", "仕様A", "--kind", "spec", "--issue", id, "--body", "SPEC-A-BODY"], repo);
    const specB = await nod.run(["--json", "doc", "create", "spec-b.md", "--title", "仕様B", "--kind", "spec", "--issue", id, "--body", "SPEC-B-BODY"], repo);
    const plan = await nod.run(["--json", "doc", "create", "plan.md", "--title", "計画", "--kind", "plan", "--issue", id, "--body", "### Task 1: 作る\n\n- [ ] **Step 1: 書く**"], repo);
    // plan.source が指さない kind=plan と kind=doc は要求に写さない
    await nod.run(["--json", "doc", "create", "other-plan.md", "--title", "別の計画", "--kind", "plan", "--issue", id, "--body", "OTHER-PLAN"], repo);
    await nod.run(["--json", "doc", "create", "note.md", "--title", "メモ", "--kind", "doc", "--issue", id, "--body", "NOTE-BODY"], repo);
    expect((await nod.run(["--json", "issue", "plan", id, "--from", plan.json.path], repo)).exitCode).toBe(0);
    expect((await nod.run(["workspace", "rules", "set", "--text", "# 規約\n\n- 日本語で書く"], repo)).exitCode).toBe(0);
    const refsBefore = gitOut(repo, "for-each-ref");
    const W = join(s.t, "work", "run-1");

    const r = await prepare(["--work", W, "--repo", repo, "--mode", "commit", "--base", "main", "--head", "feature", "--issue", id], s);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    const j = r.json as Prepare;
    expect(j).toMatchObject({ ok: true, subcommand: "prepare", work: W, ready: true, status: "準備完了", reason: null, mode: "commit", base: "main", mergeBase: base, head, issue: id });
    expect(JSON.parse(read(join(W, "parent/prepare.json")))).toEqual(j);

    // 元のリポジトリは変えない
    expect(gitOut(repo, "for-each-ref")).toBe(refsBefore);
    expect(gitOut(repo, "status", "--porcelain")).toBe("");

    // head を固定した元（ref）は親専用領域にだけ書く
    expect(j.headSource).toEqual({ kind: "ref", ref: "feature" });
    const headSource = read(join(W, "parent/head-source.md"));
    expect(headSource).toContain(repo);
    expect(headSource).toContain("feature");

    // 限定 clone の境界と、その確認の記録
    expectBoundedClone(join(W, "repo"), head, base, repo);
    expect(() => gitOut(join(W, "repo"), "cat-file", "-e", other)).toThrow();
    expect(j.clone?.ok).toBe(true);
    expect(j.clone?.failed).toEqual([]);
    expect(read(join(W, "parent/clone.md"))).toContain(repo);

    // 依存の写し: lockfile どおり・スクリプトを実行しない指定で、固定版を展開した作業領域で準備し、node_modules だけをリンクのまま写す
    const calls = bun.log().filter((l) => l.includes("install"));
    expect(calls).toHaveLength(1);
    const [cwd, argv] = calls[0]?.split("|") ?? [];
    expect(argv).toBe("install --frozen-lockfile --ignore-scripts");
    expect(cwd?.startsWith(join(W, "parent/deps/"))).toBe(true);
    expect(existsSync(cwd ?? "/")).toBe(false);
    expect(filesUnder(join(W, "deps"))).toEqual([
      "node_modules/.bin/left-pad",
      "node_modules/left-pad/index.js",
      "node_modules/web",
      "packages/web/node_modules/tiny/index.js",
    ]);
    expect(lstatSync(join(W, "deps/node_modules/.bin/left-pad")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(W, "deps/node_modules/.bin/left-pad"))).toBe("../left-pad/index.js");
    expect(read(join(W, "input/deps-files.sha256"))).toBe(shellFingerprint(join(W, "deps"), { links: true }));
    expect(j.deps).toMatchObject({ prepared: true, reason: null, manager: "bun", lockfile: "bun.lock", exitCode: 0, files: 2 });
    expect(read(join(W, "parent/deps/setup.log"))).toContain("installed");

    // 要求の原文: Issue のタイトルと本文、すべての kind=spec、plan.source が指す kind=plan だけ、Workspace 規約
    const req = join(W, "input/requirements");
    const docShow = async (doc: number) => (await nod.run(["--json", "doc", "show", String(doc)], repo)).json.content as string;
    expect(filesUnder(req)).toEqual([`plan-${plan.json.id}.md`, `spec-${specA.json.id}.md`, `spec-${specB.json.id}.md`, "issue.md", "workspace-rules.md"].sort());
    expect(read(join(req, "issue.md"))).toBe("# 要求の Issue\n\n本文 ISSUE-BODY\n");
    expect(read(join(req, `spec-${specA.json.id}.md`))).toBe(await docShow(specA.json.id));
    expect(read(join(req, `spec-${specB.json.id}.md`))).toBe(await docShow(specB.json.id));
    expect(read(join(req, `plan-${plan.json.id}.md`))).toBe(await docShow(plan.json.id));
    expect(read(join(req, "workspace-rules.md"))).toBe((await nod.run(["-w", repo, "workspace", "rules", "show"], repo)).stdout);
    expect(anyFileContains(W, "OTHER-PLAN").filter((p) => !p.startsWith("parent/"))).toEqual([]);
    expect(anyFileContains(join(W, "input"), "NOTE-BODY")).toEqual([]);

    // nod issue show の全出力は親専用領域にだけ置き、Activity・元のパスは探索の入力に混ぜない
    expect(JSON.parse(read(join(W, "parent/issue-snapshot.json"))).id).toBe(id);
    expect(read(join(W, "parent/issue-snapshot.json"))).toContain(ACTIVITY_MARK);
    expect(anyFileContains(join(W, "input"), ACTIVITY_MARK)).toEqual([]);
    expect(anyFileContains(join(W, "input"), repo)).toEqual([]);

    // target.md と manifest.md（input/ の各ファイルの sha256 と出典、依存の写しの節）
    const target = read(join(W, "input/target.md"));
    for (const v of [join(W, "repo"), join(W, "deps"), head, base, "`commit`", id]) expect(target).toContain(v);
    // 要求資料が複数あるので Spec 探索を要求の範囲で2つに分け、担当範囲を target.md に書き、担当ごとの作業ディレクトリを作る
    expect(j.spec?.split).toBe(true);
    expect(j.spec?.assignees.map((a) => [a.id, a.prefix])).toEqual([
      ["spec1", "SPC1"],
      ["spec2", "SPC2"],
    ]);
    expect(target).toContain("## Spec 探索の担当範囲");
    for (const a of j.spec?.assignees ?? []) {
      expect(a.request).toBe(`${a.id}（${a.range}。候補 ID は ${a.prefix}-<n>）`);
      expect(existsSync(join(W, a.id, "notes"))).toBe(true);
    }
    expect(existsSync(join(W, "spec"))).toBe(false);
    const manifest = read(join(W, "input/manifest.md"));
    const lines = shellFingerprint(join(W, "input"), { exclude: "manifest.md" }).trimEnd().split("\n");
    expect(lines.length).toBe(7);
    for (const line of lines) {
      const [hash, path] = line.split(/ {2}\.\//);
      expect(manifest.split("\n").some((l) => l.includes(`\`${path}\``) && l.includes(hash ?? "-"))).toBe(true);
    }
    expect(j.inputs.map((i) => `${i.sha256}  ./${i.path}`)).toEqual(lines);
    expect(j.manifestSha256).toBe(sha256(manifest));
    expect(manifest).toContain(`bun.lock@${head}`);
    expect(manifest).toContain(sha256('{ "lockfileVersion": 1 }\n'));
    expect(manifest).toContain("--ignore-scripts");
  });

  test("mode: local と明示された要求: 土台の HEAD・未コミットの差分・指定された未追跡ファイルだけを固定する", async () => {
    const s = sandbox();
    // 一時の nod（このリポジトリは Workspace に登録しない）
    tempNod(s);
    const repo = makeGitRepo(s);
    const base = gitOut(repo, "rev-parse", "HEAD");
    const baseHead = commit(repo, { "package-lock.json": "{}\n", "package.json": "{}\n", "src/a.ts": "export const a = 1;\n" });
    const npm = fakePackageManager(s, "npm");
    // 未コミットの変更（パッケージの定義を含む）、指定する未追跡ファイル（日本語のパス）、指定しない未追跡ファイル
    put(join(repo, "src/a.ts"), "export const a = 2;\n");
    put(join(repo, "package.json"), '{ "name": "changed" }\n');
    put(join(repo, "メモ/追加 ファイル.ts"), "export const added = true;\n");
    put(join(repo, "unlisted.txt"), "UNLISTED-MARK\n");
    const request = join(s.t, "request.md");
    put(request, "# 依頼\n\nREQUEST-BODY\n");
    const W = join(s.t, "work", "run-local");

    const r = await prepare(["--work", W, "--repo", repo, "--mode", "local", "--base", base, "--untracked", "メモ/追加 ファイル.ts", "--request", request], s);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    const j = r.json as Prepare;
    expect(j).toMatchObject({ ready: true, status: "準備完了", mode: "local", mergeBase: base, head: baseHead, issue: null, headSource: null });
    expect(existsSync(join(W, "parent/head-source.md"))).toBe(false);
    // commit も stash も作らない
    expect(gitOut(repo, "rev-parse", "HEAD")).toBe(baseHead);
    expect(gitOut(repo, "stash", "list")).toBe("");

    expectBoundedClone(join(W, "repo"), baseHead, base, repo);
    const diff = Bun.spawnSync(["git", "-C", repo, "diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"]).stdout.toString();
    expect(read(join(W, "input/local/changes.diff"))).toBe(diff);
    expect(diff).toContain("export const a = 2;");
    expect(filesUnder(join(W, "input/local"))).toEqual(["changes.diff", "untracked/メモ/追加 ファイル.ts"]);
    expect(read(join(W, "input/local/untracked/メモ/追加 ファイル.ts"))).toBe("export const added = true;\n");
    expect(anyFileContains(W, "UNLISTED-MARK")).toEqual([]);

    // 依存の写しは土台の HEAD の lockfile から作り、未コミットの変更がパッケージの定義を変えていることを目録に書く
    expect(npm.log().filter((l) => l.endsWith("|ci --ignore-scripts"))).toHaveLength(1);
    expect(j.deps).toMatchObject({ prepared: true, manager: "npm", lockfile: "package-lock.json" });
    const manifest = read(join(W, "input/manifest.md"));
    expect(manifest).toContain(`package-lock.json@${baseHead}`);
    expect(manifest).toContain("package.json");
    expect(manifest).toContain("土台の HEAD の lockfile");

    // Issue なし: 明示された要求だけを request-<n>.md に丸ごと写す。Workspace の規約は取得できず理由を残す（未登録のリポジトリ）
    expect(filesUnder(join(W, "input/requirements"))).toEqual(["request-1.md"]);
    expect(read(join(W, "input/requirements/request-1.md"))).toBe("# 依頼\n\nREQUEST-BODY\n");
    expect(j.unavailable.map((u) => u.item)).toEqual(["Workspace の規約"]);
    expect(manifest).toContain("Workspace の規約");
    expect(anyFileContains(join(W, "input"), repo)).toEqual([]);

    const target = read(join(W, "input/target.md"));
    for (const v of ["`local`", "local/changes.diff", "local/untracked/メモ/追加 ファイル.ts", baseHead, "Issue: なし"]) expect(target).toContain(v);
    // 要求資料は見出しが1行目だけの1ファイルなので分けない（今の1体のまま）
    expect(j.spec).toMatchObject({ split: false, cut: null, assignees: [{ id: "spec", files: ["requirements/request-1.md"], range: null, request: null }] });
    expect(target).not.toContain("担当範囲");
    expect(existsSync(join(W, "spec/notes"))).toBe(true);
    expect(j.inputs.map((i) => `${i.sha256}  ./${i.path}`)).toEqual(shellFingerprint(join(W, "input"), { exclude: "manifest.md" }).trimEnd().split("\n"));
  });

  test("秘密情報を含み得る名前（.env.example など）が差分にあっても止めず、担当用の限定 clone まで進む", async () => {
    const s = sandbox();
    const nod = tempNod(s);
    const repo = makeGitRepo(s);
    registerRepo(nod.db, repo, "APP");
    const issue = await nod.run(["--json", "issue", "create", "雛形", "--description", "ISSUE-BODY"], repo);
    const base = gitOut(repo, "rev-parse", "HEAD");
    const head = commit(repo, { ".env.example": "TOKEN=\n", "設定/.env.local.example": "TOKEN=\n", "src/ok.ts": "ok\n" });
    const W = join(s.t, "work", "env-example");

    const r = await prepare(["--work", W, "--repo", repo, "--mode", "commit", "--base", base, "--head", head, "--issue", issue.json.id], s);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    const j = r.json as Prepare;
    expect(j).toMatchObject({ ready: true, status: "準備完了", reason: null, head, mergeBase: base });
    expect(j.clone?.ok).toBe(true);
    expect(Object.keys(j)).not.toContain("secrets");
    expectBoundedClone(join(W, "repo"), head, base, repo);

    // mode: local の指定された未追跡ファイルも同じく止めない
    put(join(repo, "鍵/server.PEM"), "PEM\n");
    const W2 = join(s.t, "work", "env-example-local");
    const local = await prepare(["--work", W2, "--repo", repo, "--mode", "local", "--base", base, "--untracked", "鍵/server.PEM"], s);
    expect(local.json).toMatchObject({ ready: true, status: "準備完了" });
    expect(filesUnder(join(W2, "input/local"))).toContain("untracked/鍵/server.PEM");
  });

  test("空差分: 委譲できない状態（未実施、理由: 差分なし）として記録する", async () => {
    const s = sandbox();
    const repo = makeGitRepo(s);
    const head = gitOut(repo, "rev-parse", "HEAD");
    const W = join(s.t, "work", "empty");

    const r = await prepare(["--work", W, "--repo", repo, "--mode", "commit", "--base", "main", "--head", head], s);
    expect(r.exitCode).toBe(0);
    expect(r.json).toMatchObject({ ready: false, status: "未実施", reason: "差分なし", score: "点数なし", merge: "不可（人の判断が要る）", headSource: { kind: "none" } });
    expect(existsSync(join(W, "repo"))).toBe(false);
    expect(read(join(W, "parent/head-source.md"))).toContain("ref なし");
  });

  test("限定 clone の確認が通らなければ未実施にし、通らなかった確認を記録する", async () => {
    const s = sandbox();
    const repo = makeGitRepo(s);
    const base = gitOut(repo, "rev-parse", "HEAD");
    const head = commit(repo, { "src/a.ts": "a\n" });
    // 利用者の git の雛形が、作った clone に元のリポジトリのパスを持ち込む
    const template = join(s.t, "git-template");
    put(join(template, "description"), `copied from ${repo}\n`);
    put(join(s.home, ".gitconfig"), `[init]\n\ttemplateDir = ${template}\n`);
    const W = join(s.t, "work", "clone-fail");

    const r = await prepare(["--work", W, "--repo", repo, "--mode", "commit", "--base", base, "--head", head], s);
    expect(r.exitCode).toBe(0);
    const j = r.json as Prepare;
    expect(j).toMatchObject({ ready: false, status: "未実施", score: "点数なし", merge: "不可（人の判断が要る）", deps: null });
    expect(j.clone?.ok).toBe(false);
    expect(j.clone?.failed).toEqual(["元のリポジトリのパスを持たない"]);
    expect(j.reason).toBe("担当用の限定 clone を作れない（元のリポジトリのパスを持たない）");
    expect(read(join(W, "parent/clone.md"))).toContain("元のリポジトリのパスを持たない（不合格）");
    expect(filesUnder(join(W, "input"))).toEqual([]);
  });

  test("依存の写しを準備できなければ deps/ を置かず、理由を目録に残す", async () => {
    const cases: { name: string; files: Record<string, string>; env?: Record<string, string>; reason: string }[] = [
      { name: "lockfile なし", files: { "package.json": "{}\n" }, reason: "lockfile が無い" },
      { name: "ルート以外", files: { "packages/web/bun.lock": "{}\n" }, reason: "lockfile がルート以外にしか無い（packages/web/bun.lock）" },
      { name: "複数", files: { "bun.lock": "{}\n", "package-lock.json": "{}\n" }, reason: "どれを使うか固定版から決められない複数の lockfile がある（bun.lock・package-lock.json）" },
      { name: "準備の失敗", files: { "bun.lock": "{}\n" }, env: { FAKE_PM_FAIL: "1" }, reason: "準備の終了コードが 0 以外（7）" },
      { name: "yarn の形式不明", files: { "yarn.lock": "something\n" }, reason: "yarn.lock の形式（v1 か Yarn 2 以降か）を固定版から決められない" },
      {
        name: "yarnPath なし",
        files: { "yarn.lock": "__metadata:\n  version: 6\n" },
        reason: "Yarn 2 以降の yarn.lock だが、.yarnrc.yml の yarnPath が無く、使う Yarn の版を固定版から決められない",
      },
    ];
    for (const c of cases) {
      const s = sandbox();
      const repo = makeGitRepo(s);
      const base = gitOut(repo, "rev-parse", "HEAD");
      const head = commit(repo, { ...c.files, "src/a.ts": "a\n" });
      fakePackageManager(s, "bun");
      const W = join(s.t, "work", "deps");

      const r = await prepare(["--work", W, "--repo", repo, "--mode", "commit", "--base", base, "--head", head], s, c.env);
      expect({ name: c.name, exitCode: r.exitCode, ready: r.json?.ready, deps: r.json?.deps?.prepared, reason: r.json?.deps?.reason }).toEqual({
        name: c.name,
        exitCode: 0,
        ready: true,
        deps: false,
        reason: c.reason,
      });
      expect(existsSync(join(W, "deps"))).toBe(false);
      expect(existsSync(join(W, "input/deps-files.sha256"))).toBe(false);
      expect(read(join(W, "input/target.md"))).toContain("依存の写しなし（理由は manifest.md）");
      expect(read(join(W, "input/manifest.md"))).toContain(`依存の写しなし: ${c.reason}`);
      expect(readdirSync(join(W, "parent/deps")).filter((n) => n === "build")).toEqual([]);
      if (c.env) expect(read(join(W, "parent/deps/setup.log"))).toContain("install failed");
    }
  });

  test("yarn: v1 は --frozen-lockfile --ignore-scripts、Yarn 2 以降は yarnPath の Yarn で --immutable --mode=skip-build", async () => {
    const s = sandbox();
    const repo = makeGitRepo(s);
    const base = gitOut(repo, "rev-parse", "HEAD");
    const yarn = fakePackageManager(s, "yarn");
    const node = fakePackageManager(s, "node");
    const v1 = commit(repo, { "yarn.lock": "# THIS IS AN AUTOGENERATED FILE.\n# yarn lockfile v1\n\n", "src/a.ts": "a\n" });
    const r1 = await prepare(["--work", join(s.t, "work/v1"), "--repo", repo, "--mode", "commit", "--base", base, "--head", v1], s);
    expect(r1.json?.deps).toMatchObject({ prepared: true, manager: "yarn v1", lockfile: "yarn.lock" });
    expect(yarn.log().filter((l) => l.endsWith("|install --frozen-lockfile --ignore-scripts"))).toHaveLength(1);

    const berry = commit(repo, {
      "yarn.lock": "__metadata:\n  version: 6\n",
      ".yarnrc.yml": "nodeLinker: node-modules\nyarnPath: .yarn/releases/yarn-3.6.4.cjs\n",
      ".yarn/releases/yarn-3.6.4.cjs": "// yarn\n",
    });
    const r2 = await prepare(["--work", join(s.t, "work/berry"), "--repo", repo, "--mode", "commit", "--base", base, "--head", berry], s);
    expect(r2.json?.deps).toMatchObject({ prepared: true, manager: "yarn berry", command: "node .yarn/releases/yarn-3.6.4.cjs install --immutable --mode=skip-build" });
    expect(node.log().filter((l) => l.endsWith("|.yarn/releases/yarn-3.6.4.cjs install --immutable --mode=skip-build"))).toHaveLength(1);
    expect(read(join(s.t, "work/berry/input/deps-files.sha256"))).toBe(shellFingerprint(join(s.t, "work/berry/deps"), { links: true }));
  });

  test("head を固定した元: PR は URL、SHA だけの指定は ref なしとして親専用領域に書く", async () => {
    const s = sandbox();
    const repo = makeGitRepo(s);
    const base = gitOut(repo, "rev-parse", "HEAD");
    const head = commit(repo, { "src/a.ts": "a\n" });
    const url = "https://github.com/acme/app/pull/12";

    const r = await prepare(["--work", join(s.t, "work/pr"), "--repo", repo, "--mode", "commit", "--base", base, "--head", head, "--pr", url], s);
    expect(r.json).toMatchObject({ ready: true, head, headSource: { kind: "pr", pr: url } });
    expect(read(join(s.t, "work/pr/parent/head-source.md"))).toContain(url);
    expect(read(join(s.t, "work/pr/input/target.md"))).not.toContain(url);

    const sha = await prepare(["--work", join(s.t, "work/sha"), "--repo", repo, "--mode", "commit", "--base", base, "--head", head], s);
    expect(sha.json).toMatchObject({ ready: true, headSource: { kind: "none" } });
    expect(read(join(s.t, "work/sha/parent/head-source.md"))).toContain("ref なし");
  });

  test("評価用の事例: nod を使わずに case.md の先頭の項目と要求の写しの節と requirements/ から入力を作り、sha256 を事例の manifest.md と照合する", async () => {
    const s = sandbox();
    const repo = makeGitRepo(s);
    const mergeBase = gitOut(repo, "rev-parse", "HEAD");
    // 基点の指定は head の祖先ではなく、merge-base は別の commit
    const base = commit(repo, { "base.txt": "base\n" });
    git(repo, "checkout", "-q", "-b", "topic", mergeBase);
    const head = commit(repo, { "src/a.ts": "a\n" });
    // nod を呼べば記録が残る偽の NOD_CLI
    const nodLog = join(s.t, "nod.log");
    put(join(s.bin, "fake-nod"), `#!/bin/sh\necho "$*" >> "${nodLog}"\nexit 1\n`);
    Bun.spawnSync(["chmod", "+x", join(s.bin, "fake-nod")]);
    const dir = join(s.t, "dataset/inputs/case-1");
    const pastEval = "notebooklm-review-agent-20261025";
    const caseMd = [
      "# 対象",
      "",
      "- 対象リポジトリ: `/old/place/app`",
      `- 基点の指定: \`${base}\``,
      `- merge-base: \`${mergeBase}\``,
      `- head: \`${head}\``,
      "- mode: `commit`",
      "- Issue: NOD-1",
      "- 計画の出典: なし",
      "",
      "## commit の読み取り確認",
      "",
      "- 取得時の記録にあるリポジトリ `/old/place/app`: 読めない",
      `- 同じ GitHub リポジトリの \`${repo}\`: 読める`,
      "",
      "## 要求の写し",
      "",
      "| ファイル | 内容 |",
      "|---|---|",
      "| `requirements/issue.md` | 当時の Issue |",
      "| `requirements/workspace-rules.md` | `nod -w /old/place/app workspace rules show` の出力 |",
      "",
      "## 当時の要求の出典と復元の限界",
      "",
      `- 過去の評価資料 \`${pastEval}/report.md\` で確かめた。`,
      "",
    ].join("\n");
    const files: Record<string, string> = { "case.md": caseMd, "requirements/issue.md": "# 当時の Issue\n", "requirements/workspace-rules.md": "作業規約は登録されていません\n" };
    for (const [p, b] of Object.entries(files)) put(join(dir, p), b);
    const table = Object.entries(files).map(([p, b]) => `| \`${p}\` | \`${sha256(b)}\` | 出典 |`);
    put(join(dir, "manifest.md"), ["# 入力の指紋", "", "| ファイル | sha256 | 出典 |", "|---|---|---|", ...table, "", "## 取得できなかった資料と理由", "", "- 計画: 空のため写していない。", ""].join("\n"));
    const W = join(s.t, "work/case");

    const r = await prepare(["--work", W, "--case", dir, "--repo", repo], s, { NOD_CLI: join(s.bin, "fake-nod") });
    expect(r.stderr).toBe("");
    expect(r.json).toMatchObject({ ready: true, status: "準備完了", base, mergeBase, head, case: "case-1" });
    expect(existsSync(nodLog)).toBe(false);
    // 先頭の項目（対象リポジトリは限定 clone、基点の指定は merge-base）と「要求の写し」の節だけ。依存の写しの場所の行を足す。
    // 要求資料は1行ずつで、要求資料の境目で Spec 探索を2つの範囲に分けるので、末尾に担当範囲の節を足す
    expect(read(join(W, "input/target.md"))).toBe(
      [
        "# 対象",
        "",
        `- 対象リポジトリ: \`${join(W, "repo")}\``,
        "- 依存の写し: 依存の写しなし（理由は manifest.md）",
        `- 基点の指定: \`${mergeBase}\``,
        `- merge-base: \`${mergeBase}\``,
        `- head: \`${head}\``,
        "- mode: `commit`",
        "- Issue: NOD-1",
        "- 計画の出典: なし",
        "",
        "## 要求の写し",
        "",
        "| ファイル | 内容 |",
        "|---|---|",
        "| `requirements/issue.md` | 当時の Issue |",
        "| `requirements/workspace-rules.md` | `nod -w <対象リポジトリ> workspace rules show` の出力 |",
        "",
        "## Spec 探索の担当範囲",
        "",
        "要求資料（requirements/ のファイルをパスの順に並べた全行）を、行数がほぼ半分になる要求資料の境目か見出しの直前で2つに分けた範囲。Spec 探索の担当は、依頼本文の「担当範囲」の担当の範囲について、コード要求の対応表の行と要求資料ごとのコード要求を書く。要求資料はすべて読んでよい。",
        "",
        "| 担当 | 範囲 | 候補 ID |",
        "|---|---|---|",
        "| spec1 | `requirements/issue.md:L1` | `SPC1-<n>` |",
        "| spec2 | `requirements/workspace-rules.md:L1` | `SPC2-<n>` |",
        "",
      ].join("\n"),
    );
    // 元のリポジトリのパス（case.md の対象リポジトリと --repo）・過去の評価資料・元の基点の指定は担当へ渡す入力に無い
    for (const leak of ["/old/place/app", repo, pastEval, base]) expect(anyFileContains(join(W, "input"), leak)).toEqual([]);
    // 置き換えた元の基点の指定と写さなかった節の見出しは親専用の記録に残る
    const record = JSON.parse(read(join(W, "parent/prepare.json")));
    expect(record.caseTarget).toEqual({ base, droppedSections: ["commit の読み取り確認", "当時の要求の出典と復元の限界"] });
    expect(read(join(W, "input/manifest.md"))).toMatch(/\| `target\.md` \| `[0-9a-f]{64}` \| inputs\/case-1\/case\.md の先頭の項目と「要求の写し」の節だけを写し[^|]*merge-base/);
    expect(filesUnder(join(W, "input/requirements"))).toEqual(["issue.md", "workspace-rules.md"]);
    expect(read(join(W, "input/requirements/issue.md"))).toBe(files["requirements/issue.md"] ?? "");
    expect(read(join(W, "input/manifest.md"))).toContain("計画: 空のため写していない。");
    expectBoundedClone(join(W, "repo"), head, mergeBase, repo);

    // 事例の資料が manifest.md と食い違えば、入力を固定できず未実施
    put(join(dir, "requirements/issue.md"), "# 書き換えた Issue\n");
    const bad = await prepare(["--work", join(s.t, "work/case-bad"), "--case", dir, "--repo", repo], s, { NOD_CLI: join(s.bin, "fake-nod") });
    expect(bad.json).toMatchObject({ ready: false, status: "未実施" });
    expect(bad.json?.reason).toContain("requirements/issue.md");
    expect(existsSync(join(s.t, "work/case-bad/repo"))).toBe(false);
  });

  test("要求の範囲: 要求資料をパスの順に並べた全行を、行数がほぼ半分になる要求資料の境目か見出し（コードブロックの中を除く）の直前で2つに分け、同じ近さなら前の位置を選び、0行の要求資料は位置で担当を決める。prepare.json と標準出力の spec、target.md の担当範囲の節、担当ごとの作業ディレクトリを作る", async () => {
    const s = sandbox();
    // 全17行。切れ目の候補: 見出し issue.md:L4（位置 3）、spec-1.md の先頭（位置 6）、見出し spec-1.md:L6（位置 11）・L9（位置 14）、workspace-rules.md の先頭（位置 16）。
    // コードブロックの中の spec-1.md:L4（位置 9）は候補にしない。|2p−17| は位置 6 と 11 が 5 で同じなので、前の位置 6 を選ぶ
    const p = await prepareCaseWork(s, "split", {
      "issue.md": "# 課題\n\n本文1\n## 詳細\n本文2\n本文3\n",
      "spec-1.md": "# 仕様\n\n```\n# コード内の見出し\n```\n## 節A\na\nb\n## 節B\nc\n",
      "workspace-rules.md": "規約\n",
    });
    const r = JSON.parse(read(join(p.W, "parent/prepare.json"))) as Prepare;
    expect(r.spec).toEqual({
      split: true,
      reason: null,
      lines: 17,
      cut: 6,
      assignees: [
        {
          id: "spec1",
          dir: join(p.W, "spec1"),
          prefix: "SPC1",
          files: ["requirements/issue.md"],
          segments: [{ file: "requirements/issue.md", start: 1, end: 6 }],
          range: "requirements/issue.md:L1-L6",
          request: "spec1（requirements/issue.md:L1-L6。候補 ID は SPC1-<n>）",
        },
        {
          id: "spec2",
          dir: join(p.W, "spec2"),
          prefix: "SPC2",
          files: ["requirements/spec-1.md", "requirements/workspace-rules.md"],
          segments: [
            { file: "requirements/spec-1.md", start: 1, end: 10 },
            { file: "requirements/workspace-rules.md", start: 1, end: 1 },
          ],
          range: "requirements/spec-1.md:L1-L10、requirements/workspace-rules.md:L1",
          request: "spec2（requirements/spec-1.md:L1-L10、requirements/workspace-rules.md:L1。候補 ID は SPC2-<n>）",
        },
      ],
    });
    expect(read(join(p.W, "input/target.md")).endsWith(
      [
        "",
        "## Spec 探索の担当範囲",
        "",
        "要求資料（requirements/ のファイルをパスの順に並べた全行）を、行数がほぼ半分になる要求資料の境目か見出しの直前で2つに分けた範囲。Spec 探索の担当は、依頼本文の「担当範囲」の担当の範囲について、コード要求の対応表の行と要求資料ごとのコード要求を書く。要求資料はすべて読んでよい。",
        "",
        "| 担当 | 範囲 | 候補 ID |",
        "|---|---|---|",
        "| spec1 | `requirements/issue.md:L1-L6` | `SPC1-<n>` |",
        "| spec2 | `requirements/spec-1.md:L1-L10`、`requirements/workspace-rules.md:L1` | `SPC2-<n>` |",
        "",
      ].join("\n"),
    )).toBe(true);
    for (const d of ["spec1/notes", "spec2/notes", "standards/notes", "refute/notes"]) expect(`${d}: ${existsSync(join(p.W, d))}`).toBe(`${d}: true`);
    expect(existsSync(join(p.W, "spec"))).toBe(false);

    // 見出しの切れ目が同じ近さで2つ（位置 3 と 5、全8行）なら前の位置。先頭の0行の要求資料（位置 0）は範囲1の担当の要求資料に入れ、区間は持たない
    const tie = await prepareCaseWork(s, "tie", { "a-empty.md": "", "issue.md": "# 課題\nx\ny\n## A\nz\n## B\nw\nv\n" });
    const t = (JSON.parse(read(join(tie.W, "parent/prepare.json"))) as Prepare).spec;
    expect({ lines: t?.lines, cut: t?.cut, ranges: t?.assignees.map((a) => [a.id, a.files, a.range]) }).toEqual({
      lines: 8,
      cut: 3,
      ranges: [
        ["spec1", ["requirements/a-empty.md", "requirements/issue.md"], "requirements/issue.md:L1-L3"],
        ["spec2", ["requirements/issue.md"], "requirements/issue.md:L4-L8"],
      ],
    });

    // 要求資料の境目も見出し（1行目は位置 0 で切れ目にしない）も無ければ分けず、今の1体のまま（担当範囲の節を足さない）
    const one = await prepareCaseWork(s, "one");
    const o = JSON.parse(read(join(one.W, "parent/prepare.json"))) as Prepare;
    expect(o.spec).toEqual({
      split: false,
      reason: "要求資料の境目も見出しも無く、2つの空でない範囲に分けられない",
      lines: 4,
      cut: null,
      assignees: [
        {
          id: "spec",
          dir: join(one.W, "spec"),
          prefix: "SPC",
          files: ["requirements/issue.md", "requirements/workspace-rules.md"],
          segments: [{ file: "requirements/issue.md", start: 1, end: 4 }],
          range: null,
          request: null,
        },
      ],
    });
    expect(read(join(one.W, "input/target.md"))).not.toContain("担当範囲");
    expect(existsSync(join(one.W, "spec/notes"))).toBe(true);
    expect(existsSync(join(one.W, "spec1"))).toBe(false);
  });

  test("要求の範囲: 入れ子のコードフェンス（外側より短いフェンス・別の文字のフェンス）では外側のフェンスが閉じず、その中の # 行を切れ目にしない。外側のフェンスが閉じた後の見出しは切れ目にする", async () => {
    const s = sandbox();
    // 1行目だけが見出しで、4連バッククォートのフェンスの中に ```sh・# コメント・``` の入れ子がある全7行の要求は分けず、今の1体のまま
    const nested = await prepareCaseWork(s, "nested", {
      "issue.md": "# 課題\n````markdown\n```sh\n# コメント\n```\n````\n本文\n",
      "workspace-rules.md": "",
    });
    const n = JSON.parse(read(join(nested.W, "parent/prepare.json"))) as Prepare;
    expect(n.spec).toEqual({
      split: false,
      reason: "要求資料の境目も見出しも無く、2つの空でない範囲に分けられない",
      lines: 7,
      cut: null,
      assignees: [
        {
          id: "spec",
          dir: join(nested.W, "spec"),
          prefix: "SPC",
          files: ["requirements/issue.md", "requirements/workspace-rules.md"],
          segments: [{ file: "requirements/issue.md", start: 1, end: 7 }],
          range: null,
          request: null,
        },
      ],
    });
    expect(read(join(nested.W, "input/target.md"))).not.toContain("担当範囲");
    expect(existsSync(join(nested.W, "spec1"))).toBe(false);

    // ~~~ のフェンスの中の ``` は閉じない。切れ目の候補は外側のフェンスが閉じた後の見出し issue.md:L7（位置 6）だけ（中の # コメント の位置 3 は候補にしない）
    const tilde = await prepareCaseWork(s, "tilde", {
      "issue.md": "# 課題\n~~~markdown\n```sh\n# コメント\n```\n~~~\n## 節\n本文\n",
      "workspace-rules.md": "",
    });
    const t = (JSON.parse(read(join(tilde.W, "parent/prepare.json"))) as Prepare).spec;
    expect({ split: t?.split, lines: t?.lines, cut: t?.cut, ranges: t?.assignees.map((a) => [a.id, a.files, a.range]) }).toEqual({
      split: true,
      lines: 8,
      cut: 6,
      ranges: [
        ["spec1", ["requirements/issue.md"], "requirements/issue.md:L1-L6"],
        ["spec2", ["requirements/issue.md", "requirements/workspace-rules.md"], "requirements/issue.md:L7-L8"],
      ],
    });
  });

  test("引数の誤りは終了コード 2 で、作業ディレクトリを作らない", async () => {
    const s = sandbox();
    const repo = makeGitRepo(s);
    const W = join(s.t, "work/bad");
    const runs = [
      await prepare(["--work", W, "--repo", repo, "--mode", "commit", "--base", "main"], s),
      await prepare(["--work", W, "--repo", repo, "--mode", "commit", "--base", "main", "--head", "no-such-ref"], s),
      await prepare(["--work", W, "--repo", "relative", "--mode", "commit", "--base", "main", "--head", "main"], s),
      await prepare(["--work", W, "--repo", repo, "--mode", "local", "--base", "main", "--untracked", "README.md"], s),
      await prepare(["--work", W, "--repo", repo, "--mode", "commit", "--base", "main", "--head", "main", "--unknown", "x"], s),
      await runReview<Prepare>("no-such-subcommand", [], s),
    ];
    for (const r of runs) expect({ exitCode: r.exitCode, code: (r.json as { code?: string } | undefined)?.code }).toEqual({ exitCode: 2, code: "INVALID_INPUT" });
    expect(existsSync(W)).toBe(false);
  });
});
