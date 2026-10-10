// 原画 icons/nod.svg から、Tauri が使うアイコン（png / icns）を生成する。
// macOS 標準の sips と iconutil だけを使う。生成物は icons/ に置き、git で管理する。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const iconsDir = join(import.meta.dir, "..", "icons");
const svg = join(iconsDir, "nod.svg");

function run(cmd: string[]): void {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} が失敗しました（${r.exitCode}）: ${r.stderr.toString()}`);
  }
}

const work = mkdtempSync(join(tmpdir(), "nod-icons-"));
try {
  const master = join(work, "master.png");
  run(["sips", "-s", "format", "png", "-z", "1024", "1024", svg, "--out", master]);

  const resize = (px: number, out: string): void => {
    run(["sips", "-z", String(px), String(px), master, "--out", out]);
  };

  // Tauri の bundle.icon が参照する png
  resize(32, join(iconsDir, "32x32.png"));
  resize(128, join(iconsDir, "128x128.png"));
  resize(256, join(iconsDir, "128x128@2x.png"));
  resize(512, join(iconsDir, "icon.png"));

  // icns（iconset 経由）
  const iconset = join(work, "nod.iconset");
  mkdirSync(iconset);
  const sizes: Array<[number, string]> = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ];
  for (const [px, name] of sizes) resize(px, join(iconset, name));
  run(["iconutil", "-c", "icns", iconset, "-o", join(iconsDir, "icon.icns")]);
  console.log("icons: 生成しました ->", iconsDir);
} finally {
  rmSync(work, { recursive: true, force: true });
}
