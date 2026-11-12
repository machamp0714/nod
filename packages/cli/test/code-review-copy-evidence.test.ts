import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "./helpers";

// code-review の親が受け入れ確認の証拠（絶対パスの出典）を写すスクリプトを、プロセスとして起動する
const SCRIPT = join(import.meta.dir, "../../../plugins/nod/skills/code-review/scripts/copy-evidence.ts");
// 取得不能の出典の本文に置く目印。結果の JSON・写し先に出れば本文を読んだことになる
const MARK = "BODY-MARK-5e1d";
// 写せる上限のバイト数（parent.md の URL の行の --max-filesize と同じ）
const LIMIT = 20_000_000;

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

// スクリプトが標準出力に出す結果（1行の JSON）
interface Result {
  ok: boolean;
  code: string;
  message?: string;
  source?: string;
  dest?: string;
  copy?: string | null;
  observation?: string | null;
  observationSha256?: string | null;
  secrets?: { path: string; match: string }[];
}

interface Run {
  exitCode: number | null;
  json: Result | undefined;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// HOME を一時ディレクトリに向けて起動する（禁止領域はスクリプトが HOME から決める）。
// 読むと止まる出典（FIFO など）で止まったままにならないよう、時間切れで止めて失敗として返す
async function run(args: string[], home: string): Promise<Run> {
  const proc = Bun.spawn([process.execPath, SCRIPT, ...args], {
    cwd: tempDir("nod-copy-evidence-cwd-"),
    env: { ...process.env, HOME: home },
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

// 一時ディレクトリ t と、その中のホーム（HOME に渡す）
function setup() {
  const t = tempDir("nod-copy-evidence-");
  const home = join(t, "home");
  mkdirSync(home);
  return { t, home };
}

function put(path: string, body: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

// 写し先の配下のすべてのファイル（リンクは辿らない）
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const walk = (p: string) => {
    const st = lstatSync(p);
    if (st.isDirectory()) for (const name of readdirSync(p)) walk(join(p, name));
    else out.push(p);
  };
  walk(dir);
  return out;
}

// 取得不能: 終了コード 1、写し先に何も作らない（写しも観測も無い）、理由の code と message、本文を出さない
function expectUnobtainable(r: Run, dest: string, code: string) {
  expect(r.timedOut).toBe(false);
  expect({ exitCode: r.exitCode, ok: r.json?.ok, code: r.json?.code }).toEqual({ exitCode: 1, ok: false, code });
  expect(typeof r.json?.message).toBe("string");
  expect(r.json?.message?.length).toBeGreaterThan(0);
  expect({ copy: r.json?.copy, observation: r.json?.observation, observationSha256: r.json?.observationSha256 }).toEqual({
    copy: null,
    observation: null,
    observationSha256: null,
  });
  expect(existsSync(dest)).toBe(false);
  expect(filesUnder(dirname(dest))).toEqual([]);
  expect(r.stdout).not.toContain(MARK);
  expect(r.stderr).not.toContain(MARK);
}

describe("code-review の証拠の写し（copy-evidence）", () => {
  test("明示された通常のファイルを1つ写し、パス・バイト数・sha256 の1行を観測に書く", async () => {
    const { t, home } = setup();
    const s = join(t, "deploy/current/app.txt");
    put(s, "v2\n");
    const d = join(t, "acceptance-input/evidence/1");

    const r = await run([s, d], home);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.json).toMatchObject({ ok: true, code: "COPIED", source: s, dest: d, secrets: [], copy: join(d, "copy"), observation: join(d, "observation.txt") });
    expect(filesUnder(d).sort()).toEqual([join(d, "copy"), join(d, "observation.txt")]);
    expect(readFileSync(join(d, "copy"), "utf8")).toBe("v2\n");
    const observation = readFileSync(join(d, "observation.txt"), "utf8");
    expect(observation).toBe(`file\t${s}\t3\t${sha256("v2\n")}\n`);
    expect(r.json?.observationSha256).toBe(sha256(observation));

    // 10節3の取り直し: 同じ出典から同じスクリプトで取り直すと、変わっていなければ観測の指紋も同じ
    const again = await run([s, join(t, "parent/acceptance-recheck/evidence/1")], home);
    expect(again.exitCode).toBe(0);
    expect(again.json?.observationSha256).toBe(r.json?.observationSha256);
  });

  test("~ で始まる出典はホームへ展開して写す", async () => {
    const { t, home } = setup();
    put(join(home, "notes/plain.txt"), "plain\n");
    const d = join(t, "evidence/1");
    const r = await run(["~/notes/plain.txt", d], home);
    expect(r.exitCode).toBe(0);
    expect(r.json?.source).toBe(join(home, "notes/plain.txt"));
    expect(readFileSync(join(d, "copy"), "utf8")).toBe("plain\n");
  });

  test("パスの途中の要素がシンボリックリンクなら、辿らずに取得不能（SYMLINK_IN_PATH）にする", async () => {
    const { t, home } = setup();
    put(join(t, "real/plain.txt"), `${MARK}\n`);
    symlinkSync(join(t, "real"), join(t, "linkdir"));
    const d = join(t, "evidence/1");
    const r = await run([join(t, "linkdir/plain.txt"), d], home);
    expectUnobtainable(r, d, "SYMLINK_IN_PATH");
    expect(r.json?.message).toContain(join(t, "linkdir"));
  });

  test("出典そのものが秘密でない名前のシンボリックリンクなら、指す先が通常のファイルでも取得不能にする", async () => {
    const { t, home } = setup();
    put(join(t, "data/plain.txt"), `${MARK}\n`);
    symlinkSync(join(t, "data/plain.txt"), join(t, "notes.txt"));
    const d = join(t, "evidence/1");
    const r = await run([join(t, "notes.txt"), d], home);
    expectUnobtainable(r, d, "SYMLINK_IN_PATH");
    expect(r.json?.message).toContain(join(t, "notes.txt"));
  });

  test("秘密でない名前のリンクが .env を指していても、リンクを辿らずに取得不能にする", async () => {
    const { t, home } = setup();
    put(join(t, "secret/.env"), `${MARK}\n`);
    symlinkSync(join(t, "secret/.env"), join(t, "run-log"));
    const d = join(t, "evidence/1");
    const r = await run([join(t, "run-log"), d], home);
    expectUnobtainable(r, d, "SYMLINK_IN_PATH");
  });

  test("ディレクトリは写さず、ディレクトリであることを理由に取得不能（NOT_REGULAR_FILE）にする", async () => {
    const { t, home } = setup();
    put(join(t, "records/readme.txt"), `${MARK}\n`);
    const d = join(t, "evidence/1");
    const r = await run([join(t, "records"), d], home);
    expectUnobtainable(r, d, "NOT_REGULAR_FILE");
    expect(r.json?.message).toContain("ディレクトリ");
  });

  test("上限サイズを超える通常のファイルは読まずに取得不能（TOO_LARGE）にし、ちょうど上限なら写す", async () => {
    const { t, home } = setup();
    const big = join(t, "big.log");
    put(big, `${MARK}\n`);
    truncateSync(big, LIMIT + 1);
    const d = join(t, "evidence/1");
    const r = await run([big, d], home);
    expectUnobtainable(r, d, "TOO_LARGE");
    expect(r.json?.message).toContain(String(LIMIT));

    const edge = join(t, "edge.log");
    put(edge, "edge\n");
    truncateSync(edge, LIMIT);
    const e = join(t, "evidence/2");
    const ok = await run([edge, e], home);
    expect(ok.exitCode).toBe(0);
    expect(lstatSync(join(e, "copy")).size).toBe(LIMIT);
    expect(readFileSync(join(e, "observation.txt"), "utf8")).toBe(`file\t${edge}\t${LIMIT}\t${sha256(readFileSync(edge))}\n`);
  });

  test("過去のレビューの作業ディレクトリ・現在の作業ディレクトリ・親専用領域の配下は取得不能（FORBIDDEN_AREA）にする", async () => {
    const { t, home } = setup();
    const reviews = join(home, ".local/share/nod/code-reviews");
    const sources = [
      join(reviews, "old-run/refute/verdict.md"),
      join(reviews, "current-run/input/target.md"),
      join(reviews, "current-run/parent/acceptance/fingerprints.md"),
    ];
    for (const s of sources) put(s, `${MARK}\n`);
    for (const [i, s] of sources.entries()) {
      const d = join(t, `evidence/${i + 1}`);
      expectUnobtainable(await run([s, d], home), d, "FORBIDDEN_AREA");
    }
    // 大文字小文字を区別しないファイルシステムで、名前の大文字小文字を変えても逃れない
    const d = join(t, "evidence/9");
    expectUnobtainable(await run([join(home, ".local/share/nod/Code-Reviews/old-run/refute/verdict.md"), d], home), d, "FORBIDDEN_AREA");
  });

  test("ホームがリンクでも、ホームの実体のパスで書かれた作業ディレクトリの配下は取得不能（FORBIDDEN_AREA）にする", async () => {
    const { t, home } = setup();
    const linkedHome = join(t, "home-link");
    symlinkSync(home, linkedHome);
    const s = join(home, ".local/share/nod/code-reviews/old-run/refute/verdict.md");
    put(s, `${MARK}\n`);
    const d = join(t, "evidence/1");
    expectUnobtainable(await run([s, d], linkedHome), d, "FORBIDDEN_AREA");
  });

  test("常設データセット（評価用ディレクトリ）の配下は取得不能（FORBIDDEN_AREA）にする", async () => {
    const { t, home } = setup();
    const s = join(home, ".local/share/nod/review-evaluation/inputs/case-1/evidence/deploy.txt");
    put(s, `${MARK}\n`);
    const d = join(t, "evidence/1");
    expectUnobtainable(await run([s, d], home), d, "FORBIDDEN_AREA");
    const o = join(home, ".local/share/nod/review-evaluation/oracle/case-1.md");
    put(o, `${MARK}\n`);
    const e = join(t, "evidence/2");
    expectUnobtainable(await run(["~/.local/share/nod/review-evaluation/oracle/case-1.md", e], home), e, "FORBIDDEN_AREA");
  });

  test("パスのどこかの要素が秘密候補の名前（大文字小文字を区別しない）なら取得不能（SECRET_CANDIDATE）にする", async () => {
    const { t, home } = setup();
    const sources = [join(t, "secret/.env"), join(t, "home2/.aws/config"), join(t, "Credentials.json"), join(t, "keys/deploy.pem")];
    for (const s of sources) put(s, `${MARK}\n`);
    for (const [i, s] of sources.entries()) {
      const d = join(t, `evidence/${i + 1}`);
      const r = await run([s, d], home);
      expectUnobtainable(r, d, "SECRET_CANDIDATE");
      expect(r.json?.secrets).toEqual([{ path: s, match: s }]);
    }
  });

  test(". や .. や空の要素を含むパスは、書かれたパスと読むパスがずれ得るので取得不能（NON_CANONICAL_PATH）にする", async () => {
    const { t, home } = setup();
    put(join(t, "data/plain.txt"), `${MARK}\n`);
    const sources = [`${t}/data/../data/plain.txt`, `${t}/data/./plain.txt`, `${t}/data//plain.txt`];
    for (const [i, s] of sources.entries()) {
      const d = join(t, `evidence/${i + 1}`);
      expectUnobtainable(await run([s, d], home), d, "NON_CANONICAL_PATH");
    }
  });

  test("FIFO など通常ファイル以外は止まらずに取得不能（NOT_REGULAR_FILE）にする", async () => {
    const { t, home } = setup();
    expect(spawnSync("mkfifo", [join(t, "pipe")]).status).toBe(0);
    const d = join(t, "evidence/1");
    expectUnobtainable(await run([join(t, "pipe"), d], home), d, "NOT_REGULAR_FILE");
  });

  test("存在しない出典は取得不能（NOT_FOUND）にする", async () => {
    const { t, home } = setup();
    const d = join(t, "evidence/1");
    expectUnobtainable(await run([join(t, "nothing.txt"), d], home), d, "NOT_FOUND");
  });

  test("保存直前の取り直しで出典がリンクに置き換わっていたら、取り直せず（取得不能）になる", async () => {
    const { t, home } = setup();
    const s = join(t, "deploy/current.txt");
    put(s, "v1\n");
    const first = await run([s, join(t, "acceptance-input/evidence/1")], home);
    expect(first.exitCode).toBe(0);

    rmSync(s);
    put(join(t, "other/v2.txt"), `${MARK}\n`);
    symlinkSync(join(t, "other/v2.txt"), s);
    const d = join(t, "parent/acceptance-recheck/evidence/1");
    expectUnobtainable(await run([s, d], home), d, "SYMLINK_IN_PATH");
  });

  test("引数の誤り（相対パス、写し先に既に写しがある）は取得不能と区別して終了コード 2 で返す", async () => {
    const { t, home } = setup();
    put(join(t, "a.txt"), "a\n");
    const relative = await run(["a.txt", join(t, "evidence/1")], home);
    expect(relative.exitCode).toBe(2);
    expect(relative.json?.code).toBe("INVALID_INPUT");

    const d = join(t, "evidence/2");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "observation.txt"), "previous\n");
    const used = await run([join(t, "a.txt"), d], home);
    expect(used.exitCode).toBe(2);
    expect(used.json?.code).toBe("INVALID_INPUT");
    expect(readFileSync(join(d, "observation.txt"), "utf8")).toBe("previous\n");
  });
});
