import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers";

// code-review の親が受け入れ確認の証拠（絶対パスの出典）を写すスクリプトを、プロセスとして起動する
const SCRIPT = join(import.meta.dir, "../../../plugins/nod/skills/code-review/scripts/copy-evidence.ts");
const ENV_MARK = "ENV-SECRET-MARK-7f3a";
const AWS_MARK = "AWS-SECRET-MARK-91bc";
const KEY_MARK = "KEY-SECRET-MARK-c04d";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// スクリプトが標準出力に出す結果（1行の JSON）
interface Result {
  ok: boolean;
  code: string;
  message?: string;
  source?: string;
  dest?: string;
  copy?: string;
  observation?: string;
  observationSha256?: string;
  secrets?: { path: string; match: string }[];
}

interface Run {
  exitCode: number | null;
  json: Result | undefined;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// 読むと止まる出典（FIFO など）で止まったままにならないよう、時間切れで止めて失敗として返す
async function run(args: string[]): Promise<Run> {
  const proc = Bun.spawn([process.execPath, SCRIPT, ...args], {
    cwd: tempDir("nod-copy-evidence-cwd-"),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10000,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  let json: Result | undefined;
  try {
    json = JSON.parse(stdout) as Result;
  } catch {
    json = undefined;
  }
  const timedOut = proc.signalCode === "SIGKILL";
  return { exitCode: timedOut ? null : exitCode, json, stdout, stderr, timedOut };
}

// 写し先の配下のすべてのファイル（リンクは辿らない）の本文
function filesUnder(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  const walk = (p: string) => {
    const st = lstatSync(p);
    if (st.isDirectory()) for (const name of readdirSync(p)) walk(join(p, name));
    else if (st.isFile()) out.set(p, readFileSync(p, "utf8"));
    else out.set(p, `<${st.isSymbolicLink() ? "symlink" : "special"}>`);
  };
  walk(dir);
  return out;
}

function expectNoSecretIn(dir: string) {
  for (const [path, body] of filesUnder(dir)) {
    for (const mark of [ENV_MARK, AWS_MARK, KEY_MARK]) expect({ path, leaked: body.includes(mark) }).toEqual({ path, leaked: false });
  }
}

// 秘密の本文を持つファイルと、秘密でない名前でそれを指すリンクを持つ配置
function layout() {
  const t = tempDir("nod-copy-evidence-");
  mkdirSync(join(t, "secret"));
  mkdirSync(join(t, "home/.aws"), { recursive: true });
  mkdirSync(join(t, "src/records"), { recursive: true });
  writeFileSync(join(t, "secret/.env"), `${ENV_MARK}\n`);
  writeFileSync(join(t, "home/.aws/credentials"), `${AWS_MARK}\n`);
  symlinkSync(join(t, "secret/.env"), join(t, "src/notes.txt"));
  symlinkSync(join(t, "home/.aws/credentials"), join(t, "src/run-log"));
  writeFileSync(join(t, "src/records/readme.txt"), "ok\n");
  symlinkSync(join(t, "secret/.env"), join(t, "src/records/deploy.txt"));
  symlinkSync(join(t, "home/.aws"), join(t, "src/records/cfg"));
  return t;
}

function expectUnobtainable(r: Run, dest: string, code: string) {
  expect(r.timedOut).toBe(false);
  expect(r.exitCode).toBe(1);
  expect(r.json?.ok).toBe(false);
  expect(r.json?.code).toBe(code);
  // 写しも観測も作らない（写し先のディレクトリも作らない）
  expect(existsSync(dest)).toBe(false);
}

describe("code-review の証拠の写し（copy-evidence）", () => {
  test("秘密候補でないディレクトリは、リンクを辿って中身を写し、種類・リンク先・各ファイルの sha256 を観測に書く", async () => {
    const t = tempDir("nod-copy-evidence-");
    const s = join(t, "src/records");
    mkdirSync(s, { recursive: true });
    mkdirSync(join(t, "builds"));
    mkdirSync(join(t, "shared"));
    writeFileSync(join(s, "readme.txt"), "ok\n");
    writeFileSync(join(t, "builds/v2.txt"), "v2\n");
    writeFileSync(join(t, "shared/a.txt"), "a\n");
    symlinkSync(join(t, "builds/v2.txt"), join(s, "latest"));
    symlinkSync(join(t, "shared"), join(s, "shared"));
    const d = join(t, "acceptance-input/evidence/1");

    const r = await run([s, d]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.json).toMatchObject({ ok: true, code: "COPIED", source: s, dest: d, copy: join(d, "copy"), observation: join(d, "observation.txt") });

    // 写しにリンクは残さず、辿った先の中身を写す
    expect(Object.fromEntries(filesUnder(join(d, "copy")))).toEqual({
      [join(d, "copy/latest")]: "v2\n",
      [join(d, "copy/readme.txt")]: "ok\n",
      [join(d, "copy/shared/a.txt")]: "a\n",
    });
    const observation = readFileSync(join(d, "observation.txt"), "utf8");
    expect(observation).toBe(
      [
        `dir\t${s}`,
        `link\t${s}/latest\t${t}/builds/v2.txt`,
        `file\t${s}/latest\t${sha256("v2\n")}`,
        `file\t${s}/readme.txt\t${sha256("ok\n")}`,
        `link\t${s}/shared\t${t}/shared`,
        `dir\t${s}/shared`,
        `file\t${s}/shared/a.txt\t${sha256("a\n")}`,
        "",
      ].join("\n"),
    );
    expect(r.json?.observationSha256).toBe(sha256(observation));

    // 10節3の取り直し: 同じ出典から同じスクリプトで取り直すと、変わっていなければ観測の指紋も同じ
    const again = await run([s, join(t, "parent/acceptance-recheck/evidence/1")]);
    expect(again.exitCode).toBe(0);
    expect(again.json?.observationSha256).toBe(r.json?.observationSha256);
  });

  test("秘密候補でない名前のリンクの出典は、辿った先のファイルを写す", async () => {
    const t = tempDir("nod-copy-evidence-");
    mkdirSync(join(t, "data"));
    writeFileSync(join(t, "data/plain.txt"), "plain\n");
    symlinkSync(join(t, "data/plain.txt"), join(t, "notes.txt"));
    const d = join(t, "evidence/1");

    const r = await run([join(t, "notes.txt"), d]);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(d, "copy"), "utf8")).toBe("plain\n");
    expect(lstatSync(join(d, "copy")).isFile()).toBe(true);
    expect(readFileSync(join(d, "observation.txt"), "utf8")).toBe(
      `link\t${t}/notes.txt\t${t}/data/plain.txt\nfile\t${t}/notes.txt\t${sha256("plain\n")}\n`,
    );
  });

  test("出典自身が秘密でない名前のリンクで、解決先が .env なら、本文を写さず取得不能とし当たったパスを返す", async () => {
    const t = layout();
    const d = join(t, "evidence/1");
    const r = await run([join(t, "src/notes.txt"), d]);
    expectUnobtainable(r, d, "SECRET_CANDIDATE");
    expect(r.json?.secrets).toEqual([{ path: join(t, "src/notes.txt"), match: join(t, "secret/.env") }]);
    expect(r.stdout).not.toContain(ENV_MARK);
    expectNoSecretIn(join(t, "evidence"));
  });

  test("出典自身のリンクの解決先が .aws/credentials でも取得不能にする", async () => {
    const t = layout();
    const d = join(t, "evidence/2");
    const r = await run([join(t, "src/run-log"), d]);
    expectUnobtainable(r, d, "SECRET_CANDIDATE");
    expect(r.json?.secrets).toEqual([{ path: join(t, "src/run-log"), match: join(t, "home/.aws/credentials") }]);
    expectNoSecretIn(join(t, "evidence"));
  });

  test("参照ディレクトリ配下のリンクが .env や .aws を指せば、ディレクトリ全体を写さず取得不能にする", async () => {
    const t = layout();
    const s = join(t, "src/records");
    const d = join(t, "evidence/3");
    const r = await run([s, d]);
    expectUnobtainable(r, d, "SECRET_CANDIDATE");
    expect(r.json?.secrets).toEqual([
      { path: join(s, "cfg"), match: join(t, "home/.aws") },
      { path: join(s, "deploy.txt"), match: join(t, "secret/.env") },
    ]);
    expectNoSecretIn(join(t, "evidence"));
  });

  test("リンクを辿った先のディレクトリ配下に秘密候補の名前があれば取得不能にする", async () => {
    const t = tempDir("nod-copy-evidence-");
    const s = join(t, "src");
    mkdirSync(s);
    mkdirSync(join(t, "shared"));
    writeFileSync(join(s, "readme.txt"), "ok\n");
    writeFileSync(join(t, "shared/deploy.pem"), `${KEY_MARK}\n`);
    symlinkSync(join(t, "shared"), join(s, "shared"));
    const d = join(t, "evidence/1");

    const r = await run([s, d]);
    expectUnobtainable(r, d, "SECRET_CANDIDATE");
    expect(r.json?.secrets).toEqual([{ path: join(s, "shared/deploy.pem"), match: join(s, "shared/deploy.pem") }]);
    expectNoSecretIn(join(t, "evidence"));
  });

  test("リンクの途中のパスが秘密候補（.env というリンクが通常のファイルを指す）でも取得不能にする", async () => {
    const t = tempDir("nod-copy-evidence-");
    mkdirSync(join(t, "a"));
    mkdirSync(join(t, "b"));
    writeFileSync(join(t, "b/plain.txt"), `${ENV_MARK}\n`);
    symlinkSync(join(t, "b/plain.txt"), join(t, "a/.env"));
    symlinkSync(join(t, "a/.env"), join(t, "notes.txt"));
    const d = join(t, "evidence/1");

    const r = await run([join(t, "notes.txt"), d]);
    expectUnobtainable(r, d, "SECRET_CANDIDATE");
    expect(r.json?.secrets).toEqual([{ path: join(t, "notes.txt"), match: join(t, "a/.env") }]);
    expectNoSecretIn(join(t, "evidence"));
  });

  test("出典の名前自体が秘密候補（大文字小文字を区別しない）なら取得不能にする", async () => {
    const t = tempDir("nod-copy-evidence-");
    writeFileSync(join(t, "Credentials.json"), `${AWS_MARK}\n`);
    const d = join(t, "evidence/1");
    const r = await run([join(t, "Credentials.json"), d]);
    expectUnobtainable(r, d, "SECRET_CANDIDATE");
    expect(r.json?.secrets).toEqual([{ path: join(t, "Credentials.json"), match: join(t, "Credentials.json") }]);
  });

  test("保存直前の取り直しで出典が秘密候補を指すようになったら、取り直せず（取得不能）になる", async () => {
    const t = layout();
    mkdirSync(join(t, "data"));
    writeFileSync(join(t, "data/plain.txt"), "plain\n");
    const link = join(t, "src/latest");
    symlinkSync(join(t, "data/plain.txt"), link);
    const first = await run([link, join(t, "acceptance-input/evidence/1")]);
    expect(first.exitCode).toBe(0);

    rmSync(link);
    symlinkSync(join(t, "secret/.env"), link);
    const d = join(t, "parent/acceptance-recheck/evidence/1");
    const r = await run([link, d]);
    expectUnobtainable(r, d, "SECRET_CANDIDATE");
    expect(r.json?.secrets).toEqual([{ path: link, match: join(t, "secret/.env") }]);
    expectNoSecretIn(join(t, "parent"));
  });

  test("リンクの循環は読み取りの失敗として取得不能にする", async () => {
    const t = tempDir("nod-copy-evidence-");
    const s = join(t, "loop");
    mkdirSync(s);
    writeFileSync(join(s, "a.txt"), "a\n");
    symlinkSync(s, join(s, "self"));
    const d = join(t, "evidence/1");
    const r = await run([s, d]);
    expectUnobtainable(r, d, "READ_FAILED");
    expect(r.json?.message).toContain(join(s, "self"));
  });

  test("壊れたリンクは読み取りの失敗として取得不能にする", async () => {
    const t = tempDir("nod-copy-evidence-");
    const s = join(t, "src");
    mkdirSync(s);
    writeFileSync(join(s, "a.txt"), "a\n");
    symlinkSync(join(t, "missing"), join(s, "gone"));
    const d = join(t, "evidence/1");
    const r = await run([s, d]);
    expectUnobtainable(r, d, "READ_FAILED");
    expect(r.json?.message).toContain(join(s, "gone"));
  });

  test("通常ファイルとディレクトリ以外（FIFO）は読まずに取得不能にする", async () => {
    const t = tempDir("nod-copy-evidence-");
    const s = join(t, "src");
    mkdirSync(s);
    writeFileSync(join(s, "a.txt"), "a\n");
    expect(spawnSync("mkfifo", [join(s, "pipe")]).status).toBe(0);
    const d = join(t, "evidence/1");
    const r = await run([s, d]);
    expectUnobtainable(r, d, "READ_FAILED");
    expect(r.json?.message).toContain(join(s, "pipe"));
  });

  test("存在しない出典は取得不能（NOT_FOUND）にする", async () => {
    const t = tempDir("nod-copy-evidence-");
    const d = join(t, "evidence/1");
    const r = await run([join(t, "nothing.txt"), d]);
    expectUnobtainable(r, d, "NOT_FOUND");
  });

  test("引数の誤り（相対パス、写し先に既に写しがある）は取得不能と区別して終了コード 2 で返す", async () => {
    const t = tempDir("nod-copy-evidence-");
    writeFileSync(join(t, "a.txt"), "a\n");
    const relative = await run(["a.txt", join(t, "evidence/1")]);
    expect(relative.exitCode).toBe(2);
    expect(relative.json?.code).toBe("INVALID_INPUT");

    const d = join(t, "evidence/2");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "observation.txt"), "previous\n");
    const used = await run([join(t, "a.txt"), d]);
    expect(used.exitCode).toBe(2);
    expect(used.json?.code).toBe("INVALID_INPUT");
    expect(readFileSync(join(d, "observation.txt"), "utf8")).toBe("previous\n");
  });
});
