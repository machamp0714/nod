// 完成した nod.app の検査。desktop:build の最後と bun test から使う。単体でも実行できる。
//   bun run packages/desktop/scripts/verify-app.ts <nod.app のパス>
// 設定ファイルの文字列ではなく、署名・実バイナリ・実際の起動で判定する。
//
// build-info（Contents/Resources/build-info。JSON）の形式:
//   { "version": "0.1.0",            // アプリ版。同梱の nod の --version と一致する
//     "commit": "<git の全長ハッシュ>",
//     "dirty": false,                // ビルド時に未コミットの変更があったか
//     "buildTime": "<ISO 8601>",
//     "schemaVersion": 12 }          // core の SCHEMA_VERSION。起動した DB の user_version と一致する
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface BuildInfo {
  version: string;
  commit: string;
  dirty: boolean;
  buildTime: string;
  schemaVersion: number;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  checks: Check[];
}

// sidecar（Bun の JIT に要る）に実際に付いていなければならない entitlements
export const REQUIRED_ENTITLEMENTS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
];

const LAUNCH_TIMEOUT_MS = 15000;

interface Exec {
  code: number;
  stdout: string;
  stderr: string;
}

function exec(cmd: string[], env?: Record<string, string>, timeoutMs = 20000): Exec {
  try {
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", env, timeout: timeoutMs });
    return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  } catch (e) {
    return { code: -1, stdout: "", stderr: String(e) };
  }
}

function isolatedEnv(dir: string): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    HOME: dir,
    NOD_DB: join(dir, "nod.db"),
    NOD_DOCS_DIR: join(dir, "documents"),
    NOD_ATTACHMENTS_DIR: join(dir, "attachments"),
    NOD_TOGGL_CONFIG: join(dir, "toggl.json"),
    NOD_ORCA: "0",
  };
}

// 同梱の nod を、隔離したデータで起動して /api/workspaces が 200 を返すかを見る
async function launch(sidecar: string, webDir: string, dir: string): Promise<Check> {
  const proc = Bun.spawn([sidecar, "ui", "--port", "0", "--no-open", "--web-dir", webDir], {
    cwd: dir,
    env: isolatedEnv(dir),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderrText = new Response(proc.stderr).text();
  try {
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let out = "";
    let url: string | null = null;
    while (!url) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((r) => setTimeout(() => r(null), left)),
      ]);
      if (chunk === null || chunk.done) break;
      out += decoder.decode(chunk.value);
      url = /http:\/\/[A-Za-z0-9.-]+:\d+/.exec(out)?.[0] ?? null;
    }
    if (!url) {
      proc.kill();
      const err = (await stderrText).trim();
      return { name: "launch", ok: false, detail: `起動の URL が得られませんでした。stdout: ${out.trim() || "（なし）"} stderr: ${err || "（なし）"}` };
    }
    const res = await fetch(new URL("/api/workspaces", url), { signal: AbortSignal.timeout(5000) });
    if (res.status !== 200) return { name: "launch", ok: false, detail: `/api/workspaces が ${res.status} を返しました` };
    return { name: "launch", ok: true, detail: `${url} の /api/workspaces が 200` };
  } catch (e) {
    return { name: "launch", ok: false, detail: `起動の確認に失敗しました: ${e}` };
  } finally {
    proc.kill();
    await proc.exited;
  }
}

