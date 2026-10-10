// desktop:deploy（scripts/deploy.ts）の通し。配置先・ラッパー・退避先・DB はすべて一時ディレクトリ。
// ビルド・プロセス一覧・アプリの終了と起動・起動確認は差し替える。実プロセスへの kill や本番パスへの書き込みはしない。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deploy, discoverSidecarUrl, findAppSidecars, isManualNodUi, parseLsofListen, parsePs, resolveConfig,
  wrapperContent, type DeployConfig, type DeployDeps, type LaunchVerification,
} from "../scripts/deploy";

const HEAD = "a".repeat(40);

function makeApp(dir: string, version: string, commit = HEAD, dirty = false): string {
  const app = join(dir, "nod.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents", "Resources", "web"), { recursive: true });
  writeFileSync(
    join(app, "Contents", "Resources", "build-info"),
    JSON.stringify({ version, commit, dirty, buildTime: new Date().toISOString(), schemaVersion: 1 }),
  );
  const sidecar = join(app, "Contents", "MacOS", "nod");
  writeFileSync(sidecar, `#!/bin/bash\necho "ARGS:$*"\necho "CWD:$PWD"\n`);
  chmodSync(sidecar, 0o755);
  return app;
}

interface Harness {
  root: string;
  cfg: DeployConfig;
  deps: DeployDeps;
  logs: string[];
  state: {
    running: boolean;
    stuck: boolean; // true なら終了を依頼しても止まらない
    status: string;
    procs: { pid: number; command: string }[];
    buildCode: number;
    buildCalls: number;
    quitCalls: number;
    launchCalls: string[];
    verifyResult: () => LaunchVerification;
    clock: number;
    newVersion: string;
  };
}

let roots: string[] = [];

function harness(over: { newVersion?: string; keep?: number } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "nod-deploy-test-"));
  roots.push(root);
  const state: Harness["state"] = {
    running: false, stuck: false, status: "", procs: [], buildCode: 0, buildCalls: 0, quitCalls: 0,
    launchCalls: [], verifyResult: () => ({ ok: true, lines: ["ok stub"] }),
    clock: Date.UTC(2026, 9, 10, 12, 0, 0), newVersion: over.newVersion ?? "0.2.0",
  };
  const cfg: DeployConfig = {
    repoRoot: join(root, "repo"),
    appSrc: join(root, "dist", "nod.app"),
    applicationsDir: join(root, "Applications"),
    wrapperPath: join(root, "bin", "nod"),
    archiveDir: join(root, "archive"),
    legacyDir: join(root, "nod-app"),
    buildCommand: "stub-build",
    dbPath: join(root, "data", "nod.db"),
    quitTimeoutMs: 150,
    launchTimeoutMs: 100,
    keep: over.keep ?? 3,
  };
  mkdirSync(join(root, "data", "backups"), { recursive: true });
  writeFileSync(cfg.dbPath, "DB-ORIGINAL");
  const logs: string[] = [];
  const deps: DeployDeps = {
    log: (l) => logs.push(l),
    gitStatus: () => state.status,
    gitHead: () => HEAD,
    listProcesses: () => state.procs,
    runBuild: () => {
      state.buildCalls++;
      if (state.buildCode === 0) {
        rmSync(join(root, "dist"), { recursive: true, force: true });
        makeApp(join(root, "dist"), state.newVersion);
      }
      return state.buildCode;
    },
    isAppRunning: () => state.running,
    requestQuit: () => {
      state.quitCalls++;
      if (!state.stuck) state.running = false;
    },
    sleep: async (ms) => {
      await new Promise((r) => setTimeout(r, Math.min(ms, 5)));
    },
    now: () => new Date((state.clock += 1000)),
    launchApp: (p) => {
      state.launchCalls.push(p);
      state.running = true;
    },
    verifyLaunch: async () => state.verifyResult(),
  };
  return { root, cfg, deps, logs, state };
}

