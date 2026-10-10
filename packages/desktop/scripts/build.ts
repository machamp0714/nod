// nod.app を作る: web のビルド -> CLI の compile（arm64）-> Tauri のビルド -> 署名。
// 出力は packages/desktop/dist/nod.app（git 管理外）。
import { chmodSync, cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_VERSION } from "../../core/src/db";
import { formatResult, verifyApp, type BuildInfo } from "./verify-app";

const desktop = join(import.meta.dir, "..");
const root = join(desktop, "..", "..");
const tauriDir = join(desktop, "src-tauri");
const triple = "aarch64-apple-darwin";
const sidecarSrc = join(tauriDir, "binaries", `nod-${triple}`);
const stagedWeb = join(desktop, "build", "web");
const outApp = join(desktop, "dist", "nod.app");
// 検査を通る前の成果物は dist に置かない。ここで作って署名・検査し、通ったものだけを outApp へ移す
const stageDir = join(desktop, "build", "stage");
const stagedApp = join(stageDir, "nod.app");

function run(cmd: string[], cwd: string = root): void {
  console.log(`$ ${cmd.join(" ")}`);
  const r = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`失敗しました（${r.exitCode}）: ${cmd.join(" ")}`);
}

// 0. 前回の成果物を消す。このビルドが検査を通るまで、dist/nod.app は存在しない
rmSync(outApp, { recursive: true, force: true });
rmSync(stageDir, { recursive: true, force: true });

// 版の一本化: アプリ版は packages/desktop/package.json。tauri.conf.json と CLI（nod --version）が一致しなければ中止
async function versionOf(path: string): Promise<string> {
  return ((await Bun.file(path).json()) as { version: string }).version;
}
const appVersion = await versionOf(join(desktop, "package.json"));
for (const other of [join(tauriDir, "tauri.conf.json"), join(root, "packages", "cli", "package.json")]) {
  const v = await versionOf(other);
  if (v !== appVersion) throw new Error(`版が一致しません: ${other} は ${v}、packages/desktop/package.json は ${appVersion}`);
}

function capture(cmd: string[]): string {
  const r = Bun.spawnSync(cmd, { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`失敗しました（${r.exitCode}）: ${cmd.join(" ")}\n${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

// 1. web
run(["bun", "run", "web:build"]);
rmSync(stagedWeb, { recursive: true, force: true });
mkdirSync(join(desktop, "build"), { recursive: true });
cpSync(join(root, "packages", "web", "dist"), stagedWeb, { recursive: true });

// 2. sidecar（既存 CLI の arm64 compile）
mkdirSync(join(tauriDir, "binaries"), { recursive: true });
run([
  "bun", "build", "packages/cli/src/main.ts", "--compile",
  "--target=bun-darwin-arm64", "--outfile", sidecarSrc,
]);
chmodSync(sidecarSrc, 0o755);

// 3. Tauri（.app まで。ここで ad-hoc 署名される）
run(["bunx", "--no-install", "tauri", "build", "--bundles", "app", "--ci"], desktop);
const built = join(tauriDir, "target", "release", "bundle", "macos", "nod.app");
if (!existsSync(built)) throw new Error(`nod.app が見つかりません: ${built}`);
mkdirSync(stageDir, { recursive: true });
run(["ditto", built, stagedApp]);

// 4. build-info を Resources に置く（署名より前。置いた後に署名する）
const buildInfo: BuildInfo = {
  version: appVersion,
  commit: capture(["git", "rev-parse", "HEAD"]),
  dirty: capture(["git", "status", "--porcelain"]) !== "",
  buildTime: new Date().toISOString(),
  schemaVersion: SCHEMA_VERSION,
};
writeFileSync(join(stagedApp, "Contents", "Resources", "build-info"), `${JSON.stringify(buildInfo, null, 2)}\n`);

// 5. 署名: sidecar 自身に entitlements を付け（Hardened Runtime）、その後 .app を --deep なしで再署名する。
//    --deep で署名し直すと sidecar の entitlements が消えるため使わない。
const sidecar = join(stagedApp, "Contents", "MacOS", "nod");
run([
  "codesign", "--force", "--sign", "-", "--options", "runtime",
  "--entitlements", join(import.meta.dir, "entitlements.plist"), sidecar,
]);
run(["codesign", "--force", "--sign", "-", stagedApp]);

// 6. 検査。通ったものだけを dist/nod.app に置く
console.log(`\n検査: ${stagedApp}`);
const result = await verifyApp(stagedApp);
console.log(formatResult(result));
if (!result.ok) {
  rmSync(stageDir, { recursive: true, force: true });
  console.error("\n完成品の検査に失敗したため、成果物は作りません。");
  process.exit(1);
}
mkdirSync(join(desktop, "dist"), { recursive: true });
renameSync(stagedApp, outApp);
rmSync(stageDir, { recursive: true, force: true });
console.log(`\n完成: ${outApp}（version ${buildInfo.version} / commit ${buildInfo.commit.slice(0, 7)}${buildInfo.dirty ? " + 未コミットの変更あり" : ""}）`);
