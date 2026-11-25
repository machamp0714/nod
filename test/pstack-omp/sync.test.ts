// pstack を OMP 向けに使う道具（scripts/pstack-omp/cli.ts）の同期（sync）のうち取得と固定の生成先、サブコマンドを、プロセスとして起動して外から確かめる。
// 一時の上流・置き場の作り方は helpers.ts を参照。生成は generate.test.ts で確かめる。
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, type Pin, type Sandbox, sandbox, skillMd, snapshot } from "./helpers";

const PIN = join(import.meta.dir, "../../scripts/pstack-omp/pin.json");

describe("固定の記録", () => {
  test("リポジトリの URL・コミット・pstack の版・確かめた OMP の版が書かれている", () => {
    const pin = JSON.parse(readFileSync(PIN, "utf8"));
    expect(Object.keys(pin).sort()).toEqual(["commit", "ompVersion", "pstackVersion", "repository"]);
    expect(pin.repository).toBe("https://github.com/cursor/plugins.git");
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.pstackVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pin.ompVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("同期", () => {
  test("データ置き場に上流を clone し、記録したコミットにする", async () => {
    const sb = sandbox();
    const pinned = sb.commit("0.15.46");
    sb.commit("0.15.47"); // 記録より新しいコミットが上流の先頭にあっても、記録したコミットにする
    sb.pin({ commit: pinned, pstackVersion: "0.15.46" });

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(sb.cloneHead()).toBe(pinned);
    expect(sb.cloneStatus()).toBe("");
    expect(readFileSync(join(sb.clone, "pstack/skills/poteto-mode/SKILL.md"), "utf8")).toContain("0.15.46");
    expect(run.stdout).toContain(pinned);
  });

  test("もう一度同期しても結果が変わらない。既存の clone を再利用し、手で変えた作業ツリーも記録したコミットに揃える", async () => {
    const sb = sandbox();
    const pinned = sb.commit("0.15.46");
    sb.pin();
    expect((await sb.sync()).exitCode).toBe(0);
    writeFileSync(join(sb.clone, "pstack/skills/poteto-mode/SKILL.md"), "書き換えた\n");
    writeFileSync(join(sb.clone, "untracked.txt"), "足した\n");
    // 上流に届かなくても、手元にあるコミットだけで揃う（clone し直していない）
    renameSync(sb.upstream, `${sb.upstream}-moved`);

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(sb.cloneHead()).toBe(pinned);
    expect(sb.cloneStatus()).toBe("");
    expect(readFileSync(join(sb.clone, "pstack/skills/poteto-mode/SKILL.md"), "utf8")).toBe("---\nname: poteto-mode\n---\n\n0.15.46\n");
    expect(readdirSync(join(sb.dataDir, "pstack-omp")).sort()).toEqual(["generated", "upstream"]);
  });

  test("記録を新しいコミットに上げると、既存の clone に上流から取り寄せて揃える", async () => {
    const sb = sandbox();
    sb.commit("0.15.46");
    sb.pin();
    expect((await sb.sync()).exitCode).toBe(0);
    const newer = sb.commit("0.15.47");
    sb.pin();

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(sb.cloneHead()).toBe(newer);
    expect(sb.cloneStatus()).toBe("");
  });

  test("呼び出し元のリポジトリを指す git の環境変数（フックの中など）があっても、置き場の clone だけを揃え、呼び出し元のリポジトリに触らない", async () => {
    const sb = sandbox();
    sb.commit("0.15.46");
    sb.pin();
    const { env, state } = callerRepo(sb);
    const before = state();

    // 新しく clone するとき
    const first = await sb.run("sync", { env });
    expect(first.stderr).toBe("");
    expect(first.exitCode).toBe(0);
    // 既存の clone に、上流から取り寄せて揃えるとき（手で変えた作業ツリーも揃える）
    const newer = sb.commit("0.15.47");
    sb.pin();
    writeFileSync(join(sb.clone, "untracked.txt"), "足した\n");
    const second = await sb.run("sync", { env });

    expect(second.stderr).toBe("");
    expect(second.exitCode).toBe(0);
    expect(sb.cloneHead()).toBe(newer);
    expect(sb.cloneStatus()).toBe("");
    expect(state()).toEqual(before);
    expect(before.fetched).toBe(false);
    expect(before.remotes).toBe("");
  });

  test("利用者の git の設定（global の設定ファイルの URL の読み替えなど）は同期の git にも効く", async () => {
    const sb = sandbox();
    sb.commit("0.15.46");
    const repository = "https://example.invalid/pstack-upstream.git";
    sb.pin({ repository });
    // 記録の URL を一時の上流に読み替える設定。ネットワークには出ない
    const config = join(sb.root, "gitconfig-insteadof");
    writeFileSync(config, `[url "${sb.upstream}"]\n\tinsteadOf = ${repository}\n`);
    const env = { GIT_CONFIG_GLOBAL: config };

    const first = await sb.run("sync", { env });
    expect(first.stderr).toBe("");
    expect(first.exitCode).toBe(0);
    // 既存の clone に、読み替えた URL から取り寄せる
    const newer = sb.commit("0.15.47");
    sb.pin({ repository });
    const second = await sb.run("sync", { env });

    expect(second.stderr).toBe("");
    expect(second.exitCode).toBe(0);
    expect(sb.cloneHead()).toBe(newer);
    expect(sb.cloneStatus()).toBe("");
    expect(git(sb.root, sb.clone, "config", "--get", "remote.origin.url")).toBe(repository);
  });

  const REPOSITORY = "https://example.invalid/pstack-upstream.git";
  test.each([
    {
      label: "GIT_CONFIG_COUNT と GIT_CONFIG_KEY_n・GIT_CONFIG_VALUE_n",
      config: (upstream: string) => ({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${upstream}.insteadOf`, GIT_CONFIG_VALUE_0: REPOSITORY }),
    },
    { label: "GIT_CONFIG_PARAMETERS（git -c）", config: (upstream: string) => ({ GIT_CONFIG_PARAMETERS: `'url.${upstream}.insteadof'='${REPOSITORY}'` }) },
  ])("環境変数で渡した git の設定は、呼び出し元のリポジトリを指す環境変数と一緒でも同期の git に効く: $label", async ({ config }) => {
    const sb = sandbox();
    sb.commit("0.15.46");
    sb.pin({ repository: REPOSITORY });
    const caller = callerRepo(sb);
    const before = caller.state();
    // 記録の URL を一時の上流に読み替える設定。ネットワークには出ない
    const env = { ...caller.env, ...config(sb.upstream) };

    const first = await sb.run("sync", { env });
    expect(first.stderr).toBe("");
    expect(first.exitCode).toBe(0);
    const newer = sb.commit("0.15.47");
    sb.pin({ repository: REPOSITORY });
    const second = await sb.run("sync", { env });

    expect(second.stderr).toBe("");
    expect(second.exitCode).toBe(0);
    expect(sb.cloneHead()).toBe(newer);
    expect(sb.cloneStatus()).toBe("");
    expect(caller.state()).toEqual(before);
  });
});

// 一時の呼び出し元のリポジトリ（コミットに、索引に載せた変更と、索引に載せていないファイルを重ねる）と、それを指す git の環境変数、
// その状態（索引・参照・作業ツリー・取得の跡）
function callerRepo(sb: Sandbox) {
  const caller = join(sb.root, "caller");
  mkdirSync(caller);
  git(sb.root, caller, "init", "-q", "-b", "main");
  writeFileSync(join(caller, "a.txt"), "最初\n");
  git(sb.root, caller, "add", "a.txt");
  git(sb.root, caller, "commit", "-q", "-m", "caller");
  writeFileSync(join(caller, "a.txt"), "索引に載せた\n");
  writeFileSync(join(caller, "b.txt"), "足した\n");
  git(sb.root, caller, "add", "a.txt", "b.txt");
  writeFileSync(join(caller, "untracked.txt"), "索引に載せていない\n");
  return {
    env: { GIT_DIR: join(caller, ".git"), GIT_WORK_TREE: caller, GIT_INDEX_FILE: join(caller, ".git", "index") },
    state: () => ({
      index: readFileSync(join(caller, ".git", "index")),
      stage: git(sb.root, caller, "ls-files", "--stage"),
      cached: git(sb.root, caller, "diff", "--cached", "--name-status"),
      refs: git(sb.root, caller, "for-each-ref"),
      head: git(sb.root, caller, "symbolic-ref", "HEAD"),
      remotes: git(sb.root, caller, "remote"),
      files: readdirSync(caller).sort(),
      untracked: readFileSync(join(caller, "untracked.txt"), "utf8"),
      fetched: existsSync(join(caller, ".git", "FETCH_HEAD")),
    }),
  };
}

describe("OMP の版が記録と違うと、取得せずに止まって理由を報告する", () => {
  test("置き場に何も作らない", async () => {
    const sb = sandbox();
    sb.commit("0.15.46");
    sb.pin();
    sb.omp("19.0.1");

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("19.0.1");
    expect(run.stderr).toContain("19.1.0");
    expect(existsSync(sb.dataDir)).toBe(false);
  });

  test("既存の clone と前回の生成物と利用者の設定を変えない", async () => {
    const sb = sandbox();
    const pinned = sb.commit("0.15.46");
    sb.pin();
    expect((await sb.sync()).exitCode).toBe(0);
    const before = snapshot(sb.generated);
    sb.commit("0.15.47", { "pstack/skills/newer/SKILL.md": skillMd("newer", "Newer.") });
    sb.pin();
    sb.omp("19.0.1");

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(sb.cloneHead()).toBe(pinned);
    expect(sb.cloneStatus()).toBe("");
    expect(snapshot(sb.generated)).toEqual(before);
    expect(existsSync(sb.agentDir)).toBe(false);
  });

  test("omp の版を確かめられないときも止まる", async () => {
    const sb = sandbox();
    sb.commit("0.15.46");
    sb.pin();
    sb.omp(null);

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("omp: 壊れている");
    expect(existsSync(sb.dataDir)).toBe(false);
  });
});

describe("取得の途中で失敗すると、止まって報告し、壊れた clone を残さない", () => {
  const MISSING = "0123456789abcdef0123456789abcdef01234567";

  test.each([
    { label: "上流に記録のコミットが無い", over: (): Partial<Pin> => ({ commit: MISSING }), reason: MISSING },
    { label: "clone に失敗する", over: (): Partial<Pin> => ({ repository: "/nonexistent/plugins.git" }), reason: "clone" },
    { label: "コミットの pstack の版が記録と違う", over: (): Partial<Pin> => ({ pstackVersion: "0.15.45" }), reason: "0.15.45" },
  ])("新しく取得するとき: $label", async ({ over, reason }) => {
    const sb = sandbox();
    sb.commit("0.15.46");
    sb.pin(over());

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(reason);
    expect(existsSync(sb.clone)).toBe(false);
    expect(readdirSync(join(sb.dataDir, "pstack-omp"))).toEqual([]);
  });

  test.each([
    { label: "上流に記録のコミットが無い", over: (): Partial<Pin> => ({ commit: MISSING }), reason: MISSING },
    { label: "コミットの pstack の版が記録と違う", over: (): Partial<Pin> => ({ pstackVersion: "0.15.45" }), reason: "0.15.45" },
    { label: "origin が記録のリポジトリと違う", over: (): Partial<Pin> => ({ repository: "https://example.com/other.git" }), reason: "origin" },
  ])("既存の clone があるとき: $label。clone と前回の生成物と利用者の設定を変えない", async ({ over, reason }) => {
    const sb = sandbox();
    const pinned = sb.commit("0.15.46");
    sb.pin();
    expect((await sb.sync()).exitCode).toBe(0);
    const before = snapshot(sb.generated);
    sb.commit("0.15.47", { "pstack/skills/newer/SKILL.md": skillMd("newer", "Newer.") });
    sb.pin(over());

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(reason);
    expect(sb.cloneHead()).toBe(pinned);
    expect(sb.cloneStatus()).toBe("");
    expect(readdirSync(join(sb.dataDir, "pstack-omp")).sort()).toEqual(["generated", "upstream"]);
    expect(snapshot(sb.generated)).toEqual(before);
    expect(existsSync(sb.agentDir)).toBe(false);
  });

  test("置き場に clone でないものがあれば、触らずに止まる", async () => {
    const sb = sandbox();
    sb.commit("0.15.46");
    sb.pin();
    mkdirSync(sb.clone, { recursive: true });
    writeFileSync(join(sb.clone, "keep.txt"), "利用者のもの\n");

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(sb.clone);
    expect(readdirSync(sb.clone)).toEqual(["keep.txt"]);
    expect(readFileSync(join(sb.clone, "keep.txt"), "utf8")).toBe("利用者のもの\n");
  });

  test("固定の記録に項目が欠けていれば、取得せずに止まる", async () => {
    const sb = sandbox();
    sb.commit("0.15.46");
    sb.pin({ commit: "" });

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("commit");
    expect(existsSync(sb.dataDir)).toBe(false);
  });
});

describe("固定の生成先", () => {
  test("同期は <データ置き場>/pstack-omp/generated に生成し、OMP の設定の置き場には何も書かず、読み込みの設定は一度だけ登録して status で確かめられることを出す", async () => {
    const sb = sandbox();
    sb.commit("0.15.46");
    sb.pin();

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`OMP 向けのコピーを生成しました: ${sb.generated}（`);
    expect(run.stdout).toContain(
      "読み込みの設定は README（pstack を OMP で使う）のとおり一度だけ手で登録します。揃っているかは bun scripts/pstack-omp/cli.ts status で確かめられます\n",
    );
    expect(existsSync(join(sb.generated, "pstack", "skills", "poteto-mode", "SKILL.md"))).toBe(true);
    expect(readdirSync(join(sb.dataDir, "pstack-omp")).sort()).toEqual(["generated", "upstream"]);
    expect(existsSync(sb.agentDir)).toBe(false);
  });

  test("NOD_PSTACK_OMP_OMP_BIN が無ければ、PATH の omp で版を確かめる", async () => {
    const sb = sandbox();
    sb.commit("0.15.46");
    sb.pin();

    const run = await sb.run("sync", { env: { NOD_PSTACK_OMP_OMP_BIN: undefined, PATH: [join(sb.ompBin, ".."), process.env.PATH].join(":") } });

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
  });
});

// Claude Code と Codex 向けのプラグインの内容（nod のリポジトリの plugins/、.claude-plugin/、.agents/plugins/）のハッシュ
function pluginHash(): string {
  const repo = join(import.meta.dir, "..", "..");
  const hasher = new Bun.CryptoHasher("sha256");
  for (const dir of ["plugins", ".claude-plugin", ".agents/plugins"]) {
    for (const [path, entry] of snapshot(join(repo, dir))) hasher.update(`${dir}/${path}\0${entry.executable}\0${entry.content}\0`);
  }
  return hasher.digest("hex");
}

describe("サブコマンド・プラグイン・nod の CLI", () => {
  test("同期と状態の表示を実行しても、Claude Code と Codex 向けのプラグインの内容が変わらない", async () => {
    const before = pluginHash();
    const sb = sandbox({ repoContent: true });
    sb.commit("0.15.46", {
      "pstack/skills/tdd/SKILL.md": skillMd("tdd", "Red, green."),
      "pstack/skills/no-comments/SKILL.md": skillMd("no-comments", "Spawn Comment Sicko."),
      "pstack/agents/comment-sicko.md": "---\nname: comment-sicko\n---\n\nReview comments.\n",
    });
    sb.pin();

    const runs = [await sb.sync(), await sb.run("status")];

    expect(runs.map((run) => run.exitCode)).toEqual([0, 0]);
    expect(pluginHash()).toBe(before);
  });

  test("nod の CLI（packages/cli）に pstack のコマンドが無い", () => {
    const cli = join(import.meta.dir, "..", "..", "packages", "cli", "src");
    const mentions = [...snapshot(cli)].filter(([, entry]) => Buffer.from(entry.content, "base64").toString("utf8").includes("pstack")).map(([path]) => path);

    expect(mentions).toEqual([]);
  });

  test.each(["apply", "remove", "toString", "constructor", "hasOwnProperty", "__proto__"])(
    "sync と status のほかのサブコマンド %s は、使い方を出して 2 で終わり、何も作らない",
    async (name) => {
      const sb = sandbox();

      const run = await sb.run(name);

      expect(run.exitCode).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toBe("使い方: bun scripts/pstack-omp/cli.ts <sync|status>\n");
      expect(existsSync(sb.dataDir)).toBe(false);
      expect(existsSync(sb.agentDir)).toBe(false);
    },
  );
});