function installOldLayout(h: Harness): void {
  mkdirSync(join(h.cfg.legacyDir, "web"), { recursive: true });
  writeFileSync(join(h.cfg.legacyDir, "nod"), "LEGACY-BIN");
  mkdirSync(join(h.root, "bin"), { recursive: true });
  writeFileSync(h.cfg.wrapperPath, "#!/bin/bash\n# OLD-WRAPPER\n");
  chmodSync(h.cfg.wrapperPath, 0o755);
}

function archiveApps(h: Harness): string[] {
  return existsSync(h.cfg.archiveDir) ? readdirSync(h.cfg.archiveDir).filter((n) => n.endsWith(".app")).sort() : [];
}

function installedVersion(h: Harness): string {
  const j = JSON.parse(readFileSync(join(h.cfg.applicationsDir, "nod.app", "Contents", "Resources", "build-info"), "utf8"));
  return j.version;
}

beforeEach(() => {
  roots = [];
});
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("deploy: 通し", () => {
  test("初回導入: .app を置き、ラッパーを切り替え、旧ラッパーと旧配置を退避し、データには触れない", async () => {
    const h = harness();
    installOldLayout(h);
    const r = await deploy(h.cfg, h.deps);
    expect(r).toEqual({ ok: true, outcome: "ok" });
    expect(installedVersion(h)).toBe("0.2.0");
    expect(h.state.launchCalls).toEqual([join(h.cfg.applicationsDir, "nod.app")]);
    // ラッパーは新しい .app 向け
    expect(readFileSync(h.cfg.wrapperPath, "utf8")).toBe(wrapperContent(join(h.cfg.applicationsDir, "nod.app")));
    // 旧ラッパーと旧配置は archive へ
    const names = readdirSync(h.cfg.archiveDir);
    const oldWrapper = names.find((n) => n.startsWith("nod-wrapper-"))!;
    expect(readFileSync(join(h.cfg.archiveDir, oldWrapper), "utf8")).toContain("OLD-WRAPPER");
    const legacy = names.find((n) => n.startsWith("nod-app-"))!;
    expect(readFileSync(join(h.cfg.archiveDir, legacy, "nod"), "utf8")).toBe("LEGACY-BIN");
    expect(existsSync(h.cfg.legacyDir)).toBe(false);
    // データ
    expect(readFileSync(h.cfg.dbPath, "utf8")).toBe("DB-ORIGINAL");
    // 隔離属性が付いていない
    const xa = Bun.spawnSync(["xattr", "-r", join(h.cfg.applicationsDir, "nod.app")], { stdout: "pipe" });
    expect(xa.stdout.toString()).not.toContain("com.apple.quarantine");
  });

  test("更新: 旧 .app は版と日時の名前で退避され、ラッパーは書き換えない", async () => {
    const h = harness();
    installOldLayout(h);
    await deploy(h.cfg, h.deps); // 初回
    h.state.newVersion = "0.3.0";
    const wrapperBefore = readFileSync(h.cfg.wrapperPath, "utf8");
    const archiveBefore = readdirSync(h.cfg.archiveDir).filter((n) => n.startsWith("nod-wrapper-"));
    const r = await deploy(h.cfg, h.deps);
    expect(r.ok).toBe(true);
    expect(installedVersion(h)).toBe("0.3.0");
    const apps = archiveApps(h);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatch(/^nod-\d{8}T\d{9}Z-0\.2\.0\.app$/);
    expect(readFileSync(h.cfg.wrapperPath, "utf8")).toBe(wrapperBefore);
    expect(readdirSync(h.cfg.archiveDir).filter((n) => n.startsWith("nod-wrapper-"))).toEqual(archiveBefore);
  });

  test("世代の保持: 退避した .app は最新 3 件だけが残る", async () => {
    const h = harness();
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      h.state.newVersion = `0.${i}.0`;
      const r = await deploy(h.cfg, h.deps);
      expect(r.ok).toBe(true);
      seen.push(`0.${i}.0`);
    }
    const apps = archiveApps(h);
    expect(apps).toHaveLength(3);
    // 残るのは直近 3 世代の旧版（0.2.0, 0.3.0, 0.4.0）。現行の 0.5.0 は ~/Applications
    expect(apps.map((n) => /-(0\.\d\.0)\.app$/.exec(n)![1])).toEqual(["0.2.0", "0.3.0", "0.4.0"]);
    expect(installedVersion(h)).toBe("0.5.0");
  });

  test("稼働中のアプリには通常の終了を依頼し、停止してから入れ替える", async () => {
    const h = harness();
    h.state.running = true;
    const r = await deploy(h.cfg, h.deps);
    expect(r.ok).toBe(true);
    expect(h.state.quitCalls).toBe(1);
  });
});

