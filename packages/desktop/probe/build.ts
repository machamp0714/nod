// 本番の署名・配置を変えずに、通知 API の実機検証用 .app を作る。
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createIssue, initWorkspace, openDb } from "../../core/src";

const variant = process.argv[2] ?? "complete";
if (!/^[a-z][a-z0-9-]*$/.test(variant)) throw new Error("検証名は英小文字・数字・ハイフンで指定してください");
const name = `nod-notification-${variant}-probe`;
const app = join(homedir(), "Library", "Application Support", "nod-notification-probe", `${name}.app`);
mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
const root = join(import.meta.dir, "..", "..", "..");
if (variant === "full") {
  const stateDir = join(homedir(), "Library", "Application Support", "nod-notification-probe", "full-state");
  mkdirSync(stateDir, { recursive: true });
  const db = openDb(join(stateDir, "nod.db"));
  const ws = initWorkspace(db, { path: stateDir, key: "PROBE" }).workspace;
  if (!db.query("SELECT 1 FROM issues LIMIT 1").get()) {
    createIssue({ db, actor: "me" }, { workspaceId: ws.id, title: "実機のリマインダー通知を確認する" });
    createIssue({ db, actor: "me" }, { workspaceId: ws.id, title: "別の対象 Issue へのクリックを確認する" });
  }
  db.close();
  mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  writeFileSync(join(app, "Contents", "Resources", "probe.json"), JSON.stringify({
    sidecarPath: join(root, "packages", "desktop", "build", "notification-probe-nod"),
    webDir: join(root, "packages", "web", "dist"), stateDir, startupDelay: 5,
  }));
}
writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>io.github.machamp0714.nod.notification-${variant}-probe</string>
<key>CFBundleExecutable</key><string>${name}</string>
<key>CFBundleName</key><string>nod 通知検証 ${variant}</string>
<key>CFBundleDisplayName</key><string>nod 通知検証 ${variant}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>11.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
`);
for (const cmd of [
  ["swiftc", join(import.meta.dir, "engine.swift"), join(import.meta.dir, "notification.swift"), "-o", join(app, "Contents", "MacOS", name)],
  ["codesign", "--force", "--sign", "-", app],
  ["codesign", "--verify", "--strict", app],
  ["/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", "-f", app],
]) {
  const result = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${cmd[0]} が終了コード ${result.exitCode} で失敗しました`);
}
console.log(`検証アプリ: ${app}`);
