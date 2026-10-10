// nod.app を作る: web のビルド -> CLI の compile（arm64）-> Tauri のビルド -> 署名。
// 出力は packages/desktop/dist/nod.app（git 管理外）。
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const desktop = join(import.meta.dir, "..");
const root = join(desktop, "..", "..");
const tauriDir = join(desktop, "src-tauri");
const triple = "aarch64-apple-darwin";
const sidecarSrc = join(tauriDir, "binaries", `nod-${triple}`);
const stagedWeb = join(desktop, "build", "web");
const outApp = join(desktop, "dist", "nod.app");

function run(cmd: string[], cwd: string = root): void {
  console.log(`$ ${cmd.join(" ")}`);
  const r = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`失敗しました（${r.exitCode}）: ${cmd.join(" ")}`);
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
rmSync(outApp, { recursive: true, force: true });
mkdirSync(join(desktop, "dist"), { recursive: true });
run(["ditto", built, outApp]);

// 4. 署名: sidecar 自身に entitlements を付け（Hardened Runtime）、その後 .app を --deep なしで再署名する。
//    --deep で署名し直すと sidecar の entitlements が消えるため使わない。
const sidecar = join(outApp, "Contents", "MacOS", "nod");
run([
  "codesign", "--force", "--sign", "-", "--options", "runtime",
  "--entitlements", join(import.meta.dir, "entitlements.plist"), sidecar,
]);
run(["codesign", "--force", "--sign", "-", outApp]);

// 5. 検査
run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", outApp]);
console.log(`\n完成: ${outApp}`);
