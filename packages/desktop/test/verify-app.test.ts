// 完成品の検査（scripts/verify-app.ts）が、壊れた成果物を実際に落とすことを確かめる。
// 正規の .app は desktop:build の成果物（packages/desktop/dist/nod.app）。無ければ理由を表示してスキップする。
// 壊し方は、正規の .app を一時ディレクトリへコピーして変更し、署名し直す（実バイナリの検査なので、設定ファイルの文字列だけでは通らない）。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyApp, type VerifyResult } from "../scripts/verify-app";

const desktop = join(import.meta.dir, "..");
const goodApp = join(desktop, "dist", "nod.app");
const entitlements = join(desktop, "scripts", "entitlements.plist");
const available = existsSync(join(goodApp, "Contents", "Resources", "build-info"));
if (!available) {
  console.warn(`スキップ: ${goodApp} に build-info 付きの成果物がありません。bun run desktop:build を先に実行してください`);
}
const maybe = available ? describe : describe.skip;

function sh(cmd: string[]): void {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
}

function failed(r: VerifyResult): string[] {
  return r.checks.filter((c) => !c.ok).map((c) => c.name);
}

maybe("verifyApp", () => {
  let work: string;
  let n = 0;
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "nod-verify-app-"));
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  // 正規の .app を作業用にコピーして返す
  function copyApp(): string {
    const dest = join(work, `case-${n++}`, "nod.app");
    sh(["mkdir", "-p", join(dest, "..")]);
    sh(["ditto", goodApp, dest]);
    return dest;
  }
  const sidecarOf = (app: string) => join(app, "Contents", "MacOS", "nod");
  const buildInfoOf = (app: string) => join(app, "Contents", "Resources", "build-info");
  // sidecar の署名を保ったまま .app だけ署名し直す（--deep なし）
  const resign = (app: string) => sh(["codesign", "--force", "--sign", "-", app]);

  test("正規の成果物はすべての検査を通る", async () => {
    const r = await verifyApp(goodApp);
    expect(failed(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual(["signature", "entitlements", "arch", "build-info", "version", "launch", "schema"]);
  }, 60000);

  test("sidecar に entitlements が無ければ落ちる", async () => {
    const app = copyApp();
    sh(["codesign", "--force", "--sign", "-", "--options", "runtime", sidecarOf(app)]);
    resign(app);
    const r = await verifyApp(app);
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain("entitlements");
  }, 60000);

  test("entitlements が 3 種のうち 1 つ欠けても落ちる", async () => {
    const app = copyApp();
    const partial = join(work, "partial.plist");
    const text = readFileSync(entitlements, "utf8").replace(
      /\s*<key>com\.apple\.security\.cs\.disable-library-validation<\/key>\s*<true\/>/,
      "",
    );
    writeFileSync(partial, text);
    sh(["codesign", "--force", "--sign", "-", "--options", "runtime", "--entitlements", partial, sidecarOf(app)]);
    resign(app);
    const r = await verifyApp(app);
    expect(failed(r)).toContain("entitlements");
  }, 60000);

  test("build-info の版と同梱バイナリの版が違えば落ちる", async () => {
    const app = copyApp();
    const info = JSON.parse(readFileSync(buildInfoOf(app), "utf8"));
    writeFileSync(buildInfoOf(app), JSON.stringify({ ...info, version: "9.9.9" }));
    resign(app);
    const r = await verifyApp(app);
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain("version");
    expect(failed(r)).not.toContain("signature");
  }, 60000);

  test("build-info の schema 版が実際の DB と違えば落ちる", async () => {
    const app = copyApp();
    const info = JSON.parse(readFileSync(buildInfoOf(app), "utf8"));
    writeFileSync(buildInfoOf(app), JSON.stringify({ ...info, schemaVersion: info.schemaVersion + 1 }));
    resign(app);
    const r = await verifyApp(app);
    expect(failed(r)).toContain("schema");
  }, 60000);

  test("build-info が無ければ落ちる", async () => {
    const app = copyApp();
    rmSync(buildInfoOf(app));
    resign(app);
    const r = await verifyApp(app);
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain("build-info");
  }, 60000);

  test("署名後に中身を書き換えると署名の検証で落ちる", async () => {
    const app = copyApp();
    const info = JSON.parse(readFileSync(buildInfoOf(app), "utf8"));
    writeFileSync(buildInfoOf(app), JSON.stringify({ ...info, buildTime: "2000-01-01T00:00:00Z" }));
    const r = await verifyApp(app);
    expect(failed(r)).toContain("signature");
  }, 60000);

  test("sidecar が arm64 でなければ落ちる", async () => {
    const app = copyApp();
    const src = join(work, "x86.c");
    writeFileSync(src, "int main(void){return 0;}\n");
    sh(["clang", "-arch", "x86_64", src, "-o", sidecarOf(app)]);
    sh(["codesign", "--force", "--sign", "-", "--options", "runtime", "--entitlements", entitlements, sidecarOf(app)]);
    resign(app);
    const r = await verifyApp(app);
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain("arch");
  }, 60000);

  test("web が同梱されていなければ、隔離データでの起動で落ちる", async () => {
    const app = copyApp();
    rmSync(join(app, "Contents", "Resources", "web"), { recursive: true });
    resign(app);
    const r = await verifyApp(app);
    expect(failed(r)).toContain("launch");
  }, 60000);
});
