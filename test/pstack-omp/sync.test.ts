// pstack を OMP 向けに使う道具（scripts/pstack-omp/cli.ts）の同期（sync）を、プロセスとして起動して外から確かめる。
// 上流は一時ディレクトリに作った git リポジトリ、固定の記録・データ置き場・omp の実行ファイル（版を出すだけの偽物）も一時のものを
// 環境変数で渡す。ネットワークとモデルの呼び出しはしない。
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../scripts/pstack-omp/cli.ts");
const PIN = join(import.meta.dir, "../../scripts/pstack-omp/pin.json");

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface Pin {
  repository: string;
  commit: string;
  pstackVersion: string;
  ompVersion: string;
}

// 利用者の git の設定（global・system）に左右されないようにする
function gitEnv(root: string): Record<string, string> {
  const globalConfig = join(root, "gitconfig");
  if (!existsSync(globalConfig)) writeFileSync(globalConfig, "");
  return {
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
}

function git(root: string, cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...gitEnv(root) }, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

interface Sandbox {
  root: string;
  upstream: string;
  dataDir: string;
  clone: string;
  // 上流に pstack の版 version のコミットを足し、そのコミットを返す
  commit(version: string, files?: Record<string, string>): string;
  // 固定の記録を書く。省いた項目は既定（一時の上流・最後のコミット・その版・OMP 19.1.0）
  pin(over?: Partial<Pin>): void;
  // omp --version が出す版を決める。null なら omp を失敗させる
  omp(version: string | null): void;
  sync(): Promise<Run>;
  cloneHead(): string;
  cloneStatus(): string;
}

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "nod-pstack-omp-sync-"));
  const upstream = join(root, "upstream-src");
  const dataDir = join(root, "data");
  const pinPath = join(root, "pin.json");
  const ompBin = join(root, "omp");
  mkdirSync(upstream);
  git(root, upstream, "init", "-q", "-b", "main");
  let last = { commit: "", version: "" };

  const sb: Sandbox = {
    root,
    upstream,
    dataDir,
    clone: join(dataDir, "pstack-omp", "upstream"),
    commit(version, files = {}) {
      const all: Record<string, string> = {
        "pstack/.cursor-plugin/plugin.json": JSON.stringify({ name: "pstack", version }, null, "\t") + "\n",
        "pstack/skills/poteto-mode/SKILL.md": `---\nname: poteto-mode\n---\n\n${version}\n`,
        ...files,
      };
      for (const [path, content] of Object.entries(all)) {
        mkdirSync(join(upstream, path, ".."), { recursive: true });
        writeFileSync(join(upstream, path), content);
      }
      git(root, upstream, "add", "-A");
      git(root, upstream, "commit", "-q", "-m", `pstack ${version}`);
      last = { commit: git(root, upstream, "rev-parse", "HEAD"), version };
      return last.commit;
    },
    pin(over = {}) {
      const pin: Pin = { repository: upstream, commit: last.commit, pstackVersion: last.version, ompVersion: "19.1.0", ...over };
      writeFileSync(pinPath, JSON.stringify(pin, null, 2) + "\n");
    },
    omp(version) {
      writeFileSync(ompBin, version === null ? "#!/bin/sh\necho 'omp: 壊れている' >&2\nexit 3\n" : `#!/bin/sh\necho 'omp/${version}'\n`);
      chmodSync(ompBin, 0o755);
    },
    async sync() {
      const proc = Bun.spawn([process.execPath, CLI, "sync"], {
        cwd: root,
        env: { ...process.env, ...gitEnv(root), NOD_DATA_DIR: dataDir, NOD_PSTACK_OMP_PIN: pinPath, NOD_PSTACK_OMP_OMP_BIN: ompBin },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { exitCode, stdout, stderr };
    },
    cloneHead: () => git(root, sb.clone, "rev-parse", "HEAD"),
    cloneStatus: () => git(root, sb.clone, "status", "--porcelain", "--ignored"),
  };
  sb.omp("19.1.0");
  return sb;
}

describe("固定の記録", () => {
  test("リポジトリの URL・コミット・pstack の版・確かめた OMP の版が書かれている", () => {
    const pin = JSON.parse(readFileSync(PIN, "utf8"));
    expect(pin).toEqual({
      repository: "https://github.com/cursor/plugins.git",
      commit: "792440e8a560a4a3f63748cdee70491ecd412982",
      pstackVersion: "0.15.46",
      ompVersion: "19.1.0",
    });
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
    expect(readdirSync(join(sb.dataDir, "pstack-omp"))).toEqual(["upstream"]);
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
});

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

  test("既存の clone を変えない", async () => {
    const sb = sandbox();
    const pinned = sb.commit("0.15.46");
    sb.pin();
    expect((await sb.sync()).exitCode).toBe(0);
    sb.commit("0.15.47");
    sb.pin();
    sb.omp("19.0.1");

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(sb.cloneHead()).toBe(pinned);
    expect(sb.cloneStatus()).toBe("");
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
  ])("既存の clone があるとき: $label。clone を変えない", async ({ over, reason }) => {
    const sb = sandbox();
    const pinned = sb.commit("0.15.46");
    sb.pin();
    expect((await sb.sync()).exitCode).toBe(0);
    sb.commit("0.15.47");
    sb.pin(over());

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(reason);
    expect(sb.cloneHead()).toBe(pinned);
    expect(sb.cloneStatus()).toBe("");
    expect(readdirSync(join(sb.dataDir, "pstack-omp"))).toEqual(["upstream"]);
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