describe("deploy: ラッパー", () => {
  test("同じ内容なら何もしない（冪等）", async () => {
    const h = harness();
    installOldLayout(h);
    await deploy(h.cfg, h.deps);
    const before = Bun.file(h.cfg.wrapperPath).lastModified;
    const logsBefore = h.logs.length;
    await Bun.sleep(20);
    await deploy(h.cfg, h.deps);
    expect(Bun.file(h.cfg.wrapperPath).lastModified).toBe(before);
    expect(h.logs.slice(logsBefore).some((l) => l.includes("ラッパーは最新"))).toBe(true);
  });

  test("cwd を変えず、ui では web を渡し、--web-dir があれば足さない", () => {
    const root = mkdtempSync(join(tmpdir(), "nod-deploy-wrapper-"));
    roots.push(root);
    const app = makeApp(root, "0.2.0");
    const wrapper = join(root, "nod-wrapper");
    writeFileSync(wrapper, wrapperContent(app));
    chmodSync(wrapper, 0o755);
    const cwd = join(root, "work dir");
    mkdirSync(cwd);
    const run = (...args: string[]) => {
      const r = Bun.spawnSync([wrapper, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin" } });
      return r.stdout.toString();
    };
    const web = join(app, "Contents", "Resources", "web");
    const ui = run("ui", "--port", "0");
    expect(ui).toContain(`ARGS:ui --web-dir ${web} --port 0`);
    expect(ui).toContain(`CWD:${realpathSync(cwd)}`);
    expect(run("ui", "--web-dir", "/x")).toContain("ARGS:ui --web-dir /x");
    expect(run("ui", "--web-dir", "/x")).not.toContain(web);
    expect(run("issue", "list")).toContain("ARGS:issue list");
    expect(run("--version")).toContain("ARGS:--version");
  });
});

describe("deploy: 前提の確認での中止", () => {
  test("未コミットの変更があれば、ビルドも入れ替えもせずに中止する", async () => {
    const h = harness();
    installOldLayout(h);
    h.state.status = " M packages/core/src/db.ts\n";
    const r = await deploy(h.cfg, h.deps);
    expect(r).toEqual({ ok: false, outcome: "aborted-precondition" });
    expect(h.state.buildCalls).toBe(0);
    expect(existsSync(h.cfg.applicationsDir)).toBe(false);
    expect(readFileSync(h.cfg.wrapperPath, "utf8")).toContain("OLD-WRAPPER");
    expect(h.logs.join("\n")).toContain("未コミット");
  });

  test("手動の nod ui が稼働中なら、止めずに中止する", async () => {
    const h = harness();
    h.state.procs = [
      { pid: 100, command: "/Users/x/.local/share/nod-app/nod ui --web-dir /Users/x/.local/share/nod-app/web" },
    ];
    const r = await deploy(h.cfg, h.deps);
    expect(r).toEqual({ ok: false, outcome: "aborted-precondition" });
    expect(h.state.buildCalls).toBe(0);
    expect(h.state.quitCalls).toBe(0);
    expect(h.logs.join("\n")).toContain("pid 100");
  });

  test(".app 自身の sidecar は手動の nod ui に数えない", async () => {
    const h = harness();
    h.state.procs = [{ pid: 7, command: "/Users/x/Applications/nod.app/Contents/MacOS/nod ui --port 0 --no-open" }];
    const r = await deploy(h.cfg, h.deps);
    expect(r.ok).toBe(true);
  });
});

describe("deploy: ビルドと終了での中止", () => {
  test("ビルドが失敗したら何も入れ替えない", async () => {
    const h = harness();
    installOldLayout(h);
    h.state.buildCode = 1;
    const r = await deploy(h.cfg, h.deps);
    expect(r).toEqual({ ok: false, outcome: "aborted-build" });
    expect(existsSync(h.cfg.applicationsDir)).toBe(false);
    expect(readFileSync(h.cfg.wrapperPath, "utf8")).toContain("OLD-WRAPPER");
  });

  test("成果物が HEAD の commit でなければ中止する", async () => {
    const h = harness();
    h.deps.gitHead = () => "b".repeat(40);
    const r = await deploy(h.cfg, h.deps);
    expect(r).toEqual({ ok: false, outcome: "aborted-build" });
    expect(existsSync(h.cfg.applicationsDir)).toBe(false);
  });

  test("アプリが終了しなければ中止し、強制終了せず、何も変えない", async () => {
    const h = harness();
    installOldLayout(h);
    const oldApp = makeApp(h.cfg.applicationsDir, "0.1.0");
    h.state.running = true;
    h.state.stuck = true;
    const r = await deploy(h.cfg, h.deps);
    expect(r).toEqual({ ok: false, outcome: "aborted-quit-timeout" });
    expect(h.state.quitCalls).toBe(1); // 依頼は 1 回。それ以上のことはしない
    expect(JSON.parse(readFileSync(join(oldApp, "Contents", "Resources", "build-info"), "utf8")).version).toBe("0.1.0");
    expect(readFileSync(h.cfg.wrapperPath, "utf8")).toContain("OLD-WRAPPER");
    expect(archiveApps(h)).toEqual([]);
    expect(h.state.launchCalls).toEqual([]);
  });
});

describe("deploy: 起動確認の失敗", () => {
  test("migration が走っていなければ、旧 .app と旧ラッパーへ自動で戻す", async () => {
    const h = harness();
    installOldLayout(h);
    makeApp(h.cfg.applicationsDir, "0.1.0");
    writeFileSync(join(h.root, "data", "backups", "nod-20260101T000000000Z-0000-v1.db"), "B"); // 既存の世代
    h.state.verifyResult = () => ({ ok: false, lines: ["FAIL /api/workspaces が 500"] });
    const r = await deploy(h.cfg, h.deps);
    expect(r).toEqual({ ok: false, outcome: "rolled-back" });
    expect(installedVersion(h)).toBe("0.1.0");
    expect(readFileSync(h.cfg.wrapperPath, "utf8")).toContain("OLD-WRAPPER");
    expect(existsSync(join(h.cfg.legacyDir, "nod"))).toBe(true); // 旧配置は動かしていない
    expect(archiveApps(h)).toEqual([]);
    expect(readdirSync(h.cfg.archiveDir)).toEqual([]);
    expect(h.state.quitCalls).toBe(1); // 起動したアプリへの通常の終了の依頼
    expect(h.state.running).toBe(false);
    expect(readFileSync(h.cfg.dbPath, "utf8")).toBe("DB-ORIGINAL");
  });

  test("初回導入で失敗したら、新しい .app を消して旧ラッパーへ戻す", async () => {
    const h = harness();
    installOldLayout(h);
    h.state.verifyResult = () => ({ ok: false, lines: ["FAIL"] });
    const r = await deploy(h.cfg, h.deps);
    expect(r.outcome).toBe("rolled-back");
    expect(existsSync(join(h.cfg.applicationsDir, "nod.app"))).toBe(false);
    expect(readFileSync(h.cfg.wrapperPath, "utf8")).toContain("OLD-WRAPPER");
    expect(existsSync(join(h.cfg.legacyDir, "nod"))).toBe(true);
  });

  test("migration が走っていれば、戻さず復元手順を案内する", async () => {
    const h = harness();
    installOldLayout(h);
    makeApp(h.cfg.applicationsDir, "0.1.0");
    h.state.verifyResult = () => {
      // 起動の途中で migration 前のバックアップが作られた
      writeFileSync(join(h.root, "data", "backups", "nod-20261010T120000000Z-0000-v11.db"), "B");
      return { ok: false, lines: ["FAIL 起動に失敗"] };
    };
    const r = await deploy(h.cfg, h.deps);
    expect(r).toEqual({ ok: false, outcome: "needs-manual-restore" });
    expect(installedVersion(h)).toBe("0.2.0"); // 新しい .app のまま
    expect(readFileSync(h.cfg.wrapperPath, "utf8")).toBe(wrapperContent(join(h.cfg.applicationsDir, "nod.app")));
    expect(archiveApps(h)).toHaveLength(1); // 旧 .app は退避先に残っている
    const out = h.logs.join("\n");
    expect(out).toContain("migration が走った");
    expect(out).toContain("nod-20261010T120000000Z-0000-v11.db");
    expect(out).toContain("-wal");
    expect(out).toContain(archiveApps(h)[0]!);
    expect(h.state.quitCalls).toBe(0);
  });

  test("起動の確認が例外を投げても、migration がなければ戻す", async () => {
    const h = harness();
    makeApp(h.cfg.applicationsDir, "0.1.0");
    h.deps.verifyLaunch = async () => {
      throw new Error("boom");
    };
    const r = await deploy(h.cfg, h.deps);
    expect(r.outcome).toBe("rolled-back");
    expect(installedVersion(h)).toBe("0.1.0");
  });
});

describe("補助関数", () => {
  test("isManualNodUi", () => {
    expect(isManualNodUi("/Users/x/.local/share/nod-app/nod ui --web-dir /w")).toBe(true);
    expect(isManualNodUi("nod ui")).toBe(true);
    expect(isManualNodUi("/Users/x/Applications/nod.app/Contents/MacOS/nod ui --port 0")).toBe(false);
    expect(isManualNodUi("/x/nod.app/Contents/MacOS/nod-desktop")).toBe(false);
    expect(isManualNodUi("/Users/x/.local/share/nod-app/nod issue list")).toBe(false);
    expect(isManualNodUi("grep nodes ui")).toBe(false);
  });

  test("parsePs / findAppSidecars / parseLsofListen", () => {
    const procs = parsePs(
      "  12 /Users/x/Applications/nod.app/Contents/MacOS/nod-desktop\n  13 /Users/x/Applications/nod.app/Contents/MacOS/nod ui --port 0\n  14 /other/nod.app/Contents/MacOS/nod ui\n",
    );
    expect(procs).toHaveLength(3);
    expect(findAppSidecars(procs, ["/Users/x/Applications/nod.app"]).map((p) => p.pid)).toEqual([13]);
    expect(parseLsofListen("p13\nf9\nn127.0.0.1:4712\nf10\nn[::1]:4712\nn*:4713\n")).toEqual([4712, 4713]);
    expect(parseLsofListen("")).toEqual([]);
  });

  test("discoverSidecarUrl: sidecar の LISTEN ポートから URL を求める。無ければ null", async () => {
    const app = "/Users/x/Applications/nod.app";
    let calls = 0;
    const url = await discoverSidecarUrl(app, 1000, {
      ps: () => (++calls < 3 ? [] : [{ pid: 9, command: `${app}/Contents/MacOS/nod ui --port 0` }]),
      ports: (pid) => (pid === 9 ? [4712] : []),
      sleep: async () => {},
    });
    expect(url).toBe("http://127.0.0.1:4712");
    expect(await discoverSidecarUrl(app, 30, { ps: () => [], ports: () => [], sleep: async () => Bun.sleep(5) })).toBeNull();
  });

  test("resolveConfig: 環境変数と引数で差し替えられる", () => {
    const cfg = resolveConfig(
      ["--applications-dir", "/a", "--keep", "5"],
      { NOD_DEPLOY_WRAPPER: "/w/nod", NOD_DEPLOY_BUILD_CMD: "true", NOD_DB: "/d/nod.db", NOD_DEPLOY_QUIT_TIMEOUT_MS: "10" },
      "/repo",
    );
    expect(cfg).toMatchObject({
      applicationsDir: "/a", wrapperPath: "/w/nod", buildCommand: "true", dbPath: "/d/nod.db",
      quitTimeoutMs: 10, keep: 5, appSrc: "/repo/packages/desktop/dist/nod.app",
    });
    expect(() => resolveConfig(["--nope", "x"], {}, "/repo")).toThrow();
  });
});