export async function verifyApp(appPath: string): Promise<VerifyResult> {
  const app = resolve(appPath);
  const sidecar = join(app, "Contents", "MacOS", "nod");
  const resources = join(app, "Contents", "Resources");
  const checks: Check[] = [];
  const push = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const hasSidecar = existsSync(sidecar);

  // 1. 署名
  const sig = exec(["codesign", "--verify", "--deep", "--strict", "--verbose=2", app]);
  push("signature", sig.code === 0, sig.code === 0 ? "codesign --verify --deep --strict 合格" : sig.stderr.trim() || `終了コード ${sig.code}`);

  // 2. sidecar 自身の entitlements（実際に付いたもの）
  if (!hasSidecar) {
    push("entitlements", false, `sidecar がありません: ${sidecar}`);
  } else {
    const ent = exec(["codesign", "-d", "--entitlements", ":-", sidecar]);
    const missing = REQUIRED_ENTITLEMENTS.filter(
      (k) => !new RegExp(`<key>${k.replace(/\./g, "\\.")}</key>\\s*<true\\s*/>`).test(ent.stdout),
    );
    push(
      "entitlements",
      ent.code === 0 && missing.length === 0,
      missing.length === 0 && ent.code === 0 ? "必須 3 種が付いている" : `欠けている entitlements: ${missing.join(", ") || ent.stderr.trim()}`,
    );
  }

  // 3. arm64（sidecar とアプリ本体の両方が arm64 のみ）
  const bins = [sidecar, join(app, "Contents", "MacOS", "nod-desktop")];
  const archProblems: string[] = [];
  for (const bin of bins) {
    if (!existsSync(bin)) {
      archProblems.push(`${bin} がありません`);
      continue;
    }
    const a = exec(["lipo", "-archs", bin]);
    const archs = a.stdout.trim();
    if (a.code !== 0 || archs !== "arm64") archProblems.push(`${bin}: ${archs || a.stderr.trim()}`);
  }
  push("arch", archProblems.length === 0, archProblems.length === 0 ? "arm64 のみ" : archProblems.join("; "));

  // 4. build-info
  let info: BuildInfo | null = null;
  const infoPath = join(resources, "build-info");
  if (!existsSync(infoPath)) {
    push("build-info", false, `${infoPath} がありません`);
  } else {
    try {
      const j = JSON.parse(readFileSync(infoPath, "utf8")) as Partial<BuildInfo>;
      const valid =
        typeof j.version === "string" && j.version !== "" &&
        typeof j.commit === "string" && /^[0-9a-f]{40}$/.test(j.commit) &&
        typeof j.dirty === "boolean" &&
        typeof j.buildTime === "string" && !Number.isNaN(Date.parse(j.buildTime)) &&
        typeof j.schemaVersion === "number" && Number.isInteger(j.schemaVersion);
      if (valid) {
        info = j as BuildInfo;
        push("build-info", true, `version ${info.version} / commit ${info.commit.slice(0, 7)} / schema ${info.schemaVersion}`);
      } else {
        push("build-info", false, `build-info の項目が不足、または形式が不正です: ${JSON.stringify(j)}`);
      }
    } catch (e) {
      push("build-info", false, `build-info を JSON として読めません: ${e}`);
    }
  }

  const dir = mkdtempSync(join(tmpdir(), "nod-verify-"));
  try {
    // 5. 同梱バイナリの --version と build-info の版
    if (!hasSidecar || !info) {
      push("version", false, "sidecar か build-info が無いため比較できません");
    } else {
      const v = exec([sidecar, "--version"], isolatedEnv(dir));
      const got = v.stdout.trim();
      push("version", v.code === 0 && got === info.version, v.code === 0 && got === info.version
        ? `nod --version = build-info の version（${got}）`
        : `nod --version は「${got || v.stderr.trim()}」、build-info の version は「${info.version}」`);
    }

    // 6. 隔離データでの起動
    const webDir = join(resources, "web");
    if (!hasSidecar) {
      push("launch", false, "sidecar がありません");
    } else {
      checks.push(await launch(sidecar, webDir, dir));
    }

    // 7. 起動で作られた DB の schema 版と build-info
    const dbPath = join(dir, "nod.db");
    if (!info) {
      push("schema", false, "build-info が無いため比較できません");
    } else if (!existsSync(dbPath)) {
      push("schema", false, "起動で DB が作られませんでした");
    } else {
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db.query("PRAGMA user_version").get() as { user_version: number };
        push("schema", row.user_version === info.schemaVersion, row.user_version === info.schemaVersion
          ? `DB の schema 版 = build-info（${info.schemaVersion}）`
          : `DB の schema 版は ${row.user_version}、build-info は ${info.schemaVersion}`);
      } finally {
        db.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  return { ok: checks.every((c) => c.ok), checks };
}

export function formatResult(r: VerifyResult): string {
  return r.checks.map((c) => `  ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`).join("\n");
}

if (import.meta.main) {
  const target = process.argv[2];
  if (!target) {
    console.error("使い方: bun run packages/desktop/scripts/verify-app.ts <nod.app のパス>");
    process.exit(2);
  }
  const r = await verifyApp(target);
  console.log(formatResult(r));
  process.exit(r.ok ? 0 : 1);
}
